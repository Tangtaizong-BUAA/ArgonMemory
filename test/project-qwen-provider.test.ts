import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createQwenRetrievalProvider, VISUAL_RERANK_INSTRUCTION } from "../src/project/retrieval/qwen-provider.js";
import type { AlibabaRequestAudit } from "../src/project/multimodal/alibaba-client.js";
import type { EvidenceUnit } from "../src/project/retrieval/types.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const image = "data:image/png;base64,aW1hZ2U=";
const unit = (id: string, kind: "text" | "image" = "text", extra: Partial<EvidenceUnit> = {}): EvidenceUnit => ({
  id, record_id: id, project_id: "p", title: id, record_type: "artifact", status: "parsed", confidentiality: "internal",
  kind, text: `passage ${id}`, content_hash: id, source_revision: "r", uri: `kb://record/${id}`, locator: {}, source_refs: [], ...extra,
});

describe("Qwen retrieval provider", () => {
  test("missing credentials disable the provider without calling an API", () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "");
    expect(createQwenRetrievalProvider()).toBeUndefined();
  });

  test("fingerprint binds models, endpoints and dimension but is independent of credentials", () => {
    const base = createQwenRetrievalProvider({ apiKey: "key-one" })!;
    expect(base.textModel).toBe("qwen3.7-text-embedding");
    expect(base.imageModel).toBe("qwen3-vl-embedding");
    expect(base.dimension).toBe(1024);
    expect(base.fingerprint).toBe(createQwenRetrievalProvider({ apiKey: "key-two" })!.fingerprint);
    for (const override of [{ dimension: 512 }, { textModel: "configured-text-model" }, { imageModel: "configured-image-model" }, { textEmbeddingUrl: "https://workspace.example/embeddings" }, { textRerankModel: "configured-rerank" }]) {
      expect(createQwenRetrievalProvider({ apiKey: "key-one", ...override })!.fingerprint).not.toBe(base.fingerprint);
    }
    expect(base.fingerprint).not.toContain("key-one");
    vi.stubEnv("ARGON_MEMORY_TEXT_EMBEDDING_URL", "https://workspace.example/embeddings");
    expect(createQwenRetrievalProvider({ apiKey: "key-one" })!.fingerprint).not.toBe(base.fingerprint);
  });

  test("batches text at 20, restores unordered indices, uses documented OpenAI request, and audits metadata only", async () => {
    const audits: AlibabaRequestAudit[] = [];
    const calls: Record<string, any>[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(String(init?.body)); calls.push(body);
      expect(body).toMatchObject({ model: "qwen3.7-text-embedding", dimensions: 2, encoding_format: "float" });
      expect(body).not.toHaveProperty("text_type");
      expect(String(init?.body)).not.toContain("secret-key");
      return json({ data: body.input.map((text: string, index: number) => ({ index, embedding: [Number(text.slice(1)), 0.5] })).reverse(), id: "req-1", usage: { total_tokens: 12, prompt: "DO-NOT-LOG" } });
    });
    const provider = createQwenRetrievalProvider({ apiKey: "secret-key", dimension: 2, fetchImpl: fetchImpl as typeof fetch, audit: event => { audits.push(event); } })!;
    const result = await provider.embedText(Array.from({ length: 21 }, (_, index) => `t${index}`), "document");
    expect(calls.map(call => call.input.length)).toEqual([20, 1]);
    expect(result.map(vector => vector[0])).toEqual(Array.from({ length: 21 }, (_, index) => index));
    expect(audits[0]).toMatchObject({ operation: "text_embedding", purpose: "document", request_id: "req-1", usage: { total_tokens: 12 } });
    expect(JSON.stringify(audits)).not.toContain("DO-NOT-LOG");
    expect(JSON.stringify(audits)).not.toContain("secret-key");
  });

  test("embeds images in batches of 10 and uses the same visual model for text-to-image queries", async () => {
    const bodies: Record<string, any>[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      return json({ output: { embeddings: body.input.contents.map((_value: unknown, index: number) => ({ index, embedding: [1, index] })).reverse() } });
    });
    const provider = createQwenRetrievalProvider({ apiKey: "key", dimension: 2, fetchImpl: fetchImpl as typeof fetch })!;
    expect(await provider.embedImages(Array.from({ length: 11 }, () => image))).toHaveLength(11);
    expect(await provider.embedImageQuery("烽火台的照片")).toEqual([1, 0]);
    expect(bodies.map(body => body.input.contents.length)).toEqual([10, 1, 1]);
    expect(bodies[0]).toMatchObject({ model: "qwen3-vl-embedding", parameters: { dimension: 2 } });
    expect(bodies[0]?.input.contents).toEqual(Array.from({ length: 10 }, () => ({ image })));
    expect(bodies[2]?.input.contents).toEqual([{ text: "烽火台的照片" }]);
    await expect(provider.embedImages(["https://example.test/image.png"])).rejects.toThrow("data URIs");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test.each([
    [], [{ index: 0, embedding: [1, 2] }],
    [{ index: 0, embedding: [1, 2] }, { index: 0, embedding: [3, 4] }],
    [{ index: 0, embedding: [1, 2] }, { index: 2, embedding: [3, 4] }],
    [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [3] }],
    [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [null, 4] }],
  ].map(rows => [rows]))("rejects incomplete or corrupt vector responses %#", async rows => {
    const fetchImpl = vi.fn(async () => json({ data: rows }));
    const provider = createQwenRetrievalProvider({ apiKey: "key", dimension: 2, fetchImpl: fetchImpl as typeof fetch })!;
    await expect(provider.embedText(["one", "two"], "query")).rejects.toThrow("validation");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("retries 429/5xx only, keeps the same latest model, and never prints error bodies or transport details", async () => {
    const models: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      models.push(JSON.parse(String(init?.body)).model);
      return models.length === 1 ? json({ message: "secret-key private-content" }, 429) : json({ data: [{ index: 0, embedding: [1, 2] }] });
    });
    const provider = createQwenRetrievalProvider({ apiKey: "secret-key", dimension: 2, fetchImpl: fetchImpl as typeof fetch })!;
    await expect(provider.embedText(["private-content"], "query")).resolves.toEqual([[1, 2]]);
    expect(models).toEqual(["qwen3.7-text-embedding", "qwen3.7-text-embedding"]);
    const rejected = vi.fn(async () => json({ message: "secret-key private-content" }, 401));
    const failing = createQwenRetrievalProvider({ apiKey: "secret-key", fetchImpl: rejected as typeof fetch })!;
    await expect(failing.embedText(["private-content"], "query")).rejects.toThrow("HTTP 401");
    expect(rejected).toHaveBeenCalledTimes(1);
    const transport = createQwenRetrievalProvider({ apiKey: "secret-key", fetchImpl: (async () => { throw new Error("secret-key private-content"); }) as typeof fetch })!;
    await expect(transport.embedText(["private-content"], "query")).rejects.toThrow(/^Alibaba request failed or timed out$/);
  });

  test("caps retries and the timeout budget", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn(async () => json({ message: "private" }, 503));
    const provider = createQwenRetrievalProvider({ apiKey: "key", maxRetries: 100, timeoutMs: 120_000, fetchImpl: fetchImpl as typeof fetch })!;
    await expect(provider.embedText(["text"], "query")).rejects.toThrow(/^Alibaba request failed: HTTP 503$/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [ms] of timeoutSpy.mock.calls) expect(ms).toBeLessThanOrEqual(60_000);
  });

  test("reranks text and local image bytes separately and returns original indices with within-request rank scores", async () => {
    const root = await mkdtemp(join(tmpdir(), "argon-memory-qwen-")); roots.push(root);
    const imagePath = join(root, "synthetic.png"); const bytes = Buffer.from("image"); await writeFile(imagePath, bytes);
    const bodies: Record<string, any>[] = []; const audits: AlibabaRequestAudit[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      return json({ output: { results: body.input.documents.map((_doc: unknown, index: number) => ({ index, relevance_score: body.model === "qwen3.7-text-rerank" ? 0.1 + index * 0.1 : 0.99 })) }, request_id: "req-rank" });
    });
    const provider = createQwenRetrievalProvider({ apiKey: "key", fetchImpl: fetchImpl as typeof fetch, audit: event => { audits.push(event); } })!;
    const results = await provider.rerank!("长城", [unit("t1"), unit("i", "image", { image_path: imagePath, image_sha256: createHash("sha256").update(bytes).digest("hex") }), unit("t2")]);
    expect(bodies[0]).toMatchObject({ model: "qwen3.7-text-rerank", input: { query: "长城", documents: ["passage t1", "passage t2"] }, parameters: { top_n: 2 } });
    expect(bodies[0]!.parameters).not.toHaveProperty("instruct");
    expect(bodies[1]).toMatchObject({ model: "qwen3-vl-rerank", input: { query: { text: "长城" }, documents: [{ image }] }, parameters: { top_n: 1, return_documents: false, instruct: VISUAL_RERANK_INSTRUCTION } });
    expect(results).toEqual([{ index: 1, score: 1 / 61 }, { index: 2, score: 1 / 61 }, { index: 0, score: 1 / 62 }]);
    expect(audits.map(event => [event.group, event.input_count])).toEqual([["text", 2], ["image", 1]]);
    expect(JSON.stringify(audits)).not.toContain(imagePath);
    await expect(provider.rerank!("长城", [unit("remote", "image", { image_path: "https://example.test/image.png" })])).rejects.toThrow("local image_path");
    await expect(provider.rerank!("长城", [unit("changed", "image", { image_path: imagePath, image_sha256: "incorrect" })])).rejects.toThrow("integrity");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("sends one generic visual-intent instruction for photo, diagram and illustration queries without rewriting the query", async () => {
    const root = await mkdtemp(join(tmpdir(), "argon-memory-qwen-")); roots.push(root);
    const imagePath = join(root, "synthetic.png"); await writeFile(imagePath, "image");
    const queries = ["雨后山谷的实景照片", "比较两组实验结果的柱状图", "描绘海洋动物的水彩插画", "交通图标中的文字", "古建筑"];
    const bodies: Record<string, any>[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      return json({ output: { results: [{ index: 0, relevance_score: 0.8 }] } });
    });
    const provider = createQwenRetrievalProvider({ apiKey: "key", fetchImpl: fetchImpl as typeof fetch })!;
    for (const query of queries) await provider.rerank!(query, [unit("image", "image", { image_path: imagePath })]);
    expect(bodies.map(body => body.input.query.text)).toEqual(queries);
    expect(bodies.every(body => body.model === "qwen3-vl-rerank" && body.parameters.instruct === VISUAL_RERANK_INSTRUCTION)).toBe(true);
    expect(new Set(bodies.map(body => body.parameters.instruct)).size).toBe(1);
    // These are request-contract checks, not evidence of improved visual accuracy.
    expect(VISUAL_RERANK_INSTRUCTION).toContain("charts, diagrams, illustrations, icons");
    expect(VISUAL_RERANK_INSTRUCTION).toContain("without automatically preferring photographs");
    expect(VISUAL_RERANK_INSTRUCTION).toContain("text-only card");
    expect(queries.every(query => !VISUAL_RERANK_INSTRUCTION.includes(query))).toBe(true);
  });

  test("rejects missing rerank indices and caps candidate count without an API call", async () => {
    const fetchImpl = vi.fn(async () => json({ output: { results: [{ index: 0, relevance_score: 0.9 }] } }));
    const provider = createQwenRetrievalProvider({ apiKey: "key", fetchImpl: fetchImpl as typeof fetch })!;
    await expect(provider.rerank!("query", [unit("a"), unit("b")])).rejects.toThrow("validation");
    await expect(provider.rerank!("query", Array.from({ length: 101 }, (_, index) => unit(String(index))))).rejects.toThrow("100");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("bounds visual reranking to four images per request and rejects duplicate returned indices", async () => {
    const root = await mkdtemp(join(tmpdir(), "argon-memory-qwen-")); roots.push(root);
    const imagePath = join(root, "synthetic.png"); await writeFile(imagePath, "image");
    const counts: number[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); counts.push(body.input.documents.length);
      return json({ output: { results: body.input.documents.map((_doc: unknown, index: number) => ({ index, relevance_score: 1 / (index + 1) })) } });
    });
    const provider = createQwenRetrievalProvider({ apiKey: "key", fetchImpl: fetchImpl as typeof fetch })!;
    const results = await provider.rerank!("query", Array.from({ length: 41 }, (_, index) => unit(String(index), "image", { image_path: imagePath })));
    expect(counts).toEqual([...Array.from({ length: 10 }, () => 4), 1]);
    expect(new Set(results.map(row => row.index)).size).toBe(41);
    const bad = createQwenRetrievalProvider({ apiKey: "key", fetchImpl: (async () => json({ output: { results: [{ index: 0, relevance_score: 0.5 }, { index: 0, relevance_score: 0.2 }] } })) as typeof fetch })!;
    await expect(bad.rerank!("query", [unit("one"), unit("two")])).rejects.toThrow("validation");
  });

  test("rejects endpoint-embedded credentials without echoing them", () => {
    expect(() => createQwenRetrievalProvider({ apiKey: "key", textEmbeddingUrl: "https://example.test/embeddings?key=secret-key" })).toThrow(/^Alibaba endpoint must be HTTPS without credentials or query parameters$/);
  });
});
