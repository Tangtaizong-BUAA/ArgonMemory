import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EvidenceCorpus, EvidenceHit, EvidenceUnit, RetrievalProvider, RetrievalRequest, RetrievalResult } from "./types.js";
import { loadEvidenceImage } from "./evidence.js";

const CONFIDENTIALITY: Record<string, number> = { public: 0, internal: 1, restricted: 2, secret: 3 };
const HISTORICAL = new Set(["superseded", "stale", "archived", "deleted", "retired", "deprecated"]);
const UNVERIFIED = new Set(["candidate", "validating", "quarantined", "rejected", "disputed", "proposal", "proposed", "queued"]);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const SOURCE_DIVERSITY_SCORE_RATIO = 0.9;
// Matches the provider's comparison groups; this does not trigger more requests.
const IMAGE_RERANK_GROUP_SIZE = 4;

/** Spaces make Chinese bigrams independently addressable by SQLite unicode61. */
export function retrievalTerms(text: string): string[] {
  const clean = text.normalize("NFKC").toLocaleLowerCase()
    .replace(/(?:请问|请帮我|告诉我|有多少|有哪些|是什么|为什么|怎么样|如何|是否|是谁|什么时候|什么|哪些|的|了|吗|呢)/gu, " ");
  const terms: string[] = [];
  for (const part of clean.match(/[\p{Script=Han}]+|[\p{L}\p{N}_.-]+/gu) ?? []) {
    if (/^\p{Script=Han}+$/u.test(part)) {
      const chars = [...part];
      if (chars.length === 1) continue;
      for (let i = 0; i + 1 < chars.length; i++) terms.push(chars[i]! + chars[i + 1]!);
    } else if (part.length > 1 && !new Set(["the", "and", "for", "what", "when", "where", "who", "how", "is", "are", "was", "of", "to", "in", "a", "an"]).has(part)) terms.push(part);
  }
  return [...new Set(terms)];
}

function normalized(vector: number[], expectedDimension?: number): number[] | undefined {
  if (!Array.isArray(vector) || vector.length === 0 || (expectedDimension !== undefined && vector.length !== expectedDimension) || vector.some(n => !Number.isFinite(n))) return undefined;
  const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0));
  return norm > 0 ? vector.map(n => n / norm) : undefined;
}
function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return -1;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}
function minimumSimilarity(kind: "text" | "image"): number {
  const raw = process.env[kind === "text" ? "ARGON_MEMORY_TEXT_MIN_SIMILARITY" : "ARGON_MEMORY_IMAGE_MIN_SIMILARITY"];
  const fallback = kind === "text" ? 0.2 : 0.1;
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : fallback;
}
function imageRerankAdjustment(): number {
  const raw = process.env.ARGON_MEMORY_IMAGE_RERANK_ADJUSTMENT;
  const value = raw === undefined || raw.trim() === "" ? 0.1 : Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(0.5, value)) : 0.1;
}
function permitted(record: { id?: string; record_id?: string; project_id: string; confidentiality?: string; status: string; type?: string; record_type?: string }, request: RetrievalRequest): boolean {
  if (request.project_id && request.project_id !== record.project_id) return false;
  if ((CONFIDENTIALITY[record.confidentiality ?? "internal"] ?? 99) > (CONFIDENTIALITY[request.maximum_confidentiality ?? "internal"] ?? 1)) return false;
  if (!request.include_history && HISTORICAL.has(record.status)) return false;
  const type = record.record_type ?? record.type;
  if (request.record_types && (!type || !request.record_types.includes(type))) return false;
  if (request.record_ids && !request.record_ids.includes(record.record_id ?? record.id ?? "")) return false;
  if (type === "validation_event") return false;
  if (!request.include_unverified && (UNVERIFIED.has(record.status) || (type === "memory" && record.status !== "accepted" && !(request.include_history && HISTORICAL.has(record.status))))) return false;
  return true;
}
function sourceOf(unit: EvidenceUnit): string { return unit.artifact_id ?? unit.record_id; }
const LEXICAL_ONLY_TYPES = new Set(["work_item", "activity", "maintenance_change_packet", "ingestion_job", "validation_event", "audit_event"]);
const EMBEDDABLE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
function imageEmbeddingSupported(unit: EvidenceUnit): boolean { return !!unit.image_mime && EMBEDDABLE_IMAGE_MIMES.has(unit.image_mime); }
function metadataOnly(unit: EvidenceUnit): boolean { return unit.kind === "text" && unit.text.includes("[Metadata only: document body is unavailable;"); }
function semanticEligible(unit: EvidenceUnit): boolean { return unit.kind === "image" || (!metadataOnly(unit) && !LEXICAL_ONLY_TYPES.has(unit.record_type)); }
function sourcePrior(unit: EvidenceUnit): number {
  if (metadataOnly(unit)) return 0.45;
  if (unit.record_type === "artifact" && unit.status === "parsed") return 1.12;
  if (unit.record_type === "knowledge_section") return 1.06;
  if (unit.record_type === "memory" && unit.status === "accepted") return 1.04;
  return LEXICAL_ONLY_TYPES.has(unit.record_type) ? 0.75 : 1;
}
function diversify(hits: EvidenceHit[], maxPerSource: number): EvidenceHit[] {
  const output: EvidenceHit[] = [];
  // Source IDs alone do not identify copied images or identical text excerpts.
  // Compute payload identity once; every round can show it at most once.
  const contentKeys = new Map(hits.map(hit => [hit.unit.id, hit.unit.kind === "image"
    ? `image:${hit.unit.image_sha256 ?? hit.unit.id}`
    : `text:${hash(hit.unit.text)}`]));
  let remaining = hits;
  while (remaining.length) {
    const contents = new Set<string>();
    const distinct: EvidenceHit[] = [];
    const deferred: EvidenceHit[] = [];
    for (const hit of remaining) {
      const content = contentKeys.get(hit.unit.id)!;
      if (contents.has(content)) deferred.push(hit);
      else { contents.add(content); distinct.push(hit); }
    }
    // Rotate sources only among comparably relevant evidence. A document can
    // contain many useful photos; a hard source cap must not promote an
    // unrelated card or decorative asset ahead of those photos.
    for (let start = 0; start < distinct.length;) {
      const floor = distinct[start]!.score * SOURCE_DIVERSITY_SCORE_RATIO;
      let end = start + 1;
      while (end < distinct.length && distinct[end]!.score >= floor) end++;
      let band = distinct.slice(start, end);
      while (band.length) {
        const counts = new Map<string, number>();
        const next: EvidenceHit[] = [];
        for (const hit of band) {
          const source = sourceOf(hit.unit), count = counts.get(source) ?? 0;
          if (count >= maxPerSource) next.push(hit);
          else { counts.set(source, count + 1); output.push(hit); }
        }
        band = next;
      }
      start = end;
    }
    remaining = deferred;
  }
  return output;
}

