export const DEFAULT_MULTIMODAL_EMBEDDING_MODEL = "qwen3-vl-embedding";
export const DEFAULT_MULTIMODAL_RERANK_MODEL = "qwen3-vl-rerank";

export type MultimodalInput =
  | { type: "text"; text: string }
  | { type: "image"; image: string }
  | { type: "video"; video: string; fps?: number };

export type AlibabaRequestAudit = {
  operation: string; model: string; endpoint_origin: string; input_count: number;
  attempt: number; status: "succeeded" | "http_error" | "transport_error" | "invalid_response";
  http_status?: number; request_id?: string; usage?: Record<string, unknown>;
  purpose?: "query" | "document"; group?: "text" | "image";
};
export type AlibabaRequestOptions = {
  apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxRetries?: number;
  audit?: (event: AlibabaRequestAudit) => void | Promise<void>;
};
export type AlibabaMultimodalOptions = Partial<AlibabaRequestOptions> & {
  baseUrl?: string; model?: string; dimension?: number;
};

/** Endpoints cannot carry credentials; errors and audit records never include payloads. */
export function validateAlibabaEndpoint(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("Invalid Alibaba endpoint"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Alibaba endpoint must be HTTPS without credentials or query parameters");
  return url.toString();
}

function safeUsage(input: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input) || depth > 2) return undefined;
  const usage: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^(?:total_tokens|prompt_tokens|input_tokens|output_tokens|image_tokens|video_tokens|text_tokens|cached_tokens|image_count|duration|input_tokens_details|prompt_tokens_details)$/.test(key)) continue;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[key] = value;
    else { const nested = safeUsage(value, depth + 1); if (nested && Object.keys(nested).length) usage[key] = nested; }
  }
  return Object.keys(usage).length ? usage : undefined;
}

export function alibabaResponseMetadata(input: Record<string, unknown>, apiKey: string): { request_id?: string; usage?: Record<string, unknown> } {
  const id = input.request_id ?? input.id;
  return {
    request_id: typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id) && !id.includes(apiKey) ? id : undefined,
    usage: safeUsage(input.usage),
  };
}

/** One logical request has a <=60 second deadline, including bounded 429/5xx retries. */
export async function postAlibabaJson<T>(
  endpoint: string, body: Record<string, unknown>, options: AlibabaRequestOptions,
  context: Pick<AlibabaRequestAudit, "operation" | "model" | "input_count" | "purpose" | "group">,
  parse: (body: Record<string, unknown>) => T,
): Promise<{ value: T; request_id?: string; usage?: Record<string, unknown> }> {
  const url = validateAlibabaEndpoint(endpoint);
  const timeout = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(Math.floor(options.timeoutMs!), 60_000)) : 30_000;
  const retries = Number.isFinite(options.maxRetries) ? Math.max(0, Math.min(Math.floor(options.maxRetries!), 2)) : 2;
  const deadline = Date.now() + timeout;
  const emit = async (event: Omit<AlibabaRequestAudit, keyof typeof context | "endpoint_origin">) => {
    try { await options.audit?.({ ...context, endpoint_origin: new URL(url).origin, ...event }); } catch { /* telemetry must not change retrieval */ }
  };
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(url, {
        method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
    } catch {
      await emit({ attempt: attempt + 1, status: "transport_error" });
      throw new Error("Alibaba request failed or timed out");
    }
    if (!response.ok) {
      await emit({ attempt: attempt + 1, status: "http_error", http_status: response.status });
      await response.body?.cancel().catch(() => undefined);
      const delay = 100 * 2 ** attempt;
      if ((response.status === 429 || response.status >= 500) && attempt < retries && Date.now() + delay < deadline) {
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw new Error(`Alibaba request failed: HTTP ${response.status}`);
    }
    let value: T; let metadata: ReturnType<typeof alibabaResponseMetadata>;
    try {
      const json: unknown = await response.json();
      if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error();
      const result = json as Record<string, unknown>;
      value = parse(result);
      metadata = alibabaResponseMetadata(result, options.apiKey);
    } catch {
      await emit({ attempt: attempt + 1, status: "invalid_response", http_status: response.status });
      throw new Error("Alibaba response failed validation");
    }
    await emit({ attempt: attempt + 1, status: "succeeded", http_status: response.status, ...metadata });
    return { value, ...metadata };
  }
  throw new Error("Alibaba retry budget exhausted");
}

export function validateIndexedVectors(rows: unknown, count: number, dimension: number): number[][] {
  if (!Array.isArray(rows) || rows.length !== count) throw new Error("Embedding count mismatch");
  const vectors: number[][] = new Array(count);
  for (const row of rows) {
    const index: unknown = row?.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= count || vectors[index]) throw new Error("Embedding indices must be unique and complete");
    const vector: unknown = row?.embedding;
    if (!Array.isArray(vector) || vector.length !== dimension || vector.some(value => typeof value !== "number" || !Number.isFinite(value))) throw new Error("Embedding dimension or value mismatch");
    vectors[index] = vector;
  }
  return vectors;
}

export function buildMultimodalEmbeddingRequest(inputs: MultimodalInput[], model = DEFAULT_MULTIMODAL_EMBEDDING_MODEL, dimension = 1024): Record<string, unknown> {
  if (inputs.length === 0 || inputs.length > 20) throw new Error("Multimodal embedding accepts 1-20 inputs");
  if (inputs.filter(input => input.type === "image").length > 10 || inputs.filter(input => input.type === "video").length > 1) throw new Error("Multimodal embedding accepts at most 10 images and 1 video");
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > 4096) throw new Error("Invalid embedding dimension");
  return {
    model,
    input: { contents: inputs.map(input => {
      if (input.type === "text") return { text: input.text };
      if (input.type === "image") return { image: input.image };
      return { video: input.video, ...(input.fps ? { fps: input.fps } : {}) };
    }) },
    parameters: { dimension },
  };
}

export class AlibabaMultimodalEmbeddingClient {
  readonly options: Required<Pick<AlibabaMultimodalOptions, "baseUrl" | "model" | "dimension" | "fetchImpl">> & AlibabaMultimodalOptions;

  constructor(options: AlibabaMultimodalOptions = {}) {
    this.options = {
      ...options,
      apiKey: options.apiKey ?? process.env.DASHSCOPE_API_KEY,
      baseUrl: validateAlibabaEndpoint(options.baseUrl ?? process.env.DASHSCOPE_MULTIMODAL_EMBEDDING_URL ?? "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding"),
      model: options.model ?? DEFAULT_MULTIMODAL_EMBEDDING_MODEL,
      dimension: options.dimension ?? 1024,
      fetchImpl: options.fetchImpl ?? fetch,
    };
  }

  async embed(inputs: MultimodalInput[]): Promise<{ vectors: number[][]; request_id?: string; usage?: Record<string, unknown> }> {
    if (!this.options.apiKey) throw new Error("DASHSCOPE_API_KEY is required for embedding");
    const body = buildMultimodalEmbeddingRequest(inputs, this.options.model, this.options.dimension);
    const { value, ...metadata } = await postAlibabaJson(this.options.baseUrl, body, { ...this.options, apiKey: this.options.apiKey }, {
      operation: "multimodal_embedding", model: this.options.model, input_count: inputs.length,
    }, result => validateIndexedVectors((result.output as { embeddings?: unknown } | undefined)?.embeddings, inputs.length, this.options.dimension));
    return { vectors: value, ...metadata };
  }
}
