import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseSourceRoots, sourceFilePath, type SourceRoot } from "../ingestion.js";
import type { KnowledgeRecord } from "../runtime.js";
import type { CorpusCoverage, EvidenceCorpus, EvidenceLocator, EvidenceUnit } from "./types.js";

const IMAGE_LIMIT = 10 * 1024 * 1024;
const CHUNK_SIZE = 1400;
const CHUNK_OVERLAP = 180;
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const within = (root: string, path: string): boolean => { const part = relative(root, path); return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
type RecordSnapshot = { fingerprint: string; units: EvidenceUnit[]; coverage: CorpusCoverage };
const corpusSnapshots = new WeakMap<EvidenceCorpus, { root: string; records: Map<string, RecordSnapshot> }>();

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? String(value);
}

function copyUnit(unit: EvidenceUnit, revision = unit.source_revision): EvidenceUnit {
  return { ...unit, source_revision: revision, source_refs: [...unit.source_refs], locator: { ...unit.locator, ...(unit.locator.section_path ? { section_path: [...unit.locator.section_path] } : {}) } };
}

function copyCoverage(value: CorpusCoverage): CorpusCoverage {
  return { ...value, missing_documents: [...value.missing_documents], unparsed_artifacts: [...value.unparsed_artifacts], text_unavailable_artifacts: [...(value.text_unavailable_artifacts ?? [])], unavailable_images: [...value.unavailable_images], warnings: [...value.warnings] };
}

function coverageDifference(before: CorpusCoverage, after: CorpusCoverage): CorpusCoverage {
  return { total_records: 1, total_artifacts: after.total_artifacts - before.total_artifacts, text_artifacts: after.text_artifacts - before.text_artifacts, image_units: after.image_units - before.image_units,
    missing_documents: after.missing_documents.slice(before.missing_documents.length), unparsed_artifacts: after.unparsed_artifacts.slice(before.unparsed_artifacts.length), text_unavailable_artifacts: (after.text_unavailable_artifacts ?? []).slice(before.text_unavailable_artifacts?.length ?? 0), unavailable_images: after.unavailable_images.slice(before.unavailable_images.length), warnings: after.warnings.slice(before.warnings.length) };
}

function mergeRecordCoverage(target: CorpusCoverage, source: CorpusCoverage): void {
  target.total_artifacts += source.total_artifacts; target.text_artifacts += source.text_artifacts; target.image_units += source.image_units;
  target.missing_documents.push(...source.missing_documents); target.unparsed_artifacts.push(...source.unparsed_artifacts); target.text_unavailable_artifacts!.push(...(source.text_unavailable_artifacts ?? [])); target.unavailable_images.push(...source.unavailable_images); target.warnings.push(...source.warnings);
}

/** Reject unsafe paths before opening them, including symlinked directories. */
async function safeLocalPath(root: string, path: string): Promise<string> {
  if (!path || path.includes("\0") || path.split(/[\\/]/).includes("..") || /^[a-z][a-z\d+.-]*:/i.test(path)) throw new Error("unsafe local path");
  const rootPath = resolve(root);
  const realRoot = await realpath(rootPath);
  const lexicalPath = isAbsolute(path) ? resolve(path) : resolve(rootPath, path);
  const base = within(rootPath, lexicalPath) ? rootPath : within(realRoot, lexicalPath) ? realRoot : undefined;
  if (!base || lexicalPath === base) throw new Error("path is outside the knowledge root");
  const parts = relative(base, lexicalPath).split(sep);
  let current = realRoot;
  for (const part of parts) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("symlinked paths are not allowed");
  }
  const resolved = await realpath(current);
  if (!within(realRoot, resolved) || !(await lstat(resolved)).isFile()) throw new Error("path is not a regular knowledge file");
  return resolved;
}

function imageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR") return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 10 && /^(GIF87a|GIF89a)$/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** Bounded byte read; MIME comes from bytes, never from a caller's extension. */
export async function safeReadImagePath(root: string, path: string): Promise<{ path: string; mimeType: string; data: string; sha256: string }> {
  const checked = await safeLocalPath(root, path);
  const file = await open(checked, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size === 0 || info.size > IMAGE_LIMIT) throw new Error("image must be a nonempty file of at most 10 MiB");
    const pieces: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, IMAGE_LIMIT + 1 - size));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > IMAGE_LIMIT) throw new Error("image exceeds 10 MiB");
      pieces.push(buffer.subarray(0, bytesRead));
    }
    // Revalidate ancestors after the read as well as the opened file itself.
    if (await safeLocalPath(root, path) !== checked) throw new Error("image path changed during read");
    const current = await lstat(checked);
    if (current.ino !== info.ino || current.dev !== info.dev) throw new Error("image file changed during read");
    const bytes = Buffer.concat(pieces);
    const mimeType = imageMime(bytes);
    if (!mimeType) throw new Error("unsupported or invalid image bytes");
    return { path: checked, mimeType, data: bytes.toString("base64"), sha256: hash(bytes) };
  } finally { await file.close(); }
}

/** Caller must authorize the unit first; immutable content is checked again here. */
export async function loadEvidenceImage(root: string, unit: EvidenceUnit): Promise<{ mimeType: string; data: string }> {
  if (unit.kind !== "image" || !unit.image_path || !unit.image_sha256) throw new Error("evidence unit has no readable image");
  const image = await safeReadImagePath(root, unit.image_path);
  if (image.sha256 !== unit.image_sha256 || image.mimeType !== unit.image_mime) throw new Error("evidence image changed; rebuild the corpus");
  return { mimeType: image.mimeType, data: image.data };
}

type MarkdownImage = { target: string; alt: string; caption: string; offset: number; end: number; index: number };

function markdownImages(text: string): MarkdownImage[] {
  const images: MarkdownImage[] = [];
  const definitions = new Map<string, string>();
  for (const match of text.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gm)) definitions.set(match[1]!.trim().toLowerCase(), match[2] ?? match[3]!);
  const pattern = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|((?:\\.|[^\s)])+))(?:\s+["']([^"']*)["'])?\s*\)|!\[([^\]]*)\]\[([^\]]*)\]|<img\b[^>]*>/gi;
  for (const match of text.matchAll(pattern)) {
    let target = match[2] ?? match[3];
    let alt = match[1] ?? match[5] ?? "";
    let caption = match[4] ?? "";
    if (match[5] !== undefined) target = definitions.get((match[6] || match[5]).trim().toLowerCase()) ?? "";
    if (match[0].toLowerCase().startsWith("<img")) {
      const attribute = (name: string): string => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(match[0])?.slice(1).find(Boolean) ?? "";
      target = attribute("src"); alt = attribute("alt"); caption = attribute("title");
    }
    images.push({ target: target ?? "", alt, caption, offset: match.index!, end: match.index! + match[0].length, index: images.length });
  }
  return images;
}

/** Replace embedded bytes with spaces so original line and character locations survive. */
function searchableText(text: string): string {
  // A per-character replacement allocates millions of intermediate pieces for
  // embedded scans. Mask contiguous runs while preserving UTF-16 offsets and
  // CR/LF positions used by evidence locators.
  return text.replace(/data:image\/[^\s;,]+;base64,[A-Za-z0-9+/=\r\n]+/gi, value => value.replace(/[^\r\n]+/g, run => " ".repeat(run.length)));
}

function locatorAt(text: string): (start: number, end: number) => EvidenceLocator {
  const lines = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === "\n") lines.push(index + 1);
  const states: Array<{ offset: number; path: string[]; page?: number }> = [{ offset: 0, path: [] }];
  const path: string[] = [];
  let page: number | undefined;
  for (const match of text.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)) {
    path.length = match[1]!.length - 1;
    path.push(match[2]!);
    const pageMatch = /^(?:Page\s+|第\s*)(\d+)(?:\s*页)?$/i.exec(match[2]!);
    if (pageMatch) page = Number(pageMatch[1]);
    states.push({ offset: match.index!, path: path.filter(Boolean), page });
  }
  const upperIndex = <T>(values: T[], offset: number, position: (item: T) => number): number => {
    let low = 0, high = values.length;
    while (low < high) { const mid = (low + high) >>> 1; if (position(values[mid]!) <= offset) low = mid + 1; else high = mid; }
    return Math.max(0, low - 1);
  };
  return (start, end) => {
    const state = states[upperIndex(states, start, value => value.offset)]!;
    return { start_char: start, end_char: end, start_line: upperIndex(lines, start, value => value) + 1, end_line: upperIndex(lines, Math.max(start, end - 1), value => value) + 1, section_path: state.path, ...(state.page === undefined ? {} : { page: state.page }) };
  };
}

