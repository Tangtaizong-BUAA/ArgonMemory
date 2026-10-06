import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import {
  buildMultimodalEmbeddingRequest, DEFAULT_MULTIMODAL_EMBEDDING_MODEL, DEFAULT_MULTIMODAL_RERANK_MODEL,
  postAlibabaJson, validateAlibabaEndpoint, validateIndexedVectors,
  type AlibabaRequestOptions,
} from "../multimodal/alibaba-client.js";
import type { EvidenceUnit, RetrievalProvider } from "./types.js";

export const DEFAULT_TEXT_EMBEDDING_MODEL = "qwen3.7-text-embedding";
export const DEFAULT_TEXT_RERANK_MODEL = "qwen3.7-text-rerank";
export const VISUAL_RERANK_INSTRUCTION = "Rank images by visual relevance to the query, considering the requested subject, scene, relationships, and medium. "
  + "Respect explicit or clearly implied medium requirements. For photographs or real-world scene evidence, prioritize visible depictions of the requested scene; "
  + "a silhouette, icon, illustration, or text-only card mentioning the same topic is not equivalent to a photograph. "
  + "For queries requesting charts, diagrams, illustrations, icons, or text within images, prioritize that requested format and its relevant visible information. "
  + "If the medium is unspecified, assess visual fit without automatically preferring photographs. Judge collages by the visible content and composition required by the query. "
  + "Captions and embedded words may support a match, but cannot substitute for missing visual subjects or scene relationships. "
  + "Do not infer identities, events, or details that are not visible.";
const HOST = "https://dashscope.aliyuncs.com";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export type QwenRetrievalOptions = Partial<AlibabaRequestOptions> & {
  dimension?: number; textModel?: string; imageModel?: string; textRerankModel?: string; imageRerankModel?: string;
  textEmbeddingUrl?: string; imageEmbeddingUrl?: string; textRerankUrl?: string; imageRerankUrl?: string;
};

function imageDataUri(value: string): string {
  const match = /^data:image\/(?:png|jpeg|jpg|webp|bmp|tiff|x-icon|vnd\.microsoft\.icon|icns|sgi);base64,([a-zA-Z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[1]!.length % 4 !== 0 || Buffer.byteLength(match[1]!, "base64") > MAX_IMAGE_BYTES) throw new Error("Images must be valid base64 image data URIs within 10 MiB");
  return value;
}

async function localImage(unit: EvidenceUnit): Promise<string> {
  if (!unit.image_path || /^[a-z][a-z0-9+.-]*:/i.test(unit.image_path)) throw new Error("Image reranking requires a local image_path");
  try {
    const info = await stat(unit.image_path);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) throw new Error();
    const bytes = await readFile(unit.image_path);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error();
    if (unit.image_sha256 && createHash("sha256").update(bytes).digest("hex") !== unit.image_sha256) throw new Error();
    const mime = unit.image_mime ?? ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".bmp": "image/bmp", ".tiff": "image/tiff", ".tif": "image/tiff" } as Record<string, string>)[extname(unit.image_path).toLowerCase()];
    return imageDataUri(`data:${mime};base64,${bytes.toString("base64")}`);
  } catch { throw new Error("Local image is unavailable, unsupported, too large, or failed integrity validation"); }
}

function rankRows(rows: unknown, count: number): Array<{ index: number; score: number }> {
  if (!Array.isArray(rows) || rows.length !== count) throw new Error("Rerank count mismatch");
  const seen = new Set<number>();
  const scores = rows.map(row => {
    if (!Number.isInteger(row?.index) || row.index < 0 || row.index >= count || seen.has(row.index)
      || typeof row.relevance_score !== "number" || !Number.isFinite(row.relevance_score) || row.relevance_score < 0 || row.relevance_score > 1) throw new Error("Invalid rerank row");
    seen.add(row.index);
    return { index: row.index as number, score: row.relevance_score as number };
  });
  // Vendor relevance scores cannot be compared across models or requests.
  return scores.sort((a, b) => b.score - a.score || a.index - b.index).map((row, rank) => ({ index: row.index, score: 1 / (60 + rank + 1) }));
}