type StoredHit = { id: string; score: number; channels: string[] };
type PageSnapshot = { revision: string; scope: string; hits: StoredHit[]; coverage: Record<string, unknown>; warnings: string[]; models: Record<string, unknown> };
type Cursor = { v: 1; revision: string; scope: string; snapshot: string; offset: number };
export type RetrievalIndexProgress = {
  stage: "lexical" | "embedding" | "complete"; modality?: "text" | "image";
  completed: number; total: number; failed?: number; revision: string;
};

/** Rebuildable local index. Exact vector search is O(visible units × dimensions). */
export class ProjectRetrievalIndex {
  readonly path: string;
  private db?: Database.Database;
  private persistedCache?: Database.Database;
  private revision?: string;
  private readonly snapshots = new Map<string, PageSnapshot>();
  private readonly rankingCache = new Map<string, { id: string; snapshot: PageSnapshot; created: number }>();
  private readonly syncWarnings = new Set<string>();
  private readonly vectors = new Map<string, Float32Array | null>();
  private vectorBytes = 0;
  private readonly queryVectors = new Map<string, Float32Array>();
  private readonly queryInflight = new Map<string, Promise<Float32Array>>();
  private cacheGeneration?: string;

  constructor(private readonly root: string, private readonly provider?: RetrievalProvider, private readonly options: { readOnly?: boolean; onProgress?: (progress: RetrievalIndexProgress) => void } = {}) {
    this.path = join(root, "knowledge", "indexes", "retrieval.sqlite");
  }