function metadataText(record: KnowledgeRecord, metadataOnly = false): string {
  const fields = ["summary", "statement", "mission", "objective", "question", "outcome", "rationale", "description", "key", "kind", "scope", "display_name", "aliases", "occurred_at", "acceptance_criteria", "expected_outputs", "closeout_summary", "mitigation", "owner", "original_relative_path", "mime_type"];
  return [`# ${record.title}`, ...(metadataOnly ? ["[Metadata only: document body is unavailable; this record does not establish the original document's contents.]"] : []), ...fields.flatMap(key => typeof record[key] === "string" ? [`${key}: ${record[key]}`] : Array.isArray(record[key]) ? strings(record[key]).map(value => `${key}: ${value}`) : [])].join("\n");
}

function unitBase(record: KnowledgeRecord, revision: string) {
  return { record_id: record.id, ...(record.type === "artifact" ? { artifact_id: record.id } : {}), project_id: record.project_id, title: record.title, record_type: record.type, status: record.status, confidentiality: record.confidentiality ?? "internal" as const, source_revision: revision, source_refs: [...new Set([record.id, ...strings(record.source_refs), ...strings(record.evidence_refs)])] };
}

/** Build a complete source corpus; access and historical-state filtering belong to the query engine. */
export async function buildEvidenceCorpus(root: string, items: Array<{ record: KnowledgeRecord; body: string }>, revision: string, previous?: EvidenceCorpus): Promise<EvidenceCorpus> {
  const corpus: EvidenceCorpus = { revision, units: [], records: items, coverage: { total_records: items.length, total_artifacts: 0, text_artifacts: 0, image_units: 0, missing_documents: [], unparsed_artifacts: [], text_unavailable_artifacts: [], unavailable_images: [], warnings: [] } };
  const realRoot = await realpath(root);
  const previousCache = previous ? corpusSnapshots.get(previous) : undefined;
  const reusable = previousCache?.root === realRoot ? previousCache.records : undefined;
  const snapshots = new Map<string, RecordSnapshot>();
  let roots: SourceRoot[] | undefined;
  let rootsUnavailable = false;
  const getRoots = async (): Promise<SourceRoot[]> => {
    if (roots) return roots;
    try { roots = parseSourceRoots(await readFile(await safeLocalPath(root, "ingestion/source-roots.yaml"), "utf8")); }
    catch { roots = []; rootsUnavailable = true; }
    return roots;
  };
  for (const item of items) {
    const record = item.record;
    const fingerprint = hash(stableValue({ record, body: item.body }));
    const cached = reusable?.get(record.id);
    if (cached?.fingerprint === fingerprint) {
      const units = cached.units.map(unit => copyUnit(unit, revision));
      corpus.units.push(...units);
      mergeRecordCoverage(corpus.coverage, cached.coverage);
      snapshots.set(record.id, { fingerprint, units: units.map(unit => copyUnit(unit)), coverage: copyCoverage(cached.coverage) });
      continue;
    }
    const priorCoverage = copyCoverage(corpus.coverage), firstUnit = corpus.units.length;
    const base = unitBase(record, revision);
    let text = item.body;
    let documentPath: string | undefined;
    let metadataOnly = false;
    if (record.type === "artifact") {
      corpus.coverage.total_artifacts++;
      if (typeof record.normalized_markdown_path === "string") {
        try { documentPath = await safeLocalPath(root, record.normalized_markdown_path); text = await readFile(documentPath, "utf8"); }
        catch { corpus.coverage.missing_documents.push(record.id); metadataOnly = true; }
      } else metadataOnly = true;
      if (!metadataOnly && text.trim()) corpus.coverage.text_artifacts++;
      else { metadataOnly = true; corpus.coverage.unparsed_artifacts.push(record.id); corpus.coverage.text_unavailable_artifacts!.push(record.id); text = metadataText(record, true); }
    } else text = `${text.trimEnd()}\n\n${metadataText(record)}`.trim();
    const sourceHash = hash(text);
    const clean = searchableText(text);
    const locate = locatorAt(text);
    const uri = record.type === "artifact" && !metadataOnly ? `kb://artifact/${encodeURIComponent(record.id)}/document` : `kb://record/${encodeURIComponent(record.id)}`;
    for (let start = 0; start < clean.length;) {
      let end = Math.min(start + CHUNK_SIZE, clean.length);
      if (end < clean.length) { const newline = clean.lastIndexOf("\n", end); if (newline > start + CHUNK_SIZE / 2) end = newline + 1; }
      if (end < clean.length && /[\uDC00-\uDFFF]/.test(clean[end]!)) end--;
      if (clean.slice(start, end).trim()) corpus.units.push({ ...base, id: `evidence-unit:${hash(`${record.id}:${sourceHash}:text:${start}:${end}`)}`, kind: "text", text: clean.slice(start, end), content_hash: sourceHash, uri, locator: locate(start, end) });
      if (end === clean.length) break;
      start = Math.max(start + 1, end - CHUNK_OVERLAP);
      if (/[\uDC00-\uDFFF]/.test(clean[start]!)) start--;
    }
    const imageCandidates: Array<{ path?: string; originalMarkdownTarget?: string; label: string; alt: string; caption: string; index: number; start: number; sourceHash: string; location: EvidenceLocator; context: string; original?: boolean }> = [];
    const isOriginalMarkdown = record.type === "artifact" && typeof record.original_relative_path === "string"
      && (/\.(md|markdown)$/i.test(record.original_relative_path) || /^text\/markdown(?:;|$)/i.test(String(record.mime_type ?? "")));
    let originalMarkdownPath: Promise<string | undefined> | undefined;
    const getOriginalMarkdownPath = (): Promise<string | undefined> => originalMarkdownPath ??= (async () => {
      if (!isOriginalMarkdown) return undefined;
      try {
        let path: string;
        if (typeof record.managed_relative_path === "string") path = record.managed_relative_path;
        else {
          const sourceRoot = (await getRoots()).find(value => value.id === record.source_root_id && value.project_id === record.project_id && value.enabled !== false);
          if (!sourceRoot || sourceRoot.relative_path.split(/[\\/]/).includes("..") || String(record.original_relative_path).split(/[\\/]/).includes("..")) return undefined;
          path = sourceFilePath(root, sourceRoot, String(record.original_relative_path));
        }
        // Check the original itself as well as its directory before using its base.
        return await safeLocalPath(root, path);
      } catch { return undefined; }
    })();
    const addMarkdownImages = (sourceText: string, path?: string, allowOriginalFallback = false): void => {
      const indexOffset = imageCandidates.length;
      const sourceClean = searchableText(sourceText), sourceLocate = locatorAt(sourceText), imageSourceHash = hash(sourceText);
      for (const image of markdownImages(sourceText)) {
        let imagePath: string | undefined, originalMarkdownTarget: string | undefined;
        try {
          const target = decodeURIComponent(image.target.replace(/\\([ ()])/g, "$1"));
          if (!target || target.includes("\0") || target.includes("\\") || isAbsolute(target) || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("//")) throw new Error("nonlocal image");
          // Resolve relative parent segments lexically, then let safeLocalPath
          // enforce the knowledge-root boundary and reject symlink ancestors.
          imagePath = resolve(path ? dirname(path) : root, target);
          if (allowOriginalFallback && isOriginalMarkdown) originalMarkdownTarget = target;
        } catch { /* Keep an explicit unavailable entry; never fetch remote references. */ }
        imageCandidates.push({ path: imagePath, originalMarkdownTarget, label: image.target.startsWith("data:") ? "inline-data-image" : image.target, alt: image.alt, caption: image.caption, index: indexOffset + image.index, start: image.offset, sourceHash: imageSourceHash, location: sourceLocate(image.offset, image.end), context: sourceClean.slice(Math.max(0, image.offset - 350), Math.min(sourceClean.length, image.end + 350)) });
      }
    };
    if (!metadataOnly) addMarkdownImages(text, documentPath, true);
    if (record.type === "artifact" && (String(record.mime_type ?? "").startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(String(record.original_relative_path ?? "")))) {
      let path: string | undefined;
      try {
        if (typeof record.managed_relative_path === "string") path = record.managed_relative_path;
        else if (typeof record.original_relative_path === "string" && typeof record.source_root_id === "string") {
          const sourceRoot = (await getRoots()).find(value => value.id === record.source_root_id && value.project_id === record.project_id && value.enabled !== false);
          if (rootsUnavailable) corpus.coverage.warnings.push(`Configured source roots could not be read for ${record.id}; its original source image may be unavailable.`);
          if (!sourceRoot || record.original_relative_path.split(/[\\/]/).includes("..") || sourceRoot.relative_path.split(/[\\/]/).includes("..")) throw new Error("unknown or unsafe source root");
          path = sourceFilePath(root, sourceRoot, record.original_relative_path);
        }
      } catch { /* Report the missing original below. */ }
      imageCandidates.push({ path, label: String(record.original_relative_path ?? record.id), alt: record.title, caption: "Original uploaded image", index: imageCandidates.length, start: 0, sourceHash, location: locate(0, 0), context: metadataText(record), original: true });
    }
    // Supplement older parsers' missing pixels without changing their text units or image positions.
    if (record.type === "artifact" && typeof record.image_source_markdown_path === "string" && record.image_source_markdown_path !== record.normalized_markdown_path) {
      try {
        const supplementPath = await safeLocalPath(root, record.image_source_markdown_path);
        addMarkdownImages(await readFile(supplementPath, "utf8"), supplementPath);
      } catch {
        corpus.coverage.unavailable_images.push(`${record.id}#image-source`);
        corpus.coverage.warnings.push(`Image supplement unavailable (${record.id}); the original normalized text remains searchable.`);
      }
    }
    let originalImageAvailable = false;
    for (const image of imageCandidates) {
      const imageUri = `kb://artifact/${encodeURIComponent(record.id)}/image/${image.index}`;
      try {
        if (!image.path) throw new Error("image has no safe local path");
        const bytes = await safeReadImagePath(root, image.path).catch(async error => {
          // Legacy ingestion copied Markdown without its sibling image folder.
          // Do not use a second location to bypass invalid bytes or unsafe paths.
          if (!image.originalMarkdownTarget || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          const original = await getOriginalMarkdownPath();
          if (!original) throw error;
          const fallback = resolve(dirname(original), image.originalMarkdownTarget);
          if (fallback === image.path) throw error;
          return safeReadImagePath(root, fallback);
        });
        if (image.original && typeof record.sha256 === "string" && /^[a-f0-9]{64}$/i.test(record.sha256) && bytes.sha256 !== record.sha256.toLowerCase()) throw new Error("original image failed its registered content hash");
        const location = { ...image.location, image_index: image.index };
        corpus.units.push({ ...base, id: `evidence-unit:${hash(`${record.id}:${image.sourceHash}:image:${image.start}:${image.index}:${bytes.sha256}`)}`, kind: "image", text: [record.title, ...(location.section_path ?? []), image.alt, image.caption, basename(image.label), image.context].filter(Boolean).join("\n"), content_hash: image.sourceHash, uri: imageUri, image_uri: imageUri, locator: location, image_path: bytes.path, image_mime: bytes.mimeType, image_sha256: bytes.sha256 });
        corpus.coverage.image_units++;
        if (image.original) originalImageAvailable = true;
      } catch (error) {
        corpus.coverage.unavailable_images.push(`${record.id}#image-${image.index}`);
        corpus.coverage.warnings.push(`Image unavailable (${record.id}#image-${image.index}): ${error instanceof Error ? error.message : "read failed"}`);
      }
    }
    if (originalImageAvailable && metadataOnly) {
      corpus.coverage.unparsed_artifacts = corpus.coverage.unparsed_artifacts.filter(id => id !== record.id);
      corpus.coverage.warnings.push(`Image artifact ${record.id} provides readable original pixels; text/OCR content is unavailable.`);
    }
    snapshots.set(record.id, { fingerprint, units: corpus.units.slice(firstUnit).map(unit => copyUnit(unit)), coverage: coverageDifference(priorCoverage, corpus.coverage) });
  }
  corpusSnapshots.set(corpus, { root: realRoot, records: snapshots });
  return corpus;
}
