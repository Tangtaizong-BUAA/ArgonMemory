import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { safeReadImagePath } from "./evidence.js";

export type ProjectNormalizationResult = { markdown_path: string; parser: string; page_count: number; warnings: string[] };
type ExtractionReport = { parser: string; page_count: number; warnings: string[]; source_sha256: string; markdown_sha256: string; images: Array<{ path: string; sha256: string; mime_type: string; size_bytes: number }> };
const MAX_INPUT = 512 * 1024 * 1024;
const MAX_OUTPUT = 256 * 1024 * 1024;
const SUPPORTED = new Set(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/plain", "text/markdown", "application/json", "application/yaml", "text/yaml", "text/csv"]);
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, path: string): boolean => { const part = relative(root, path); return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function safeSource(root: string, source: string): Promise<string> {
  if (!source || source.includes("\0") || source.split(/[\\/]/).includes("..")) throw new Error("Unsafe document source path");
  const lexicalRoot = resolve(root), realRoot = await realpath(root);
  const target = isAbsolute(source) ? resolve(source) : resolve(lexicalRoot, source);
  const base = inside(lexicalRoot, target) ? lexicalRoot : inside(realRoot, target) ? realRoot : undefined;
  if (!base || target === base) throw new Error("Document source must be inside the knowledge root");
  let current = realRoot;
  for (const part of relative(base, target).split(sep)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Document source cannot use symlinks");
  }
  const checked = await realpath(current), info = await lstat(checked);
  if (!inside(realRoot, checked) || !info.isFile() || info.size > MAX_INPUT) throw new Error("Document source must be a regular knowledge file of at most 512 MiB");
  return checked;
}

async function safeDirectory(root: string, parts: string[]): Promise<string> {
  let current = await realpath(root);
  for (const part of parts) {
    if (!/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === "..") throw new Error("Unsafe normalization directory");
    current = join(current, part);
    try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Normalization directory cannot be a symlink or file");
  }
  return current;
}

async function invokeExtractor(source: string, output: string, mime: string, sha256: string): Promise<ExtractionReport> {
  const script = fileURLToPath(new URL("../../backends/python/extract_project_document.py", import.meta.url));
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.env.ARGON_MEMORY_PYTHON_BIN || "python3", [script, "--source", source, "--output", output, "--mime", mime, "--expected-sha256", sha256], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error("Local document normalization timed out after 5 minutes"); child.kill("SIGKILL"); }, 300_000);
    const add = (text: string, value: Buffer): string => {
      if (Buffer.byteLength(text) + value.length > 1024 * 1024) { failure = new Error("Local normalizer output exceeds its 1 MiB protocol limit"); child.kill("SIGKILL"); return text; }
      return text + value.toString("utf8");
    };
    child.stdout.on("data", (value: Buffer) => { stdout = add(stdout, value); });
    child.stderr.on("data", (value: Buffer) => { stderr = add(stderr, value); });
    child.once("error", error => { clearTimeout(timer); reject(new Error(`Cannot start local document normalizer: ${error.message}`)); });
    child.once("close", code => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      try {
        const value = JSON.parse(stdout) as ExtractionReport & { error?: string };
        if (code !== 0 || value.error) throw new Error(value.error || `Local normalizer exited ${code}: ${stderr.slice(0, 1000)}`);
        if (typeof value.parser !== "string" || !Number.isInteger(value.page_count) || value.page_count < 0 || !Array.isArray(value.warnings) || !value.warnings.every(item => typeof item === "string") || !Array.isArray(value.images) || value.images.length > 10000 || value.source_sha256 !== sha256 || !/^[a-f0-9]{64}$/.test(value.markdown_sha256)) throw new Error("Local normalizer returned an invalid extraction manifest");
        resolveResult(value);
      } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}

async function validateOutput(root: string, staging: string, report: ExtractionReport): Promise<void> {
  const expected = new Set(["document.md", ...report.images.map(image => image.path)]);
  let bytes = 0, count = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("Normalizer output contains a symlink");
      if (info.isDirectory()) { await walk(path); continue; }
      if (!info.isFile() || !expected.has(relative(staging, path))) throw new Error("Normalizer output contains an unexpected file");
      bytes += info.size; count++;
      if (bytes > MAX_OUTPUT || count > 10001) throw new Error("Normalizer output exceeds its resource limit");
    }
  };
  await walk(staging);
  if (count !== expected.size) throw new Error("Normalizer output manifest is incomplete");
  const markdown = await readFile(join(staging, "document.md"));
  if (digest(markdown) !== report.markdown_sha256) throw new Error("Normalized Markdown failed integrity verification");
  for (const image of report.images) {
    if (!/^images\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(image.path) || !/^[a-f0-9]{64}$/.test(image.sha256)) throw new Error("Unsafe normalized image manifest path");
    const actual = await safeReadImagePath(root, join(staging, image.path));
    if (actual.sha256 !== image.sha256 || actual.mimeType !== image.mime_type || Buffer.byteLength(actual.data, "base64") !== image.size_bytes) throw new Error("Normalized image failed integrity verification");
  }
}

/** Create a separate local-v1 derivative, preserving both the original and prior MinerU output. */
export async function normalizeProjectDocument(root: string, sourcePath: string, artifactId: string, mime: string): Promise<ProjectNormalizationResult> {
  if (!SUPPORTED.has(mime)) throw new Error("Local normalization supports UTF-8 text, DOCX, PPTX, XLSX and PDF; this MIME type requires another parser");
  const safeId = artifactId.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safeId || safeId === "." || safeId === ".." || safeId.length > 200) throw new Error("Invalid artifact ID for normalization");
  const source = await safeSource(root, sourcePath);
  const sourceHash = await hashFile(source);
  const artifactDirectory = await safeDirectory(root, ["normalized", safeId]);
  const target = join(artifactDirectory, "local-v1");
  if (inside(target, source)) throw new Error("An original source cannot live inside its normalization output");
  const lock = join(artifactDirectory, ".local-v1-lock");
  try { await mkdir(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("This artifact is already being normalized; retry after that run completes"); throw error; }
  let staging: string | undefined;
  let backup: string | undefined;
  try {
    staging = await mkdtemp(join(artifactDirectory, ".local-v1-staging-"));
    const report = await invokeExtractor(source, staging, mime, sourceHash);
    await validateOutput(root, staging, report);
    if (await safeSource(root, sourcePath) !== source || await hashFile(source) !== sourceHash) throw new Error("Original document changed during normalization; derivatives were not committed");
    await writeFile(join(staging, "parse-report.json"), JSON.stringify({ ...report, artifact_id: artifactId, source_path: relative(await realpath(root), source), parser_mode: "local", egress: "none", ocr_performed: false, completed_at: new Date().toISOString() }, null, 2) + "\n", "utf8");
    try {
      const existing = await lstat(target);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Existing local normalization output is unsafe");
      try {
        const previous = JSON.parse(await readFile(join(target, "parse-report.json"), "utf8")) as { artifact_id?: string };
        if (previous.artifact_id && previous.artifact_id !== artifactId) throw new Error("Artifact IDs collide at the normalization path");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      backup = join(artifactDirectory, `.local-v1-previous-${randomUUID()}`);
      await rename(target, backup);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await rename(staging, target); staging = undefined; }
    catch (error) { if (backup) { await rename(backup, target); backup = undefined; } throw error; }
    if (backup) { await rm(backup, { recursive: true, force: true }); backup = undefined; }
    return { markdown_path: `normalized/${safeId}/local-v1/document.md`, parser: report.parser, page_count: report.page_count, warnings: report.warnings };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