  private open(): Database.Database {
    if (this.db) return this.db;
    if (this.options.readOnly) {
      this.db = new Database(":memory:");
      if (existsSync(this.path)) {
        try { this.persistedCache = new Database(this.path, { readonly: true, fileMustExist: true }); }
        catch { this.syncWarnings.add("persisted_embedding_cache_unavailable"); }
      } else this.syncWarnings.add("persistent_index_missing_using_memory_lexical_index");
    } else {
      mkdirSync(dirname(this.path), { recursive: true });
      this.db = new Database(this.path);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS retrieval_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence_units (
        id TEXT PRIMARY KEY, record_id TEXT NOT NULL, project_id TEXT NOT NULL,
        confidentiality INTEGER NOT NULL, status TEXT NOT NULL, record_type TEXT NOT NULL,
        kind TEXT NOT NULL, content_hash TEXT NOT NULL, unit_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evidence_scope ON evidence_units(project_id, confidentiality, status, kind);
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(unit_id UNINDEXED, title_tokens, body_tokens, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS embedding_cache (cache_key TEXT PRIMARY KEY, modality TEXT NOT NULL, vector_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS retrieval_pages (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, snapshot_json TEXT NOT NULL);
    `);
    this.revision = (this.db.prepare("SELECT value FROM retrieval_meta WHERE key='revision'").get() as { value: string } | undefined)?.value;
    return this.db;
  }

  private cacheKey(unit: EvidenceUnit): string {
    const p = this.provider!;
    // The modality and model are part of the key: VL and text vectors never share a space.
    // content_hash identifies the source document, shared by all its chunks.
    // Cache the actual provider payload, otherwise different chunks collide.
    const payloadHash = unit.kind === "image" ? unit.image_sha256 ?? "unavailable-image" : hash(unit.text);
    return hash(JSON.stringify(["embedding-v2-payload", p.fingerprint, unit.kind, unit.kind === "image" ? p.imageModel : p.textModel, p.dimension, payloadHash]));
  }

  private rememberVector(key: string, vector: Float32Array | null): void {
    this.vectorBytes -= this.vectors.get(key)?.byteLength ?? 0;
    this.vectors.delete(key);
    this.vectors.set(key, vector);
    this.vectorBytes += vector?.byteLength ?? 0;
    const configured = Number(process.env.ARGON_MEMORY_VECTOR_CACHE_MIB ?? 48);
    const maxBytes = (Number.isFinite(configured) ? Math.max(1, Math.min(128, configured)) : 48) * 1024 * 1024;
    while (this.vectorBytes > maxBytes || this.vectors.size > 50_000) {
      const oldest = this.vectors.keys().next().value!;
      this.vectorBytes -= this.vectors.get(oldest)?.byteLength ?? 0;
      this.vectors.delete(oldest);
    }
  }

  private vector(unit: EvidenceUnit): Float32Array | undefined {
    if (!this.provider) return undefined;
    const key = this.cacheKey(unit);
    if (this.vectors.has(key)) {
      const cached = this.vectors.get(key)!;
      this.vectors.delete(key); this.vectors.set(key, cached);
      return cached ?? undefined;
    }
    const read = (db: Database.Database | undefined): Float32Array | undefined => {
      if (!db) return undefined;
      try {
        const row = db.prepare("SELECT vector_json FROM embedding_cache WHERE cache_key=? AND modality=?").get(key, unit.kind) as { vector_json: string } | undefined;
        const values = row ? normalized(JSON.parse(row.vector_json), this.provider!.dimension) : undefined;
        return values ? new Float32Array(values) : undefined;
      } catch { return undefined; }
    };
    const vector = read(this.open()) ?? read(this.persistedCache);
    this.rememberVector(key, vector ?? null);
    return vector;
  }

  private refreshVectorCache(): void {
    const generationOf = (db: Database.Database | undefined): string => {
      if (!db) return "none";
      try { return (db.prepare("SELECT value FROM retrieval_meta WHERE key='embedding_generation'").get() as { value: string } | undefined)?.value ?? "empty"; }
      catch { return "unavailable"; }
    };
    const generation = `${generationOf(this.open())}:${generationOf(this.persistedCache)}`;
    if (generation !== this.cacheGeneration) {
      // Content-addressed positive cache entries are immutable. Only misses can
      // become available when a background indexer commits another batch.
      for (const [key, value] of this.vectors) if (!value) this.vectors.delete(key);
      this.rankingCache.clear();
    }
    this.cacheGeneration = generation;
  }

  private async queryVector(query: string, kind: "text" | "image"): Promise<Float32Array> {
    const provider = this.provider!;
    const key = hash(JSON.stringify(["query-v1", provider.fingerprint, kind, kind === "text" ? provider.textModel : provider.imageModel, provider.dimension, query]));
    const cached = this.queryVectors.get(key);
    if (cached) { this.queryVectors.delete(key); this.queryVectors.set(key, cached); return cached; }
    const pending = this.queryInflight.get(key);
    if (pending) return pending;
    const operation = (async () => {
      const raw = kind === "text" ? (await provider.embedText([query], "query"))[0] : await provider.embedImageQuery(query);
      const values = raw ? normalized(raw, provider.dimension) : undefined;
      if (!values) throw new Error("Invalid query embedding");
      const vector = new Float32Array(values);
      this.queryVectors.set(key, vector);
      while (this.queryVectors.size > 128) this.queryVectors.delete(this.queryVectors.keys().next().value!);
      return vector;
    })();
    this.queryInflight.set(key, operation);
    try { return await operation; } finally { this.queryInflight.delete(key); }
  }

  private progress(value: RetrievalIndexProgress): void {
    // Observability must not turn a successful batch into a failed embedding call.
    try { this.options.onProgress?.(value); } catch { /* reporter failure is isolated */ }
  }

  private synchronizeLexical(corpus: EvidenceCorpus): void {
    const db = this.open();
    const projection = JSON.stringify({ schema: "evidence-corpus-projection/v1", revision: corpus.revision, unit_count: corpus.units.length, coverage: corpus.coverage });
    // Another process can replace the rebuildable index while this object is alive.
    this.revision = (db.prepare("SELECT value FROM retrieval_meta WHERE key='revision'").get() as { value: string } | undefined)?.value;
    if (this.revision === corpus.revision) {
      // Upgrade existing indexes without invoking a provider or reading pixels.
      const stored = (db.prepare("SELECT value FROM retrieval_meta WHERE key='corpus_projection'").get() as { value: string } | undefined)?.value;
      if (stored !== projection) db.prepare("INSERT OR REPLACE INTO retrieval_meta(key,value) VALUES ('corpus_projection',?)").run(projection);
      return;
    }
    const insert = db.prepare("INSERT INTO evidence_units VALUES (?,?,?,?,?,?,?,?,?)");
    const fts = db.prepare("INSERT INTO evidence_fts(unit_id,title_tokens,body_tokens) VALUES (?,?,?)");
    db.transaction(() => {
      db.exec("DELETE FROM evidence_units; DELETE FROM evidence_fts;");
      for (const unit of corpus.units) {
        insert.run(unit.id, unit.record_id, unit.project_id, CONFIDENTIALITY[unit.confidentiality] ?? 99, unit.status, unit.record_type, unit.kind, unit.content_hash, JSON.stringify(unit));
        fts.run(unit.id, retrievalTerms(unit.title).join(" "), retrievalTerms(unit.text).join(" "));
      }
      db.prepare("INSERT OR REPLACE INTO retrieval_meta(key,value) VALUES ('revision',?)").run(corpus.revision);
      db.prepare("INSERT OR REPLACE INTO retrieval_meta(key,value) VALUES ('corpus_projection',?)").run(projection);
    })();
    this.revision = corpus.revision;
    this.progress({ stage: "lexical", completed: corpus.units.length, total: corpus.units.length, revision: corpus.revision });
  }

  /** Hydrate a matching local projection; original pixels are checked at use time. */
  loadCorpusProjection(revision: string, records: EvidenceCorpus["records"]): EvidenceCorpus | undefined {
    const db = this.open();
    const byId = new Map(records.map(item => [item.record.id, item.record]));
    const load = (source: Database.Database | undefined): EvidenceCorpus | undefined => {
      if (!source) return undefined;
      try {
        return source.transaction(() => {
          const current = (source.prepare("SELECT value FROM retrieval_meta WHERE key='revision'").get() as { value: string } | undefined)?.value;
          const row = source.prepare("SELECT value FROM retrieval_meta WHERE key='corpus_projection'").get() as { value: string } | undefined;
          if (current !== revision || !row) return undefined;
          const metadata = JSON.parse(row.value) as { schema: string; revision: string; unit_count: number; coverage: EvidenceCorpus["coverage"] };
          if (metadata.schema !== "evidence-corpus-projection/v1" || metadata.revision !== revision || !Number.isSafeInteger(metadata.unit_count) || metadata.unit_count < 0 || metadata.coverage?.total_records !== records.length) return undefined;
          for (const field of ["missing_documents", "unparsed_artifacts", "unavailable_images", "warnings"] as const) if (!Array.isArray(metadata.coverage[field])) return undefined;
          const rows = source.prepare("SELECT unit_json FROM evidence_units ORDER BY rowid").all() as Array<{ unit_json: string }>;
          if (rows.length !== metadata.unit_count) return undefined;
          const units = rows.map(row => JSON.parse(row.unit_json) as EvidenceUnit);
          const ids = new Set<string>();
          for (const unit of units) {
            const record = byId.get(unit.record_id);
            if (!record || typeof unit.id !== "string" || ids.has(unit.id) || unit.source_revision !== revision
              || unit.project_id !== record.project_id || unit.record_type !== record.type || unit.status !== record.status
              || unit.confidentiality !== (record.confidentiality ?? "internal") || typeof unit.text !== "string"
              || typeof unit.content_hash !== "string" || typeof unit.uri !== "string" || !unit.locator || !Array.isArray(unit.source_refs)
              || (unit.kind !== "text" && unit.kind !== "image")) return undefined;
            ids.add(unit.id);
          }
          return { revision, records, units, coverage: metadata.coverage };
        })();
      } catch { return undefined; }
    };
    return load(db) ?? load(this.persistedCache);
  }

  /** Local inspection only: never invokes embedding, rerank or any provider API. */
  inspectCoverage(corpus: EvidenceCorpus, partialScope: Partial<RetrievalRequest> = {}): Record<string, unknown> {
    const request: RetrievalRequest = { ...partialScope, query: partialScope.query ?? "" };
    this.refreshVectorCache();
    this.synchronizeLexical(corpus);
    const units = corpus.units.filter(unit => permitted(unit, request) && (!request.modality || request.modality === "all" || request.modality === unit.kind));
    const coverage = this.coverage(corpus, request, units);
    const warnings = new Set<string>();
    for (const warning of this.syncWarnings) if (warning.includes("index") || warning.includes("cache_unavailable")) warnings.add(warning);
    if (!this.provider) warnings.add("embedding_provider_unavailable");
    if (!coverage.text_embedding_complete) warnings.add("text_embedding_incomplete_explicit_synchronize_required");
    if (!coverage.image_embedding_complete) warnings.add("image_embedding_incomplete_explicit_synchronize_required");
    if ((coverage.unsupported_image_formats as unknown[]).length) warnings.add("unsupported_image_format");
    if ((coverage.missing_documents as string[]).length) warnings.add("visible_documents_unavailable");
    if ((coverage.unparsed_artifacts as string[]).length) warnings.add("visible_artifacts_unparsed");
    if ((coverage.unavailable_images as string[]).length) warnings.add("visible_images_unavailable");
    return { ...coverage, revision: corpus.revision, warnings: [...warnings],
      models: { provider_configured: !!this.provider, text_model: this.provider?.textModel ?? null, image_model: this.provider?.imageModel ?? null, dimension: this.provider?.dimension ?? null },
    };
  }

  private async embedPayloadBatch(kind: "text" | "image", units: EvidenceUnit[], payloads: string[]): Promise<void> {
    const values = kind === "text" ? await this.provider!.embedText(payloads, "document") : await this.provider!.embedImages(payloads);
    if (values.length !== units.length) throw new Error("Embedding batch length mismatch");
    const vectors = values.map(vector => normalized(vector, this.provider!.dimension));
    if (vectors.some(vector => !vector)) throw new Error("Invalid embedding vector");
    const db = this.open(), store = db.prepare("INSERT OR REPLACE INTO embedding_cache VALUES (?,?,?)");
    db.transaction(() => {
      units.forEach((unit, i) => store.run(this.cacheKey(unit), unit.kind, JSON.stringify(vectors[i])));
      db.prepare("INSERT OR REPLACE INTO retrieval_meta(key,value) VALUES ('embedding_generation',?)").run(randomUUID());
    })();
    units.forEach((unit, i) => this.rememberVector(this.cacheKey(unit), new Float32Array(vectors[i]!)));
  }

  async synchronize(corpus: EvidenceCorpus, options: { embed?: boolean } = {}): Promise<Record<string, unknown>> {
    const db = this.open();
    this.refreshVectorCache();
    this.synchronizeLexical(corpus);
    if (options.embed) {
      this.syncWarnings.delete("document_embedding_failed");
      this.syncWarnings.delete("image_embedding_failed");
      this.syncWarnings.delete("image_content_unavailable");
      if (!this.provider) this.syncWarnings.add("embedding_provider_unavailable");
      else {
        // Explicit synchronization never sends restricted or secret material to a provider.
        const safe = corpus.units.filter(unit => permitted(unit, { query: "", maximum_confidentiality: "internal" }));
        for (const kind of ["text", "image"] as const) {
          const dedup = new Map<string, EvidenceUnit>();
          for (const unit of safe.filter(unit => semanticEligible(unit) && unit.kind === kind && (kind !== "image" || (unit.image_path && imageEmbeddingSupported(unit))))) if (!this.vector(unit)) dedup.set(this.cacheKey(unit), unit);
          const pending = [...dedup.values()];
          let failed = 0;
          this.progress({ stage: "embedding", modality: kind, completed: 0, total: pending.length, failed, revision: corpus.revision });
          const batchSize = kind === "image" ? 4 : 16;
          for (let offset = 0; offset < pending.length; offset += batchSize) {
            const batch = pending.slice(offset, offset + batchSize);
            let ready = batch.map(unit => ({ unit, payload: unit.text }));
            if (kind === "image") {
              const checked = await Promise.all(batch.map(async unit => {
                try {
                  const image = await loadEvidenceImage(this.root, unit);
                  return { unit, payload: `data:${image.mimeType};base64,${image.data}` };
                } catch { return undefined; }
              }));
              ready = checked.filter((item): item is { unit: EvidenceUnit; payload: string } => !!item);
              if (ready.length !== batch.length) {
                failed += batch.length - ready.length;
                this.syncWarnings.add("image_content_unavailable");
                this.syncWarnings.add("image_embedding_failed");
              }
            }
            if (ready.length) try {
              await this.embedPayloadBatch(kind, ready.map(item => item.unit), ready.map(item => item.payload));
            } catch (error) {
              const invalidImageBatch = kind === "image" && ready.length > 1 && /HTTP 400\b|invalid[-_ ]image\b/i.test(error instanceof Error ? error.message : "");
              if (invalidImageBatch) {
                // A confirmed rejected image batch gets at most one individual
                // attempt per input. Never amplify timeout, 5xx or auth retries.
                for (const item of ready) try { await this.embedPayloadBatch(kind, [item.unit], [item.payload]); }
                catch { failed++; this.syncWarnings.add("image_embedding_failed"); }
              } else {
                failed += ready.length;
                this.syncWarnings.add(kind === "text" ? "document_embedding_failed" : "image_embedding_failed");
              }
            }
            this.progress({ stage: "embedding", modality: kind, completed: Math.min(offset + batch.length, pending.length), total: pending.length, failed, revision: corpus.revision });
          }
        }
      }
    }
    const units = corpus.units.filter(unit => permitted(unit, { query: "" }));
    const coverage = this.coverage(corpus, { query: "" }, units);
    const warnings = new Set(this.syncWarnings);
    if (!coverage.text_embedding_complete) warnings.add("text_embedding_incomplete_explicit_synchronize_required");
    if (!coverage.image_embedding_complete) warnings.add("image_embedding_incomplete_explicit_synchronize_required");
    if ((coverage.unsupported_image_formats as unknown[]).length) warnings.add("unsupported_image_format");
    if (options.embed) this.progress({ stage: "complete", completed: Number(coverage.text_embedded_units) + Number(coverage.image_embedded_units), total: Number(coverage.text_embedding_eligible_units) + Number(coverage.image_units), revision: corpus.revision });
    return { ...coverage, revision: corpus.revision, warnings: [...warnings] };
  }

  private coverage(corpus: EvidenceCorpus, request: RetrievalRequest, units: EvidenceUnit[]): Record<string, unknown> {
    const records = corpus.records.filter(item => permitted(item.record, request));
    const visibleIds = new Set(records.map(item => item.record.id));
    const text = units.filter(unit => unit.kind === "text"), images = units.filter(unit => unit.kind === "image");
    const eligibleText = text.filter(semanticEligible);
    const textEmbedded = eligibleText.filter(unit => this.vector(unit)).length;
    const imageEmbedded = images.filter(imageEmbeddingSupported).filter(unit => this.vector(unit)).length;
    return {
      total_records: records.length,
      total_artifacts: records.filter(item => item.record.type === "artifact").length,
      evidence_units: units.length, text_units: text.length, image_units: images.length,
      text_embedding_eligible_units: eligibleText.length, lexical_only_units: text.length - eligibleText.length,
      metadata_only_units: units.filter(metadataOnly).length,
      unsupported_image_formats: images.filter(unit => !imageEmbeddingSupported(unit)).map(unit => ({ id: unit.id, mime_type: unit.image_mime ?? "unknown" })),
      text_embedded_units: textEmbedded, image_embedded_units: imageEmbedded,
      text_embedding_complete: textEmbedded === eligibleText.length, image_embedding_complete: imageEmbedded === images.length,
      missing_documents: corpus.coverage.missing_documents.filter(id => visibleIds.has(id)),
      unparsed_artifacts: corpus.coverage.unparsed_artifacts.filter(id => visibleIds.has(id)),
      text_unavailable_artifacts: (corpus.coverage.text_unavailable_artifacts ?? []).filter(id => visibleIds.has(id)),
      unavailable_images: corpus.coverage.unavailable_images.filter(id => visibleIds.has(id) || visibleIds.has(id.replace(/#image-(?:\d+|source)$/, "")) || units.some(unit => unit.id === id)),
      vector_search: "exact_cosine_over_visible_units", vector_search_complexity: "O(visible_units * embedding_dimension)",
    };
  }

  private scope(request: RetrievalRequest): string {
    return hash(JSON.stringify({
      query: request.query.trim(), project_id: request.project_id ?? null, mode: request.mode ?? "hybrid",
      intent: request.intent ?? "answer", modality: request.modality ?? "all", include_history: !!request.include_history,
      include_unverified: !!request.include_unverified, maximum_confidentiality: request.maximum_confidentiality ?? "internal",
      max_per_source: request.max_per_source ?? 2, rerank: request.rerank !== false,
      provider: this.provider ? [this.provider.fingerprint, this.provider.textModel, this.provider.imageModel, this.provider.dimension] : null,
      thresholds: { text: minimumSimilarity("text"), image: minimumSimilarity("image") },
      image_rerank_adjustment: imageRerankAdjustment(),
      record_types: request.record_types ? [...request.record_types].sort() : null,
      record_ids: request.record_ids ? [...request.record_ids].sort() : null,
      preferred_record_ids: request.preferred_record_ids ? [...request.preferred_record_ids].sort() : null,
    }));
  }

  private loadSnapshot(id: string): PageSnapshot | undefined {
    const cached = this.snapshots.get(id);
    if (cached) return cached;
    const row = this.open().prepare("SELECT snapshot_json FROM retrieval_pages WHERE id=?").get(id) as { snapshot_json: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.snapshot_json) as PageSnapshot; } catch { return undefined; }
  }

  private page(snapshot: PageSnapshot, id: string, offset: number, size: number, units: Map<string, EvidenceUnit>): RetrievalResult {
    const slice = snapshot.hits.slice(offset, offset + size);
    // Never return content from a stored snapshot: resolve against this request's authorized corpus.
    if (slice.some(hit => !units.has(hit.id))) throw new Error("Retrieval cursor scope changed; restart the search");
    const next = offset + slice.length;
    const cursor: Cursor = { v: 1, revision: snapshot.revision, scope: snapshot.scope, snapshot: id, offset: next };
    return {
      results: slice.map(hit => ({ unit: units.get(hit.id)!, score: hit.score, channels: hit.channels })),
      revision: snapshot.revision,
      ...(next < snapshot.hits.length ? { next_cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url") } : {}),
      coverage: { ...snapshot.coverage, matched_units: snapshot.hits.length, returned_units: slice.length, has_more: next < snapshot.hits.length },
      warnings: snapshot.warnings, models: snapshot.models,
    };
  }

  async search(corpus: EvidenceCorpus, request: RetrievalRequest): Promise<RetrievalResult> {
    if (!request.query.trim()) throw new Error("Search query must not be empty");
    const db = this.open();
    this.refreshVectorCache();
    // Synchronous through lexical candidate selection, so concurrent requests do
    // not interleave two corpus revisions before FTS candidates are materialized.
    this.synchronizeLexical(corpus);
    const visible = corpus.units.filter(unit => permitted(unit, request) && (!request.modality || request.modality === "all" || request.modality === unit.kind));
    const byId = new Map(visible.map(unit => [unit.id, unit]));
    const scope = this.scope(request), size = Math.max(1, Math.min(100, Math.floor(request.top_k ?? 10)));
    if (request.cursor) {
      let cursor: Cursor;
      try { cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")) as Cursor; }
      catch { throw new Error("Invalid retrieval cursor"); }
      if (cursor.v !== 1 || !Number.isInteger(cursor.offset) || cursor.offset < 0 || cursor.scope !== scope || cursor.revision !== corpus.revision) throw new Error("Retrieval cursor revision or query scope changed; restart the search");
      const snapshot = this.loadSnapshot(cursor.snapshot);
      if (!snapshot || snapshot.scope !== scope || snapshot.revision !== corpus.revision || cursor.offset > snapshot.hits.length) throw new Error("Retrieval cursor expired; restart the search");
      return this.page(snapshot, cursor.snapshot, cursor.offset, size, byId);
    }

    const rankingKey = hash(JSON.stringify([scope, corpus.revision, this.cacheGeneration, size]));
    const cachedRanking = this.rankingCache.get(rankingKey);
    if (cachedRanking && Date.now() - cachedRanking.created < 30_000) return this.page(cachedRanking.snapshot, cachedRanking.id, 0, size, byId);

    const coverage = this.coverage(corpus, request, visible);
    const warnings = new Set<string>();
    // Initialization diagnostics reveal no record identities or inaccessible counts.
    for (const warning of this.syncWarnings) if (warning.includes("index") || warning.includes("cache_unavailable")) warnings.add(warning);
    if ((coverage.missing_documents as string[]).length) warnings.add("visible_documents_unavailable");
    if ((coverage.unparsed_artifacts as string[]).length) warnings.add("visible_artifacts_unparsed");
    if ((coverage.unavailable_images as string[]).length) warnings.add("visible_images_unavailable");
    if ((coverage.unsupported_image_formats as unknown[]).length) warnings.add("unsupported_image_format");
    if (Number(coverage.metadata_only_units) > 0) warnings.add("metadata_only_records_do_not_establish_document_contents");
    const mode = request.mode ?? "hybrid", collect = request.intent === "collect";
    const imageAdjustment = imageRerankAdjustment();
    const candidateLimit = collect ? visible.length : Math.max(100, size * 20);
    const channels: Array<{ name: string; hits: Array<{ id: string; score: number }> }> = [];
    const terms = retrievalTerms(request.query).slice(0, 128);
    if (mode !== "semantic" && terms.length) {
      const where = ["evidence_fts MATCH ?", "u.confidentiality <= ?"];
      const params: (string | number)[] = [terms.map(term => `"${term.replace(/"/g, '""')}"`).join(" OR "), CONFIDENTIALITY[request.maximum_confidentiality ?? "internal"] ?? 1];
      if (request.project_id) { where.push("u.project_id = ?"); params.push(request.project_id); }
      if (request.modality && request.modality !== "all") { where.push("u.kind = ?"); params.push(request.modality); }
      for (const [field, values] of [["record_type", request.record_types], ["record_id", request.record_ids]] as const) if (values) {
        if (values.length === 0) where.push("0");
        else { where.push(`u.${field} IN (${values.map(() => "?").join(",")})`); params.push(...values); }
      }
      where.push("u.record_type <> 'validation_event'");
      if (!request.include_history) where.push(`u.status NOT IN (${[...HISTORICAL].map(value => `'${value}'`).join(",")})`);
      if (!request.include_unverified) {
        where.push(`u.status NOT IN (${[...UNVERIFIED].map(value => `'${value}'`).join(",")})`);
        where.push(request.include_history
          ? `(u.record_type <> 'memory' OR u.status='accepted' OR u.status IN (${[...HISTORICAL].map(value => `'${value}'`).join(",")}))`
          : "(u.record_type <> 'memory' OR u.status='accepted')");
      }
      const rows = db.prepare(`SELECT u.id, bm25(evidence_fts, 0, 3, 1) AS rank FROM evidence_fts JOIN evidence_units u ON u.id=evidence_fts.unit_id WHERE ${where.join(" AND ")} ORDER BY rank, u.id`).all(...params) as Array<{ id: string; rank: number }>;
      const hits = rows.filter(row => byId.has(row.id)).map(row => {
        const unit = byId.get(row.id)!, tokenSet = new Set(retrievalTerms(`${unit.title} ${unit.text}`));
        const overlap = terms.filter(term => tokenSet.has(term)).length / terms.length;
        return { id: row.id, score: overlap, rank: row.rank * sourcePrior(unit) };
      }).filter(row => row.score >= (terms.length >= 4 ? 0.2 : 1 / terms.length))
        .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id)).slice(0, candidateLimit);
      channels.push({ name: "lexical", hits });
    }

