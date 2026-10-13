import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type CanonicalDirectory = "registry" | "memory" | "events";
export type RevisionMutation = { directory: CanonicalDirectory; filename: string; content: string };
export type RevisionPointer = { knowledge_revision: string; topology_revision: string; index_revision: string; manifest_hash: string };
export type RevisionStoreLimits = { maxRecords: number; maxSnapshotEntries: number; maxRetainedContentBytes: number; maxMutations: number; maxMutationBytes: number };
export const DEFAULT_REVISION_STORE_LIMITS: RevisionStoreLimits = { maxRecords: 10_000, maxSnapshotEntries: 1_000_000, maxRetainedContentBytes: 2 * 1024 ** 3, maxMutations: 1000, maxMutationBytes: 16 * 1024 ** 2 };
const LIMIT_CEILINGS: RevisionStoreLimits = { maxRecords: 1_000_000, maxSnapshotEntries: 100_000_000, maxRetainedContentBytes: 1024 ** 4, maxMutations: 100_000, maxMutationBytes: 1024 ** 3 };
type StorageUsage = { record_count: number; revision_count: number; retained_snapshot_entries: number; retained_content_bytes: number };

type RevisionManifest = {
  schema: "argon-memory-revision-manifest/v1";
  revision: string;
  parent_revision: string | null;
  changed_records: string[];
  topology_revision: string;
  index_revision: string;
  created_at: string;
  manifest_hash?: string;
  storage_usage?: StorageUsage;
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

  readonly limits: Readonly<RevisionStoreLimits>;
  constructor(root: string, limits: Partial<RevisionStoreLimits> = {}) {
    this.root = root;
    const effective = { ...DEFAULT_REVISION_STORE_LIMITS, ...limits };
    for (const key of Object.keys(effective) as Array<keyof RevisionStoreLimits>) if (!Number.isSafeInteger(effective[key]) || effective[key] < 1 || effective[key] > LIMIT_CEILINGS[key]) throw new Error(`Invalid canonical storage limit: ${key}`);
    this.limits = Object.freeze(effective);
  }

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

  async publish(mutations: RevisionMutation[], options: { expectedParent?: string | null } = {}): Promise<RevisionPointer> {
    // Capture caller-owned objects before waiting for another writer.
    const captured = mutations.map(mutation => ({ ...mutation })), expected = { ...options };
    const run = this.queue.then(() => this.withWriteLock(() => this.publishUnlocked(captured, expected)));
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

  private async canonicalFiles(base: string): Promise<Array<{ directory: CanonicalDirectory; filename: string; path: string }>> {
    const files: Array<{ directory: CanonicalDirectory; filename: string; path: string }> = [];
    for (const directory of ["registry", "memory", "events"] as const) {
      const source = join(base, directory);
      if (!await exists(source)) continue;
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (!entry.name.endsWith(".md")) continue;
        if (!entry.isFile()) throw new Error("Canonical history must contain regular record files");
        files.push({ directory, filename: entry.name, path: join(source, entry.name) });
      }
    }
    return files;
  }

  private async retainedUsage(previous: RevisionPointer | null): Promise<StorageUsage> {
    const revisionRoot = join(this.knowledgeRoot(), "revisions");
    const revisions = (await readdir(revisionRoot, { withFileTypes: true })).filter(entry => entry.isDirectory());
    if (previous) {
      const manifest = JSON.parse(await readFile(join(revisionRoot, previous.knowledge_revision, "manifest.json"), "utf8")) as RevisionManifest;
      const usage = manifest.storage_usage;
      if (usage && [usage.record_count, usage.revision_count, usage.retained_snapshot_entries, usage.retained_content_bytes].every(value => Number.isSafeInteger(value) && value >= 0) && usage.revision_count === revisions.length) return usage;
    }
    // Upgrade old manifests without rewriting history. Count inode identity so
    // old copied snapshots and new shared files both consume their true bytes.
    const inodes = new Set<string>();
    const usage: StorageUsage = { record_count: 0, revision_count: revisions.length, retained_snapshot_entries: 0, retained_content_bytes: 0 };
    for (const revision of revisions) {
      const files = await this.canonicalFiles(join(revisionRoot, revision.name, "canonical"));
      usage.retained_snapshot_entries += files.length + 6; // revision/canonical directories, three record directories, manifest
      if (revision.name === previous?.knowledge_revision) usage.record_count = files.length;
      for (const file of files) {
        const info = await stat(file.path), inode = `${info.dev}:${info.ino}`;
        if (!inodes.has(inode)) { inodes.add(inode); usage.retained_content_bytes += info.size; }
      }
    }
    return usage;
  }

  private async publishUnlocked(mutations: RevisionMutation[], options: { expectedParent?: string | null }): Promise<RevisionPointer> {
    await this.initialize();
    if (mutations.length === 0) throw new Error("A canonical revision requires at least one mutation");
    const previous = await this.pointer();
    if (Object.hasOwn(options, "expectedParent") && options.expectedParent !== (previous?.knowledge_revision ?? null)) throw new Error("Canonical publication base revision is stale");
    if (mutations.length > this.limits.maxMutations) throw new Error("Canonical mutation count quota exceeded");
    const mutationKeys = new Set<string>();
    let mutationBytes = 0;
    for (const mutation of mutations) {
      if (!["registry", "memory", "events"].includes(mutation.directory) || mutation.filename.length > 255 || !/^[A-Za-z0-9._-]+\.md$/.test(mutation.filename)) throw new Error("Unsafe canonical mutation filename");
      const key = `${mutation.directory}/${mutation.filename}`;
      if (mutationKeys.has(key)) throw new Error("Duplicate canonical mutation target");
      mutationKeys.add(key); mutationBytes += Buffer.byteLength(mutation.content);
    }
    if (mutationBytes > this.limits.maxMutationBytes) throw new Error("Canonical mutation bytes quota exceeded");
    const sourceBase = previous ? join(this.knowledgeRoot(), "revisions", previous.knowledge_revision, "canonical") : this.root;
    const sourceFiles = await this.canonicalFiles(sourceBase);
    const unchanged = sourceFiles.filter(file => !mutationKeys.has(`${file.directory}/${file.filename}`));
    const retained = await this.retainedUsage(previous);
    let additionalBytes = mutationBytes;
    // The mutable legacy root is copied once; only committed snapshots can be linked.
    if (!previous) for (const file of unchanged) additionalBytes += (await stat(file.path)).size;
    const usage: StorageUsage = { record_count: unchanged.length + mutations.length, revision_count: retained.revision_count + 1,
      retained_snapshot_entries: retained.retained_snapshot_entries + unchanged.length + mutations.length + 6,
      retained_content_bytes: retained.retained_content_bytes + additionalBytes };
    if (usage.record_count > this.limits.maxRecords || usage.retained_snapshot_entries > this.limits.maxSnapshotEntries || usage.retained_content_bytes > this.limits.maxRetainedContentBytes) throw new Error("Canonical retained storage quota exceeded; administrator expansion or migration is required");
    const staging = join(this.knowledgeRoot(), "staging", randomUUID());
    const canonical = join(staging, "canonical");
    let publishedDirectory: string | undefined, committed = false;
    try {
      for (const directory of ["registry", "memory", "events"] as const) await mkdir(join(canonical, directory), { recursive: true });
      for (const file of unchanged) {
        const target = join(canonical, file.directory, file.filename);
        if (previous) await link(file.path, target);
        else { await copyFile(file.path, target); await fsyncFile(target); }
      }
      for (const mutation of mutations) {
        const target = join(canonical, mutation.directory, mutation.filename);
        // Changed paths were deliberately not linked. Never overwrite an inode
        // shared with an immutable historical revision.
        await writeFile(target, mutation.content, { encoding: "utf8", flag: "wx" });
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
        storage_usage: usage,
      };
      const manifestHash = hash(stableJson(manifest));
      const published = { ...manifest, manifest_hash: manifestHash };
      await writeFile(join(staging, "manifest.json"), `${stableJson(published)}\n`, "utf8");
      await fsyncFile(join(staging, "manifest.json"));
      for (const directory of ["registry", "memory", "events"]) await fsyncDirectory(join(canonical, directory));
      await fsyncDirectory(canonical);
      const revisionDir = join(this.knowledgeRoot(), "revisions", revision);
      await rename(staging, revisionDir);
      publishedDirectory = revisionDir;
      await fsyncDirectory(join(this.knowledgeRoot(), "revisions"));
      const pointer: RevisionPointer = { knowledge_revision: revision, topology_revision: topologyRevision, index_revision: indexRevision, manifest_hash: manifestHash };
      const pointerTemp = `${this.pointerPath()}.${randomUUID()}.tmp`;
      await writeFile(pointerTemp, `${stableJson(pointer)}\n`, "utf8");
      await fsyncFile(pointerTemp);
      await rename(pointerTemp, this.pointerPath());
      committed = true;
      await fsyncDirectory(dirname(this.pointerPath()));
      return pointer;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (publishedDirectory && !committed) await rm(publishedDirectory, { recursive: true, force: true });
      throw error;
    }
  }
}
