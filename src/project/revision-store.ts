import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type CanonicalDirectory = "registry" | "memory" | "events";
export type RevisionMutation = { directory: CanonicalDirectory; filename: string; content: string };
export type RevisionPointer = { knowledge_revision: string; topology_revision: string; index_revision: string; manifest_hash: string };

type RevisionManifest = {
  schema: "argon-memory-revision-manifest/v1";
  revision: string;
  parent_revision: string | null;
  changed_records: string[];
  topology_revision: string;
  index_revision: string;
  created_at: string;
  manifest_hash?: string;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
async function fsyncFile(path: string): Promise<void> { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }
async function fsyncDirectory(path: string): Promise<void> { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }

export class CanonicalRevisionStore {
  readonly root: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(root: string) { this.root = root; }

  private knowledgeRoot(): string { return join(this.root, "knowledge"); }
  private pointerPath(): string { return join(this.knowledgeRoot(), "current-revision.json"); }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(join(this.knowledgeRoot(), "revisions"), { recursive: true }),
      mkdir(join(this.knowledgeRoot(), "staging"), { recursive: true }),
      mkdir(join(this.knowledgeRoot(), "indexes"), { recursive: true }),
    ]);
  }

  async pointer(): Promise<RevisionPointer | null> {
    try {
      const parsed = JSON.parse(await readFile(this.pointerPath(), "utf8")) as RevisionPointer;
      if (!parsed.knowledge_revision || !parsed.manifest_hash) throw new Error("Invalid revision pointer");
      const manifestText = await readFile(join(this.knowledgeRoot(), "revisions", parsed.knowledge_revision, "manifest.json"), "utf8");
      const manifest = JSON.parse(manifestText) as RevisionManifest;
      const withoutHash = { ...manifest }; delete withoutHash.manifest_hash;
      if (hash(stableJson(withoutHash)) !== parsed.manifest_hash || manifest.manifest_hash !== parsed.manifest_hash) throw new Error("Revision manifest hash mismatch");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async activeDirectory(directory: CanonicalDirectory): Promise<string> {
    const pointer = await this.pointer();
    return pointer ? join(this.knowledgeRoot(), "revisions", pointer.knowledge_revision, "canonical", directory) : join(this.root, directory);
  }

  async publish(mutations: RevisionMutation[]): Promise<RevisionPointer> {
    const run = this.queue.then(() => this.withWriteLock(() => this.publishUnlocked(mutations)));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    const lock = join(this.knowledgeRoot(), ".write-lock");
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        await mkdir(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const info = await stat(lock);
          if (Date.now() - info.mtimeMs > 5 * 60_000) { await rm(lock, { recursive: true, force: true }); continue; }
        } catch { continue; }
        if (Date.now() >= deadline) throw new Error("Timed out acquiring canonical single-writer lock");
        await delay(50);
      }
    }
    try { return await operation(); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }

  private async publishUnlocked(mutations: RevisionMutation[]): Promise<RevisionPointer> {
    await this.initialize();
    if (mutations.length === 0) throw new Error("A canonical revision requires at least one mutation");
    const previous = await this.pointer();
    const staging = join(this.knowledgeRoot(), "staging", randomUUID());
    const canonical = join(staging, "canonical");
    await mkdir(canonical, { recursive: true });
    for (const directory of ["registry", "memory", "events"] as const) {
      const source = previous
        ? join(this.knowledgeRoot(), "revisions", previous.knowledge_revision, "canonical", directory)
        : join(this.root, directory);
      const target = join(canonical, directory);
      if (await exists(source)) await cp(source, target, { recursive: true, force: false });
      else await mkdir(target, { recursive: true });
    }
    try {
      for (const mutation of mutations) {
        if (!/^[A-Za-z0-9._-]+\.md$/.test(mutation.filename)) throw new Error("Unsafe canonical mutation filename");
        const target = join(canonical, mutation.directory, mutation.filename);
        await writeFile(target, mutation.content, "utf8");
        await fsyncFile(target);
      }
      const contentHashes: string[] = [];
      for (const mutation of mutations) contentHashes.push(hash(mutation.content));
      const revision = hash(stableJson({ parent: previous?.knowledge_revision ?? null, mutations: mutations.map((item, index) => [item.directory, item.filename, contentHashes[index]]) }));
      const topologyRevision = hash(stableJson({ revision, graph_fields: "v0.5" }));
      const indexRevision = previous?.index_revision ?? "unbuilt";
      const manifest: RevisionManifest = {
        schema: "argon-memory-revision-manifest/v1", revision, parent_revision: previous?.knowledge_revision ?? null,
        changed_records: mutations.map(item => `${item.directory}/${item.filename}`), topology_revision: topologyRevision,
        index_revision: indexRevision, created_at: new Date().toISOString(),
      };
      const manifestHash = hash(stableJson(manifest));
      const published = { ...manifest, manifest_hash: manifestHash };
      await writeFile(join(staging, "manifest.json"), `${stableJson(published)}\n`, "utf8");
      await fsyncFile(join(staging, "manifest.json"));
      await fsyncDirectory(canonical);
      const revisionDir = join(this.knowledgeRoot(), "revisions", revision);
      await rename(staging, revisionDir);
      await fsyncDirectory(join(this.knowledgeRoot(), "revisions"));
      const pointer: RevisionPointer = { knowledge_revision: revision, topology_revision: topologyRevision, index_revision: indexRevision, manifest_hash: manifestHash };
      const pointerTemp = `${this.pointerPath()}.${randomUUID()}.tmp`;
      await writeFile(pointerTemp, `${stableJson(pointer)}\n`, "utf8");
      await fsyncFile(pointerTemp);
      await rename(pointerTemp, this.pointerPath());
      await fsyncDirectory(dirname(this.pointerPath()));
      return pointer;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
}
