import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type EvidencePreview = { data: string; mimeType: "image/jpeg" };
const MAX_INPUT = 10 * 1024 * 1024;
const MAX_OUTPUT = 256 * 1024;
const TIMEOUT_MS = 10_000;
const MEMORY_BUDGET = 4 * 1024 * 1024;
const memory = new Map<string, EvidencePreview>();
const pending = new Map<string, Promise<EvidencePreview>>();
let memoryBytes = 0;

function remember(key: string, value: EvidencePreview): void {
  memoryBytes -= memory.get(key)?.data.length ?? 0;
  memory.delete(key); memory.set(key, value); memoryBytes += value.data.length;
  while (memoryBytes > MEMORY_BUDGET || memory.size > 64) {
    const oldest = memory.keys().next().value!;
    memoryBytes -= memory.get(oldest)!.data.length; memory.delete(oldest);
  }
}

/** Check the bounded JPEG's encoded dimensions without decoding pixels again. */
function validJpeg(bytes: Buffer): boolean {
  if (bytes.length < 8 || bytes.length > MAX_OUTPUT || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return false;
  for (let offset = 2; offset + 3 < bytes.length;) {
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) return false;
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 && Math.max(width, height) <= 720;
    }
    offset += length;
  }
  return false;
}

async function cacheDirectory(root: string, create: boolean): Promise<string> {
  let directory = await realpath(root);
  for (const part of ["knowledge", "indexes", "image-previews"]) {
    directory = join(directory, part);
    if (create) try { await mkdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe image preview cache directory");
  }
  return directory;
}

async function cachedPreview(root: string, name: string): Promise<Buffer | undefined> {
  try {
    const file = await open(join(await cacheDirectory(root, false), name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 1 || info.size > MAX_OUTPUT) return undefined;
      const bytes = Buffer.alloc(MAX_OUTPUT + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await file.read(bytes, size, bytes.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      const value = bytes.subarray(0, size);
      return validJpeg(value) ? value : undefined;
    } finally { await file.close(); }
  } catch { return undefined; }
}

async function persistPreview(root: string, name: string, bytes: Buffer): Promise<void> {
  let temporary: string | undefined;
  try {
    const directory = await cacheDirectory(root, true);
    temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, join(directory, name)); temporary = undefined;
  } catch { /* Read-only storage must not prevent returning a small in-memory preview. */ }
  finally { if (temporary) await rm(temporary, { force: true }).catch(() => undefined); }
}

function renderPreview(input: Buffer, mime: string): Promise<Buffer> {
  const script = fileURLToPath(new URL("../../backends/python/preview_project_image.py", import.meta.url));
  return new Promise((resolvePreview, reject) => {
    const child = spawn(process.env.ARGON_MEMORY_PYTHON_BIN || "python3", [script, "--mime", mime], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    const chunks: Buffer[] = [];
    let outputSize = 0, errorSize = 0, failure: Error | undefined;
    const stop = (message: string): void => { failure ??= new Error(message); child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop("Image preview timed out after 10 seconds"), TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > MAX_OUTPUT) stop("Image preview exceeds its 256 KiB output limit");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorSize += chunk.length;
      if (errorSize > 8 * 1024) stop("Image preview exceeds its stderr limit");
    });
    child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") stop("Cannot send image bytes to preview renderer"); });
    child.once("error", () => { clearTimeout(timer); reject(new Error("Cannot start image preview renderer")); });
    child.once("close", code => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error("Image preview renderer failed")); return; }
      const bytes = Buffer.concat(chunks, outputSize);
      if (!validJpeg(bytes)) { reject(new Error("Image preview renderer returned an invalid or oversized JPEG")); return; }
      resolvePreview(bytes);
    });
    child.stdin.end(input);
  });
}

/** Derive a compact display preview from already authorized original pixels. */
export async function makeEvidencePreview(root: string, sha256: string, mime: string, dataBase64: string): Promise<EvidencePreview> {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Image preview requires a verified SHA-256");
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) throw new Error("Unsupported image preview MIME");
  if (!dataBase64 || dataBase64.length > Math.ceil(MAX_INPUT / 3) * 4 || dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) throw new Error("Image preview input must be base64 within 10 MiB");
  const input = Buffer.from(dataBase64, "base64");
  if (input.length > MAX_INPUT || createHash("sha256").update(input).digest("hex") !== sha256) throw new Error("Image preview original failed integrity or size validation");
  const name = `${sha256}-v1.jpg`, key = `${resolve(root)}:${name}`;
  const cached = memory.get(key);
  if (cached) { remember(key, cached); return { ...cached }; }
  const existing = pending.get(key);
  if (existing) return { ...await existing };
  const operation = (async () => {
    let bytes = await cachedPreview(root, name);
    if (!bytes) { bytes = await renderPreview(input, mime); await persistPreview(root, name, bytes); }
    const preview: EvidencePreview = { data: bytes.toString("base64"), mimeType: "image/jpeg" };
    remember(key, preview);
    return preview;
  })();
  pending.set(key, operation);
  try { return { ...await operation }; } finally { pending.delete(key); }
}