    const semanticActive: string[] = [];
    if (mode !== "lexical") {
      if (!this.provider) warnings.add("embedding_provider_unavailable_lexical_only");
      else for (const kind of ["text", "image"] as const) {
        if (kind === "image" && !coverage.image_embedding_complete) warnings.add("image_embedding_incomplete_explicit_synchronize_required");
        const eligible = visible.filter(unit => unit.kind === kind && semanticEligible(unit) && (kind !== "image" || imageEmbeddingSupported(unit)));
        if (!eligible.length) continue;
        const embedded = eligible.filter(unit => this.vector(unit));
        if (embedded.length < eligible.length) warnings.add(`${kind}_embedding_incomplete_explicit_synchronize_required`);
        if (!embedded.length) continue;
        try {
          const queryVector = await this.queryVector(request.query, kind);
          // Do not retain every vector in a second array outside the bounded LRU.
          const hits = embedded.map(unit => ({ id: unit.id, score: cosine(queryVector, this.vector(unit)!) }))
            .filter(hit => hit.score >= minimumSimilarity(kind)).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, candidateLimit);
          channels.push({ name: kind === "text" ? "text_semantic" : "image_semantic", hits });
          semanticActive.push(kind);
        } catch { warnings.add(`${kind}_query_embedding_failed`); }
      }
    }

    const imageVisualActive = semanticActive.includes("image");
    const imageVisualHits = new Map(channels.find(channel => channel.name === "image_semantic")?.hits.map(hit => [hit.id, hit.score]) ?? []);
    const imageVisualScore = (similarity: number): number => {
      const minimum = minimumSimilarity("image");
      // Preserve the visual similarity gap that rank-only RRF would erase.
      // This is a retrieval score, not a calibrated probability of relevance.
      const margin = minimum < 1 ? (similarity - minimum) / (1 - minimum) : 1;
      return (1.15 / 61) * Math.max(Number.EPSILON, Math.min(1, margin));
    };
    if (mode === "hybrid" && visible.some(unit => unit.kind === "image") && !imageVisualActive) warnings.add("image_semantic_unavailable_using_lexical_context");
    const fused = new Map<string, EvidenceHit>();
    for (const channel of channels) channel.hits.forEach((hit, index) => {
      const unit = byId.get(hit.id)!;
      // Nearby OCR and captions describe the page, not necessarily the pixels.
      // Once visual retrieval succeeds, context cannot add a nonvisual image
      // candidate, including when the visual recall set is empty.
      if (unit.kind === "image" && imageVisualActive && !imageVisualHits.has(hit.id)) return;
      const existing = fused.get(hit.id) ?? { unit, score: 0, channels: [] };
      if (unit.kind === "image" && imageVisualActive) {
        const visual = imageVisualScore(imageVisualHits.get(hit.id)!);
        existing.score += channel.name === "image_semantic" ? visual : visual * 0.05 * (61 / (61 + index));
      } else existing.score += (channel.name === "lexical" ? 1 : 1.15) / (60 + index + 1);
      existing.channels.push(channel.name);
      fused.set(hit.id, existing);
    });
    let ranked = [...fused.values()].sort((a, b) => b.score - a.score || a.unit.id.localeCompare(b.unit.id));
    const preferred = new Set(request.preferred_record_ids ?? []);
    ranked.filter(hit => preferred.has(hit.unit.record_id)).forEach((hit, position) => {
      hit.score += hit.unit.kind === "image" && imageVisualActive
        ? imageVisualScore(imageVisualHits.get(hit.unit.id)!) * 0.025 * (61 / (61 + position))
        : 0.15 / (60 + position + 1);
      hit.channels.push("structural");
    });
    ranked.sort((a, b) => b.score - a.score || a.unit.id.localeCompare(b.unit.id));
    let rerankActive = false;
    if (request.rerank !== false && this.provider?.rerank && ranked.length) {
      const candidates = diversify(ranked, Math.max(1, Math.floor(request.max_per_source ?? 2)))
        .slice(0, Math.min(100, Math.max(30, size * 4)));
      const safe = candidates.filter(hit => (CONFIDENTIALITY[hit.unit.confidentiality] ?? 99) <= 1);
      if (safe.length !== candidates.length) warnings.add("restricted_evidence_excluded_from_external_reranking");
      const texts = safe.filter(hit => hit.unit.kind === "text").slice(0, 64);
      const images = safe.filter(hit => hit.unit.kind === "image" && imageEmbeddingSupported(hit.unit)).slice(0, 24);
      // The provider owns pixel batching. Its scores identify request-local
      // ranks, not comparable confidence across modalities or image batches.
      const batch = [...texts, ...images];
      if (batch.length) try {
          const scores = await this.provider.rerank(request.query, batch.map(hit => hit.unit));
          const valid = scores.filter(item => Number.isInteger(item.index) && item.index >= 0 && item.index < batch.length && Number.isFinite(item.score)).sort((a, b) => b.score - a.score);
          const unique = new Map<number, number>();
          for (const item of valid) if (!unique.has(item.index)) unique.set(item.index, item.score);
          const textRanks = [...unique].filter(([index]) => index < texts.length);
          for (const [position, [index]] of textRanks.entries()) {
            batch[index]!.score += 1 / (60 + position + 1);
            batch[index]!.channels.push("rerank");
          }
          for (let start = texts.length; start < batch.length; start += IMAGE_RERANK_GROUP_SIZE) {
            const group = [...unique].filter(([index]) => index >= start && index < start + IMAGE_RERANK_GROUP_SIZE);
            for (let position = 0; position < group.length; position++) {
              const [index, score] = group[position]!;
              const firstTie = group.findIndex(item => item[1] === score);
              let lastTie = position;
              while (lastTie + 1 < group.length && group[lastTie + 1]![1] === score) lastTie++;
              const averageRank = (firstTie + lastTie) / 2;
              // A low-ranked image must be demoted. Near-uniform positive RRF
              // bonuses cannot correct a strong but misleading OCR match.
              const adjustment = group.length > 1 ? 1 - 2 * averageRank / (group.length - 1) : 0;
              batch[index]!.score *= 1 + imageAdjustment * adjustment;
              batch[index]!.channels.push("rerank");
            }
          }
          rerankActive ||= unique.size > 0;
        } catch { warnings.add("rerank_failed_using_fused_ranking"); }
      ranked.sort((a, b) => b.score - a.score || a.unit.id.localeCompare(b.unit.id));
    }
    ranked.forEach(hit => { hit.score *= sourcePrior(hit.unit); });
    ranked.sort((a, b) => b.score - a.score || a.unit.id.localeCompare(b.unit.id));
    // Exact-content duplicates and comparable same-source hits are postponed,
    // never discarded from the current recall set.
    ranked = diversify(ranked, Math.max(1, Math.floor(request.max_per_source ?? 2)));
    const models: Record<string, unknown> = {
      lexical: "sqlite-fts5-chinese-bigram", fusion: "text-rrf-k60-image-visual-margin", semantic_active: semanticActive,
      text_model: this.provider?.textModel ?? null, image_model: this.provider?.imageModel ?? null,
      provider_fingerprint: this.provider?.fingerprint ?? null, rerank_active: rerankActive,
      minimum_cosine: { text: minimumSimilarity("text"), image: minimumSimilarity("image") },
      source_prior: { parsed_artifact: 1.12, knowledge_section: 1.06, accepted_memory: 1.04, task_event: 0.75, metadata_only: 0.45, other: 1 },
      lexical_only_record_types: [...LEXICAL_ONLY_TYPES],
      diversity: { max_per_source_per_round: Math.max(1, Math.floor(request.max_per_source ?? 2)), source_score_band_min_ratio: SOURCE_DIVERSITY_SCORE_RATIO, max_per_exact_content_per_round: 1, deferred_duplicates_retained: true },
      rrf_weights: { lexical: 1, text_semantic: 1.15, text_structural: 0.15, text_rerank: 1 },
      image_fusion: { visual_active: imageVisualActive, visual_candidate_gate: imageVisualActive, visual_score: "cosine_margin_above_minimum", context_bonus_max_ratio: 0.05, structural_bonus_max_ratio: 0.025, calibrated_relevance_probability: false },
      rerank_limits: { text_candidates: 64, image_candidates: 24, image_batch_owner: "provider", image_comparison_group_size: IMAGE_RERANK_GROUP_SIZE, image_adjustment_max_ratio: imageAdjustment, scoring: "text_rrf_and_image_group_local_signed_adjustment" },
    };
    if (!collect && channels.some(channel => channel.hits.length === candidateLimit)) warnings.add("answer_candidate_window_limited_use_collect_for_exhaustive_retrieval");
    const snapshot: PageSnapshot = { revision: corpus.revision, scope, hits: ranked.map(hit => ({ id: hit.unit.id, score: hit.score, channels: hit.channels })), coverage: { ...coverage, retrieval_scope: collect ? "complete_current_recall_set" : "ranked_candidate_window", fact_completeness: "not_proven" }, warnings: [...warnings], models };
    const id = randomUUID();
    this.snapshots.set(id, snapshot);
    if (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.keys().next().value!);
    db.prepare("INSERT INTO retrieval_pages VALUES (?,?,?)").run(id, Date.now(), JSON.stringify(snapshot));
    db.prepare("DELETE FROM retrieval_pages WHERE id NOT IN (SELECT id FROM retrieval_pages ORDER BY created_at DESC LIMIT 100)").run();
    if (![...warnings].some(warning => warning.includes("_failed"))) {
      this.rankingCache.set(rankingKey, { id, snapshot, created: Date.now() });
      while (this.rankingCache.size > 32) this.rankingCache.delete(this.rankingCache.keys().next().value!);
    }
    return this.page(snapshot, id, 0, size, byId);
  }

  close(): void { this.db?.close(); this.persistedCache?.close(); this.db = undefined; this.persistedCache = undefined; this.revision = undefined; this.snapshots.clear(); this.rankingCache.clear(); this.vectors.clear(); this.vectorBytes = 0; this.queryVectors.clear(); this.queryInflight.clear(); this.cacheGeneration = undefined; }
}
