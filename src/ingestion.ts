/** Safe, local-only source inventory for future MinerU-derived ingestion. */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import YAML from "yaml";

export type SourceRoot = { id: string; project_id: string; relative_path: string; enabled?: boolean };
export type InventoryEntry = { relative_path: string; size_bytes: number; sha256: string; modified_at: string; mime_type: string };

const MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown", ".txt": "text/plain", ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
};

function mimeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function safeRoot(projectRoot: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath)) throw new Error("Source roots must be non-empty paths relative to ARGON_MEMORY_KB_ROOT");
  const resolved = resolve(projectRoot, relativePath);
  if (relative(projectRoot, resolved).startsWith("..")) throw new Error("Source root escapes ARGON_MEMORY_KB_ROOT");
  return resolved;
}

export function sourceFilePath(projectRoot: string, sourceRoot: SourceRoot, relativePath: string): string {
  const root = safeRoot(projectRoot, sourceRoot.relative_path);
  if (!relativePath || isAbsolute(relativePath)) throw new Error("Artifact paths must be non-empty paths relative to their configured source root");
  const resolved = resolve(root, relativePath);
  if (relative(root, resolved).startsWith("..")) throw new Error("Artifact path escapes its configured source root");
  return resolved;
}

export function parseSourceRoots(text: string): SourceRoot[] {
  const parsed = YAML.parse(text) as unknown;
  const roots = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { source_roots?: unknown }).source_roots : undefined;
  if (!Array.isArray(roots)) throw new Error("ingestion/source-roots.yaml must contain source_roots");
  return roots.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid source root at index ${index}`);
    const root = value as Partial<SourceRoot>;
    if (!root.id || !root.project_id || !root.relative_path) throw new Error(`Source root at index ${index} requires id, project_id, relative_path`);
    return { id: root.id, project_id: root.project_id, relative_path: root.relative_path, enabled: root.enabled !== false };
  });
}

export async function inventorySourceRoot(projectRoot: string, sourceRoot: SourceRoot): Promise<InventoryEntry[]> {
  const root = safeRoot(projectRoot, sourceRoot.relative_path);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Source root must be a real directory: ${sourceRoot.id}`);
  const entries: InventoryEntry[] = [];
  async function walk(folder: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name === ".DS_Store" || entry.name.startsWith(".")) continue;
      const fullPath = join(folder, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(fullPath); continue; }
      if (!entry.isFile()) continue;
      const stat = await lstat(fullPath);
      entries.push({ relative_path: relative(root, fullPath), size_bytes: stat.size, sha256: await sha256(fullPath), modified_at: stat.mtime.toISOString(), mime_type: mimeFor(fullPath) });
    }
  }
  await walk(root);
  return entries.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
}