/** Latest text/visual models stay distinct; missing credentials disable the provider explicitly. */
export function createQwenRetrievalProvider(options: QwenRetrievalOptions = {}): RetrievalProvider | undefined {
  const apiKey = (options.apiKey ?? process.env.DASHSCOPE_API_KEY)?.trim();
  if (!apiKey) return undefined;
  const dimension = options.dimension ?? Number(process.env.ARGON_MEMORY_EMBEDDING_DIMENSION ?? 1024);
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > 4096) throw new Error("Invalid embedding dimension");
  const textModel = options.textModel ?? process.env.ARGON_MEMORY_TEXT_EMBEDDING_MODEL ?? DEFAULT_TEXT_EMBEDDING_MODEL;
  const imageModel = options.imageModel ?? process.env.ARGON_MEMORY_IMAGE_EMBEDDING_MODEL ?? DEFAULT_MULTIMODAL_EMBEDDING_MODEL;
  const textRerankModel = options.textRerankModel ?? process.env.ARGON_MEMORY_TEXT_RERANK_MODEL ?? DEFAULT_TEXT_RERANK_MODEL;
  const imageRerankModel = options.imageRerankModel ?? process.env.ARGON_MEMORY_IMAGE_RERANK_MODEL ?? DEFAULT_MULTIMODAL_RERANK_MODEL;
  const textEmbeddingUrl = validateAlibabaEndpoint(options.textEmbeddingUrl ?? process.env.ARGON_MEMORY_TEXT_EMBEDDING_URL ?? `${HOST}/compatible-mode/v1/embeddings`);
  const imageEmbeddingUrl = validateAlibabaEndpoint(options.imageEmbeddingUrl ?? process.env.ARGON_MEMORY_IMAGE_EMBEDDING_URL ?? process.env.DASHSCOPE_MULTIMODAL_EMBEDDING_URL ?? `${HOST}/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding`);
  const textRerankUrl = validateAlibabaEndpoint(options.textRerankUrl ?? process.env.ARGON_MEMORY_TEXT_RERANK_URL ?? `${HOST}/api/v1/services/rerank/text-rerank/text-rerank`);
  const imageRerankUrl = validateAlibabaEndpoint(options.imageRerankUrl ?? process.env.ARGON_MEMORY_IMAGE_RERANK_URL ?? `${HOST}/api/v1/services/rerank/text-rerank/text-rerank`);
  const requestOptions = { apiKey, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs, maxRetries: options.maxRetries, audit: options.audit };
  // The visual instruction is a per-request ranking policy, not an embedding
  // change. The ranking cache is process-local and resets on service restart;
  // keep this policy out of the shared fingerprint to reuse existing vectors.
  const fingerprint = `qwen-retrieval-v1:${createHash("sha256").update(JSON.stringify({
    textModel, imageModel, dimension, textEmbeddingUrl, imageEmbeddingUrl, textRerankModel, imageRerankModel, textRerankUrl, imageRerankUrl,
    text_purpose: "openai-symmetric-raw-v1", image_purpose: "independent-document-and-text-query-v1", encoding: "float", normalization: "provider-raw", rerank: "request-local-rrf-60-v1",
  })).digest("hex")}`;
  return {
    fingerprint, textModel, imageModel, dimension,
    async embedText(texts, purpose) {
      if (texts.some(text => typeof text !== "string" || !text.trim())) throw new Error("Embedding text cannot be empty");
      const vectors: number[][] = [];
      const batchSize = /^text-embedding-v[34]$/.test(textModel) ? 10 : 20;
      for (let offset = 0; offset < texts.length; offset += batchSize) {
        const batch = texts.slice(offset, offset + batchSize);
        // OpenAI compatibility does not document DashScope's text_type/instruct parameters.
        const result = await postAlibabaJson(textEmbeddingUrl, { model: textModel, input: batch, dimensions: dimension, encoding_format: "float" }, requestOptions,
          { operation: "text_embedding", model: textModel, input_count: batch.length, purpose, group: "text" },
          response => validateIndexedVectors(response.data, batch.length, dimension));
        vectors.push(...result.value);
      }
      return vectors;
    },
    async embedImages(images) {
      const validated = images.map(imageDataUri);
      const vectors: number[][] = [];
      for (let offset = 0; offset < validated.length; offset += 10) {
        const batch = validated.slice(offset, offset + 10);
        const result = await postAlibabaJson(imageEmbeddingUrl, buildMultimodalEmbeddingRequest(batch.map(image => ({ type: "image", image })), imageModel, dimension), requestOptions,
          { operation: "image_embedding", model: imageModel, input_count: batch.length, purpose: "document", group: "image" },
          response => validateIndexedVectors((response.output as { embeddings?: unknown } | undefined)?.embeddings, batch.length, dimension));
        vectors.push(...result.value);
      }
      return vectors;
    },
    async embedImageQuery(query) {
      if (!query.trim()) throw new Error("Embedding query cannot be empty");
      const result = await postAlibabaJson(imageEmbeddingUrl, buildMultimodalEmbeddingRequest([{ type: "text", text: query }], imageModel, dimension), requestOptions,
        { operation: "image_query_embedding", model: imageModel, input_count: 1, purpose: "query", group: "image" },
        response => validateIndexedVectors((response.output as { embeddings?: unknown } | undefined)?.embeddings, 1, dimension));
      return result.value[0]!;
    },
    async rerank(query, units) {
      if (!query.trim()) throw new Error("Rerank query cannot be empty");
      if (units.length > 100) throw new Error("Reranking accepts at most 100 candidates");
      const ranked: Array<{ index: number; score: number }> = [];
      for (const kind of ["text", "image"] as const) {
        const selected = units.map((unit, index) => ({ unit, index })).filter(item => item.unit.kind === kind);
        // A 40-image vendor maximum can exceed the query service's memory budget
        // after binary buffers, base64 and JSON copies. Bound local concurrency.
        const batchSize = kind === "image" ? 4 : 100;
        for (let offset = 0; offset < selected.length; offset += batchSize) {
          const batch = selected.slice(offset, offset + batchSize);
          const documents = kind === "image" ? await Promise.all(batch.map(async ({ unit }) => ({ image: await localImage(unit) }))) : batch.map(({ unit }) => unit.text);
          const model = kind === "image" ? imageRerankModel : textRerankModel;
          const result = await postAlibabaJson(kind === "image" ? imageRerankUrl : textRerankUrl, {
            model, input: { query: kind === "image" ? { text: query } : query, documents },
            parameters: { top_n: batch.length, ...(kind === "image" ? { return_documents: false, instruct: VISUAL_RERANK_INSTRUCTION } : {}) },
          }, requestOptions, { operation: "rerank", model, input_count: batch.length, group: kind },
          response => rankRows((response.output as { results?: unknown } | undefined)?.results, batch.length));
          ranked.push(...result.value.map(row => ({ index: batch[row.index]!.index, score: row.score })));
        }
      }
      return ranked.sort((a, b) => b.score - a.score || a.index - b.index);
    },
  };
}
