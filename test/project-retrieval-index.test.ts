import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { ProjectRetrievalIndex } from "../src/project/retrieval/index.js";
import type { EvidenceCorpus, EvidenceUnit, RetrievalProvider } from "../src/project/retrieval/types.js";

const roots: string[] = [];
const indexes: ProjectRetrievalIndex[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const index of indexes.splice(0)) index.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function make(provider?: RetrievalProvider, root?: string, readOnly = false) {
  root ??= await mkdtemp(join(tmpdir(), "argon-memory-retrieval-"));
  if (!roots.includes(root)) roots.push(root);
  const index = new ProjectRetrievalIndex(root, provider, { readOnly }); indexes.push(index); return { index, root };
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function unit(id: string, text: string, extra: Partial<EvidenceUnit> = {}): EvidenceUnit {
  return { id, record_id: id, artifact_id: id, project_id: "project:p", title: id, record_type: "artifact", status: "parsed", confidentiality: "internal", kind: "text", text, content_hash: digest(text), source_revision: "v1", uri: `kb://artifact/${id}/document`, locator: { start_line: 1, end_line: 2 }, source_refs: [], ...extra };
}
function corpus(units: EvidenceUnit[], revision = "r1"): EvidenceCorpus {
  const records = [...new Map(units.map(unit => [unit.record_id, { record: { id: unit.record_id, type: unit.record_type, title: unit.title, status: unit.status, project_id: unit.project_id, confidentiality: unit.confidentiality, created_at: "2026-10-04", updated_at: "2026-10-04", created_by: "test" }, body: unit.text }])).values()];
  return { revision, units, records, coverage: { total_records: records.length, total_artifacts: records.length, text_artifacts: records.length, image_units: units.filter(unit => unit.kind === "image").length, missing_documents: [], unparsed_artifacts: [], unavailable_images: [], warnings: [] } };
}
function fake() {
  const calls = { documents: [] as string[], queries: [] as string[], images: [] as string[], imageQueries: [] as string[], rerank: [] as EvidenceUnit[][] };
  const vector = (text: string) => /发起|召集|组织者|谁组织/.test(text) ? [1, 0, 0] : /餐饮|午餐/.test(text) ? [0, 1, 0] : [0, 0, 1];
  const provider: RetrievalProvider = {
    fingerprint: "endpoint-a", textModel: "qwen3.7-text-embedding", imageModel: "qwen3-vl-embedding", dimension: 3,
    async embedText(texts, purpose) { calls[purpose === "document" ? "documents" : "queries"].push(...texts); return texts.map(vector); },
    async embedImages(images) { calls.images.push(...images); return images.map(() => [0, 1, 0]); },
    async embedImageQuery(query) { calls.imageQueries.push(query); return [0, 1, 0]; },
  };
  return { provider, calls };
}

async function visualCorpus(root: string, provider: RetrievalProvider, items: Array<{ id: string; similarity: number; text?: string; source?: string }>): Promise<EvidenceCorpus> {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPtkAAAAASUVORK5CYII=", "base64");
  const vectors = new Map<string, number[]>();
  const units: EvidenceUnit[] = [];
  for (const [index, item] of items.entries()) {
    const bytes = Buffer.concat([png, Buffer.from([index])]), path = join(root, `${item.id}.png`);
    await writeFile(path, bytes);
    vectors.set(`data:image/png;base64,${bytes.toString("base64")}`, [Math.sqrt(1 - item.similarity ** 2), item.similarity, 0]);
    units.push(unit(item.id, item.text ?? "像素证据", { kind: "image", image_path: path, image_mime: "image/png", image_sha256: createHash("sha256").update(bytes).digest("hex"), ...(item.source ? { artifact_id: item.source, record_id: item.source } : {}) }));
  }
  provider.embedImages = async images => images.map(image => {
    const vector = vectors.get(image);
    if (!vector) throw new Error("Expected the fixture's validated image data URI");
    return vector;
  });
  return corpus(units);
}

describe("ProjectRetrievalIndex", () => {
  test("Chinese natural questions find keyword evidence and tail content without provider", async () => {
    const { index } = await make();
    const data = corpus([unit("answer", "红歌快闪活动由项目成员共同发起。"), unit("long", "背景内容".repeat(100) + "火星测距项目由赵同学负责。")]);
    const first = await index.search(data, { query: "红歌快闪是谁组织的" });
    expect(first.results.map(hit => hit.unit.id)).toContain("answer");
    expect(first.warnings).toContain("embedding_provider_unavailable_lexical_only");
    expect(first.models.semantic_active).toEqual([]);
    const tail = await index.search(data, { query: "火星测距", mode: "lexical" });
    expect(tail.results[0]?.unit.id).toBe("long");
    expect((await index.search(data, { query: "毫不相关的北极冰川", mode: "lexical" })).results).toEqual([]);
  });

  test("semantic paraphrase beats lexical distractor and uses separate image query space", async () => {
    const { provider, calls } = fake(), { index, root } = await make(provider);
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPtkAAAAASUVORK5CYII=", "base64");
    const path = join(root, "photo.png"); await writeFile(path, bytes);
    const data = corpus([unit("z-answer", "活动由张三发起，李四协助。"), unit("a-distractor", "组织结构图不用于介绍活动负责人。"), unit("image", "合影", { kind: "image", image_path: path, image_mime: "image/png", image_sha256: createHash("sha256").update(bytes).digest("hex") })]);
    await index.synchronize(data, { embed: true });
    const found = await index.search(data, { query: "谁组织了活动", modality: "text" });
    expect(found.results[0]?.unit.id).toBe("z-answer");
    expect(found.results[0]?.channels).toContain("text_semantic");
    const image = await index.search(data, { query: "活动现场合影", mode: "semantic", modality: "image" });
    expect(image.results.map(hit => hit.unit.id)).toEqual(["image"]);
    expect(image.results[0]?.channels).toEqual(["image_semantic"]);
    expect(calls.imageQueries).toEqual(["活动现场合影"]);
    expect(calls.queries).not.toContain("活动现场合影");
    expect(calls.images).toEqual([`data:image/png;base64,${bytes.toString("base64")}`]);
  });

  test("only explicit synchronization embeds documents and persistent cache survives reopen", async () => {
    const { provider, calls } = fake(), { index, root } = await make(provider);
    const data = corpus([unit("a", "张三发起活动"), unit("b", "午餐安排")]);
    const initial = await index.search(data, { query: "组织者" });
    expect(calls.documents).toHaveLength(0);
    expect(initial.warnings).toContain("text_embedding_incomplete_explicit_synchronize_required");
    expect(initial.models.semantic_active).toEqual([]);
    await index.synchronize(data, { embed: true });
    await index.search(data, { query: "组织者" });
    await index.search(data, { query: "组织者" });
    await index.synchronize(data, { embed: true });
    expect(calls.documents).toHaveLength(2);
    index.close();
    const reopened = (await make(provider, root)).index;
    await reopened.synchronize(data, { embed: true });
    expect(calls.documents).toHaveLength(2);
    provider.fingerprint = "different-endpoint";
    await reopened.synchronize(data, { embed: true });
    expect(calls.documents).toHaveLength(4);
  });

  test("chunks sharing a source hash keep distinct payload embeddings", async () => {
    const { provider, calls } = fake(), { index } = await make(provider);
    const data = corpus([
      unit("chunk-organizer", "活动由张三发起", { record_id: "source", artifact_id: "source", content_hash: "same-source-document-hash" }),
      unit("chunk-lunch", "午餐安排", { record_id: "source", artifact_id: "source", content_hash: "same-source-document-hash" }),
    ]);
    await index.synchronize(data, { embed: true });
    expect(calls.documents).toHaveLength(2);
    const organizer = await index.search(data, { query: "组织者", mode: "semantic" });
    expect(organizer.results.map(hit => hit.unit.id)).toEqual(["chunk-organizer"]);
    const lunch = await index.search(data, { query: "餐饮", mode: "semantic" });
    expect(lunch.results.map(hit => hit.unit.id)).toEqual(["chunk-lunch"]);
  });

  test("collect paginates more than twenty sources without losing same-source evidence", async () => {
    const { index, root } = await make();
    const units = Array.from({ length: 35 }, (_, i) => unit(`s${i.toString().padStart(2, "0")}`, `长城巡查资料第 ${i} 项`));
    units.push(unit("extra-one", "长城巡查补充 A", { artifact_id: "s00", record_id: "s00" }), unit("extra-two", "长城巡查补充 B", { artifact_id: "s00", record_id: "s00" }));
    const data = corpus(units), request = { query: "长城巡查", mode: "lexical" as const, intent: "collect" as const, top_k: 7, max_per_source: 1 };
    let page = await index.search(data, request);
    const firstCursor = page.next_cursor!;
    const ids = page.results.map(hit => hit.unit.id);
    expect(new Set(ids).size).toBe(7);
    index.close();
    const nextIndex = (await make(undefined, root)).index;
    while (page.next_cursor) { page = await nextIndex.search(data, { ...request, cursor: page.next_cursor }); ids.push(...page.results.map(hit => hit.unit.id)); }
    expect(ids).toHaveLength(37);
    expect(new Set(ids).size).toBe(37);
    expect(ids.sort()).toEqual(units.map(unit => unit.id).sort());
    await expect(nextIndex.search(corpus(units, "r2"), { ...request, cursor: firstCursor })).rejects.toThrow(/revision/);
    await expect(nextIndex.search(data, { ...request, query: "另一问题", cursor: firstCursor })).rejects.toThrow(/scope/);
  });

  test("scope precedes top-k and hidden counts and content never reach results or provider", async () => {
    const { provider, calls } = fake(), { index } = await make(provider);
    provider.rerank = async (_query, units) => { calls.rerank.push(units); return units.map((_, index) => ({ index, score: 1 / (60 + index) })); };
    const hidden = Array.from({ length: 150 }, (_, i) => unit(`hidden${i}`, "张三发起活动内部机密", { confidentiality: "secret" }));
    const data = corpus([unit("visible", "张三发起活动"), unit("wrong-project", "张三发起活动", { project_id: "project:q" }), ...hidden]);
    data.coverage.missing_documents = ["hidden0"];
    data.coverage.warnings = ["hidden0 parse failure"];
    await index.synchronize(data, { embed: true });
    expect(calls.documents.some(text => text.includes("机密"))).toBe(false);
    const found = await index.search(data, { query: "张三发起活动", project_id: "project:p", top_k: 1 });
    expect(found.results[0]?.unit.id).toBe("visible");
    expect(found.coverage.total_records).toBe(1);
    expect(found.coverage.evidence_units).toBe(1);
    expect(found.coverage.missing_documents).toEqual([]);
    expect(JSON.stringify(found)).not.toContain("hidden");
    await index.search(data, { query: "张三发起活动", maximum_confidentiality: "secret", top_k: 100 });
    expect(calls.rerank.flat().some(unit => unit.confidentiality === "secret")).toBe(false);
  });

  test("stale and unverified evidence require explicit inclusion", async () => {
    const { index } = await make();
    const data = corpus([unit("current", "长城检测现行方案"), unit("stale", "长城检测旧版方案", { status: "stale" }), unit("proposal", "长城检测候选结论", { record_type: "memory", status: "candidate" })]);
    expect((await index.search(data, { query: "长城检测", mode: "lexical" })).results.map(hit => hit.unit.id)).toEqual(["current"]);
    const all = await index.search(data, { query: "长城检测", mode: "lexical", include_history: true, include_unverified: true });
    expect(all.results).toHaveLength(3);
  });

  test("failed embeddings remain incomplete and lexical fallback is explicit", async () => {
    const { provider } = fake(), { index } = await make(provider);
    provider.embedText = async () => { throw new Error("credential-or-provider-details-must-not-leak"); };
    const data = corpus([unit("a", "长城检测资料")]);
    const coverage = await index.synchronize(data, { embed: true });
    expect(coverage.text_embedded_units).toBe(0);
    expect(coverage.warnings).toContain("document_embedding_failed");
    const found = await index.search(data, { query: "长城检测" });
    expect(found.results[0]?.unit.id).toBe("a");
    expect(found.warnings).toContain("text_embedding_incomplete_explicit_synchronize_required");
    expect(found.models.semantic_active).toEqual([]);
    expect(JSON.stringify(found)).not.toContain("credential");
  });

  test("metadata and task records remain lexical with explicit coverage and evidence priority", async () => {
    const { provider, calls } = fake(), { index } = await make(provider);
    const data = corpus([
      unit("z-source", "长城实践由张三发起活动"),
      unit("a-task", "长城实践由张三发起活动", { record_type: "work_item", status: "completed" }),
      unit("b-placeholder", "长城实践 [Metadata only: document body is unavailable; this record does not establish the original document's contents.]", { status: "registered" }),
    ]);
    const coverage = await index.synchronize(data, { embed: true });
    expect(calls.documents).toHaveLength(1);
    expect(coverage.text_embedding_complete).toBe(true);
    expect(coverage.lexical_only_units).toBe(2);
    expect(coverage.metadata_only_units).toBe(1);
    const found = await index.search(data, { query: "长城实践", intent: "collect" });
    expect(found.results[0]?.unit.id).toBe("z-source");
    expect(new Set(found.results.map(hit => hit.unit.id))).toEqual(new Set(["z-source", "a-task", "b-placeholder"]));
    expect(found.warnings).toContain("metadata_only_records_do_not_establish_document_contents");
    expect(found.coverage.fact_completeness).toBe("not_proven");
  });

  test("unknown semantic queries with no similar cached document return no evidence", async () => {
    const { provider } = fake(), { index } = await make(provider);
    const data = corpus([unit("a", "张三发起活动"), unit("b", "午餐安排")]);
    await index.synchronize(data, { embed: true });
    expect((await index.search(data, { query: "北极冰川", mode: "semantic" })).results).toEqual([]);
  });

  test("record type and ID filters combine and bind continuation scope", async () => {
    const { index } = await make();
    const data = corpus([unit("a", "长城实践"), unit("b", "长城实践"), unit("section", "长城实践", { record_type: "knowledge_section", status: "active" })]);
    const request = { query: "长城实践", record_types: ["artifact"], record_ids: ["a", "b"], top_k: 1, intent: "collect" as const };
    const page = await index.search(data, request);
    expect(page.coverage.total_records).toBe(2);
    expect(page.results[0]?.unit.record_type).toBe("artifact");
    expect(page.next_cursor).toBeDefined();
    await expect(index.search(data, { ...request, record_ids: ["a"], cursor: page.next_cursor })).rejects.toThrow(/scope/);
    expect((await index.search(data, { ...request, record_ids: [] })).results).toEqual([]);
    expect((await index.search(data, { ...request, record_ids: ["section"] })).results).toEqual([]);
  });

  test("structural preference boosts only recalled units and leaves global retrieval open", async () => {
    const { index } = await make();
    const data = corpus([unit("a", "长城实践"), unit("b", "长城实践"), unit("unrelated", "月球采矿")]);
    const request = { query: "长城实践", mode: "lexical" as const, preferred_record_ids: ["b", "unrelated"], intent: "collect" as const, top_k: 1 };
    const found = await index.search(data, request);
    expect(found.results[0]?.unit.id).toBe("b");
    expect(found.results[0]?.channels).toContain("structural");
    const next = await index.search(data, { ...request, cursor: found.next_cursor });
    expect(next.results.map(hit => hit.unit.id)).toEqual(["a"]);
    expect(next.next_cursor).toBeUndefined();
    await expect(index.search(data, { ...request, preferred_record_ids: ["a"], cursor: found.next_cursor })).rejects.toThrow(/scope/);
  });

  test("read-only searches use persisted vectors without modifying disk index", async () => {
    const { provider, calls } = fake(), { index, root } = await make(provider);
    const data = corpus([unit("a", "张三发起活动")]);
    await index.synchronize(data, { embed: true }); index.close();
    const reader = (await make(provider, root, true)).index;
    const found = await reader.search(data, { query: "组织者", mode: "semantic" });
    expect(found.results[0]?.unit.id).toBe("a");
    expect(calls.documents).toHaveLength(1);
    expect(found.models.semantic_active).toEqual(["text"]);
  });

  test("a running reader notices background embedding commits after an earlier cache miss", async () => {
    const { provider } = fake(), { index, root } = await make(provider);
    const data = corpus([unit("a", "张三发起活动")]);
    await index.synchronize(data);
    const reader = (await make(provider, root, true)).index;
    expect((await reader.search(data, { query: "组织者", mode: "semantic" })).results).toEqual([]);
    await index.synchronize(data, { embed: true });
    const after = await reader.search(data, { query: "组织者", mode: "semantic" });
    expect(after.results[0]?.unit.id).toBe("a");
    expect(after.coverage.text_embedding_complete).toBe(true);
  });

  test("query vectors cross scopes while identical complete rankings avoid another rerank", async () => {
    const { provider, calls } = fake(), { index } = await make(provider);
    provider.rerank = async (_query, units) => { calls.rerank.push(units); return units.map((_, index) => ({ index, score: 1 / (60 + index) })); };
    const data = corpus([unit("a", "张三发起活动"), unit("b", "李四发起活动")]);
    await index.synchronize(data, { embed: true });
    const first = await index.search(data, { query: "组织者" });
    expect(await index.search(data, { query: "组织者" })).toEqual(first);
    expect(calls.queries).toHaveLength(1);
    expect(calls.rerank).toHaveLength(1);
    await index.search(data, { query: "组织者", record_ids: ["b"] });
    expect(calls.queries).toHaveLength(1);
    expect(calls.rerank).toHaveLength(2);
    await index.search(corpus(data.units, "r2"), { query: "组织者" });
    expect(calls.queries).toHaveLength(1);
    expect(calls.rerank).toHaveLength(3);
  });

  test("query vector cache is bounded and evicts old query entries", async () => {
    const { provider, calls } = fake(), { index } = await make(provider);
    const data = corpus([unit("a", "张三发起活动")]);
    await index.synchronize(data, { embed: true });
    for (let i = 0; i < 130; i++) await index.search(data, { query: `问题${i}`, mode: "semantic" });
    expect(calls.queries).toHaveLength(130);
    await index.search(data, { query: "问题0", mode: "semantic" });
    expect(calls.queries).toHaveLength(131);
  });

  test("image rerank caps candidates at twenty-four and retains remaining recalled evidence", async () => {
    const { provider, calls } = fake(), { index } = await make(provider);
    provider.rerank = async (_query, units) => { calls.rerank.push(units); return units.map((_, index) => ({ index, score: 1 / (60 + index) })); };
    const data = corpus(Array.from({ length: 40 }, (_, i) => unit(`photo-${i}`, "长城活动合影", { kind: "image", image_mime: "image/png" })));
    const found = await index.search(data, { query: "活动合影", mode: "lexical", intent: "collect", top_k: 100 });
    expect(found.results).toHaveLength(40);
    expect(calls.rerank).toHaveLength(1);
    expect(calls.rerank[0]).toHaveLength(24);
    expect(found.results.filter(hit => hit.channels.includes("rerank"))).toHaveLength(24);
  });

  test("unsupported GIF stays visible without poisoning a supported PNG embedding batch", async () => {
    const { provider, calls } = fake(), { index, root } = await make(provider);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPtkAAAAASUVORK5CYII=", "base64");
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
    await writeFile(join(root, "image.png"), png); await writeFile(join(root, "image.gif"), gif);
    const data = corpus([
      unit("png", "长城活动合影", { kind: "image", image_path: join(root, "image.png"), image_mime: "image/png", image_sha256: createHash("sha256").update(png).digest("hex") }),
      unit("gif", "长城活动合影", { kind: "image", image_path: join(root, "image.gif"), image_mime: "image/gif", image_sha256: createHash("sha256").update(gif).digest("hex") }),
    ]);
    const coverage = await index.synchronize(data, { embed: true });
    expect(calls.images).toHaveLength(1);
    expect(calls.images[0]).toMatch(/^data:image\/png;/);
    expect(coverage.image_embedded_units).toBe(1);
    expect(coverage.image_embedding_complete).toBe(false);
    expect(coverage.unsupported_image_formats).toEqual([{ id: "gif", mime_type: "image/gif" }]);
    expect(coverage.warnings).toContain("unsupported_image_format");
    const found = await index.search(data, { query: "活动合影", mode: "lexical", modality: "image" });
    expect(new Set(found.results.map(hit => hit.unit.id))).toEqual(new Set(["png", "gif"]));
    expect(found.warnings).toContain("unsupported_image_format");
  });

  test("coverage inspection is local, scoped, and reports unavailable text and vector progress", async () => {
    const { provider, calls } = fake(), { index } = await make(provider);
    const data = corpus([unit("visible", "张三发起活动"), unit("hidden", "隐藏文本", { confidentiality: "secret" }), unit("other", "异项目", { project_id: "project:q" })]);
    data.coverage.text_unavailable_artifacts = ["visible", "hidden", "other"];
    const before = index.inspectCoverage(data, { project_id: "project:p", maximum_confidentiality: "internal" });
    expect(before.total_records).toBe(1);
    expect(before.text_embedding_eligible_units).toBe(1);
    expect(before.text_embedded_units).toBe(0);
    expect(before.text_unavailable_artifacts).toEqual(["visible"]);
    expect(calls).toEqual({ documents: [], queries: [], images: [], imageQueries: [], rerank: [] });
    await index.synchronize(data, { embed: true });
    const count = calls.documents.length;
    const after = index.inspectCoverage(data, { project_id: "project:p" });
    expect(after.text_embedded_units).toBe(1);
    expect(after.text_embedding_complete).toBe(true);
    expect(calls.documents).toHaveLength(count);
    expect(calls.queries).toEqual([]);
    expect(calls.imageQueries).toEqual([]);
    expect(calls.rerank).toEqual([]);
  });

  test("supplement image-source failures remain visible without exposing secret or historical gaps", async () => {
    const { provider, calls } = fake(), { index } = await make(provider);
    const data = corpus([
      unit("visible", "当前资料"),
      unit("secret", "秘密资料", { confidentiality: "secret" }),
      unit("old", "历史资料", { status: "stale" }),
      unit("other", "其他项目资料", { project_id: "project:q" }),
    ]);
    data.coverage.unavailable_images = ["visible#image-source", "visible#image-3", "secret#image-source", "old#image-source", "other#image-source", "absent#image-source"];
    const current = index.inspectCoverage(data, { project_id: "project:p" });
    expect(current.unavailable_images).toEqual(["visible#image-source", "visible#image-3"]);
    expect(current.warnings).toContain("visible_images_unavailable");
    expect(current.total_records).toBe(1);
    const history = index.inspectCoverage(data, { project_id: "project:p", include_history: true });
    expect(history.unavailable_images).toEqual(["visible#image-source", "visible#image-3", "old#image-source"]);
    expect(history.total_records).toBe(2);
    expect(calls).toEqual({ documents: [], queries: [], images: [], imageQueries: [], rerank: [] });
  });

  test("a confirmed invalid image batch falls back once per image and preserves valid peers", async () => {
    const { provider } = fake(), { index, root } = await make(provider);
    const first = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPtkAAAAASUVORK5CYII=", "base64");
    const second = Buffer.concat([first, Buffer.from([0])]);
    await writeFile(join(root, "first.png"), first); await writeFile(join(root, "second.png"), second);
    const firstUri = `data:image/png;base64,${first.toString("base64")}`;
    const data = corpus([first, second].map((bytes, i) => unit(`image-${i}`, "图片", { kind: "image", image_path: join(root, i ? "second.png" : "first.png"), image_mime: "image/png", image_sha256: createHash("sha256").update(bytes).digest("hex") })));
    const batches: number[] = [];
    provider.embedImages = async images => { batches.push(images.length); if (images.length > 1 || images[0] !== firstUri) throw new Error("Alibaba request failed: HTTP 400"); return [[0, 1, 0]]; };
    const result = await index.synchronize(data, { embed: true });
    expect(batches).toEqual([2, 1, 1]);
    expect(result.image_embedded_units).toBe(1);
    expect(result.image_embedding_complete).toBe(false);
    expect(result.warnings).toContain("image_embedding_failed");

    for (const message of ["Alibaba request failed: HTTP 401", "Alibaba request failed: HTTP 503", "Alibaba request failed or timed out"]) {
      const otherProvider = { ...provider, fingerprint: message };
      let attempts = 0;
      otherProvider.embedImages = async () => { attempts++; throw new Error(message); };
      const otherIndex = (await make(otherProvider, root)).index;
      await otherIndex.synchronize(data, { embed: true });
      expect(attempts).toBe(1);
    }
  });

  test("a locally changed image does not block its valid batch neighbor", async () => {
    const { provider, calls } = fake(), { index, root } = await make(provider);
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPtkAAAAASUVORK5CYII=", "base64");
    await writeFile(join(root, "valid.png"), bytes);
    const common = { kind: "image" as const, image_path: join(root, "valid.png"), image_mime: "image/png" };
    const data = corpus([unit("valid", "图片", { ...common, image_sha256: createHash("sha256").update(bytes).digest("hex") }), unit("changed", "图片", { ...common, image_sha256: "0".repeat(64) })]);
    const result = await index.synchronize(data, { embed: true });
    expect(calls.images).toHaveLength(1);
    expect(result.image_embedded_units).toBe(1);
    expect(result.image_embedding_complete).toBe(false);
    expect(result.warnings).toContain("image_content_unavailable");
  });

  test("persistent corpus projection hydrates in read-only mode without reading image bytes", async () => {
    const { provider, calls } = fake(), { index, root } = await make(provider);
    const data = corpus([
      unit("text", "原文内容", { source_revision: "r1" }),
      unit("image", "图片说明", { source_revision: "r1", kind: "image", image_path: join(root, "absent-image.png"), image_mime: "image/png", image_sha256: "a".repeat(64) }),
    ]);
    data.coverage.text_unavailable_artifacts = ["image"];
    await index.synchronize(data);
    expect(index.loadCorpusProjection("r1", data.records)).toEqual(data);
    index.close();
    const reader = (await make(provider, root, true)).index;
    expect(reader.loadCorpusProjection("r1", data.records)).toEqual(data);
    expect(reader.loadCorpusProjection("r2", data.records)).toBeUndefined();
    const changedScope = data.records.map(item => ({ ...item, record: { ...item.record, confidentiality: "secret" as const } }));
    expect(reader.loadCorpusProjection("r1", changedScope)).toBeUndefined();
    expect(calls).toEqual({ documents: [], queries: [], images: [], imageQueries: [], rerank: [] });
  });

  test("missing or corrupt corpus projection falls back and normal sync upgrades legacy metadata", async () => {
    const { index } = await make();
    const data = corpus([unit("text", "原文内容", { source_revision: "r1" })]);
    await index.synchronize(data);
    const db = new Database(index.path);
    try {
      db.prepare("DELETE FROM retrieval_meta WHERE key='corpus_projection'").run();
      expect(index.loadCorpusProjection("r1", data.records)).toBeUndefined();
      await index.synchronize(data);
      expect(index.loadCorpusProjection("r1", data.records)).toEqual(data);
      db.prepare("UPDATE evidence_units SET unit_json='invalid-json'").run();
      expect(index.loadCorpusProjection("r1", data.records)).toBeUndefined();
    } finally { db.close(); }
  });

  test("copied photos do not fill the first page or rerank window and collect retains every source", async () => {
    const { provider, calls } = fake(), { index } = await make(provider);
    provider.rerank = async (_query, units) => { calls.rerank.push(units); return units.map((_, index) => ({ index, score: 1 / (60 + index) })); };
    const copies = Array.from({ length: 30 }, (_, i) => unit(`a-copy-${i.toString().padStart(2, "0")}`, "长城活动合影", { kind: "image", image_mime: "image/png", image_sha256: "copied-photo" }));
    const distinct = Array.from({ length: 29 }, (_, i) => unit(`z-photo-${i.toString().padStart(2, "0")}`, "长城活动合影", { kind: "image", image_mime: "image/png", image_sha256: `different-photo-${i}` }));
    const data = corpus([...copies, ...distinct]);
    const request = { query: "活动合影", mode: "lexical" as const, modality: "image" as const, intent: "collect" as const, top_k: 6 };
    let page = await index.search(data, request);
    expect(new Set(page.results.map(hit => hit.unit.image_sha256)).size).toBe(6);
    expect(calls.rerank).toHaveLength(1);
    expect(calls.rerank[0]).toHaveLength(24);
    expect(new Set(calls.rerank[0]!.map(unit => unit.image_sha256)).size).toBe(24);
    const ids = page.results.map(hit => hit.unit.id);
    while (page.next_cursor) { page = await index.search(data, { ...request, cursor: page.next_cursor }); ids.push(...page.results.map(hit => hit.unit.id)); }
    expect(ids).toHaveLength(59);
    expect(new Set(ids).size).toBe(59);
    expect(ids.sort()).toEqual(data.units.map(unit => unit.id).sort());
  });

  test("identical text across records is deferred while distinct text appears on the first page", async () => {
    const { index } = await make();
    const data = corpus([
      unit("a-copy-1", "长城实践的检查记录"), unit("a-copy-2", "长城实践的检查记录"), unit("a-copy-3", "长城实践的检查记录"),
      unit("z-distinct-1", "长城实践的行程资料"), unit("z-distinct-2", "长城实践的设备清单"),
    ]);
    const request = { query: "长城实践", mode: "lexical" as const, intent: "collect" as const, top_k: 3 };
    const first = await index.search(data, request);
    expect(new Set(first.results.map(hit => hit.unit.text)).size).toBe(3);
    const second = await index.search(data, { ...request, cursor: first.next_cursor });
    expect([...first.results, ...second.results]).toHaveLength(5);
    expect(new Set([...first.results, ...second.results].map(hit => hit.unit.id)).size).toBe(5);
  });

  test("image hybrid preserves visual gaps and context cannot introduce a visual nonmatch", async () => {
    const { provider } = fake(), { index, root } = await make(provider);
    const data = await visualCorpus(root, provider, [
      { id: "pixels-high", similarity: 0.514 },
      { id: "pixels-next", similarity: 0.439 },
      { id: "context-weak", similarity: 0.294, text: "户外照片" },
      { id: "context-nonmatch", similarity: 0.05, text: "户外照片 户外照片" },
    ]);
    await index.synchronize(data, { embed: true });
    const request = { query: "户外照片", modality: "image" as const, intent: "collect" as const, rerank: false, preferred_record_ids: ["context-weak", "context-nonmatch"] };
    const found = await index.search(data, request);
    expect(found.results.map(hit => hit.unit.id)).toEqual(["pixels-high", "pixels-next", "context-weak"]);
    expect(found.results[0]!.score / found.results[2]!.score).toBeGreaterThan(1.9);
    expect(found.models.image_fusion).toMatchObject({ visual_active: true, visual_candidate_gate: true, calibrated_relevance_probability: false });
    expect(found.coverage.fact_completeness).toBe("not_proven");
    const lexical = await index.search(data, { ...request, mode: "lexical" });
    expect(new Set(lexical.results.map(hit => hit.unit.id))).toEqual(new Set(["context-weak", "context-nonmatch"]));

    provider.embedImageQuery = async () => [0, 0, 1];
    const emptyVisual = await index.search(data, { ...request, query: "户外照片 新的问题" });
    expect(emptyVisual.results).toEqual([]);
    expect(emptyVisual.models.semantic_active).toEqual(["image"]);
    expect(emptyVisual.warnings).not.toContain("image_semantic_unavailable_using_lexical_context");

    const unavailable = (await make(undefined, root)).index;
    const fallback = await unavailable.search(data, request);
    expect(new Set(fallback.results.map(hit => hit.unit.id))).toEqual(new Set(["context-weak", "context-nonmatch"]));
    expect(fallback.warnings).toContain("embedding_provider_unavailable_lexical_only");
    expect(fallback.warnings).toContain("image_semantic_unavailable_using_lexical_context");
    const failed = (await make({ ...provider, embedImageQuery: async () => { throw new Error("temporary failure"); } }, root)).index;
    const failure = await failed.search(data, request);
    expect(failure.results).toHaveLength(2);
    expect(failure.warnings).toContain("image_query_embedding_failed");
    expect(failure.warnings).toContain("image_semantic_unavailable_using_lexical_context");
  });

  test("source diversity rotates close matches without promoting low-score sources", async () => {
    const { provider } = fake(), { index, root } = await make(provider);
    const data = await visualCorpus(root, provider, [
      ...[0.52, 0.51, 0.5, 0.49, 0.48].map((similarity, i) => ({ id: `source-a-${i}`, similarity, source: "source-a" })),
      { id: "close-other-source", similarity: 0.505 },
      { id: "weak-other-source", similarity: 0.28 },
    ]);
    await index.synchronize(data, { embed: true });
    const request = { query: "户外照片", mode: "semantic" as const, modality: "image" as const, intent: "collect" as const, top_k: 6, max_per_source: 2, rerank: false };
    const first = await index.search(data, request);
    expect(first.results.map(hit => hit.unit.id)).toEqual(["source-a-0", "source-a-1", "close-other-source", "source-a-2", "source-a-3", "source-a-4"]);
    expect(first.models.diversity).toMatchObject({ source_score_band_min_ratio: 0.9, deferred_duplicates_retained: true });
    const second = await index.search(data, { ...request, cursor: first.next_cursor });
    expect(second.results.map(hit => hit.unit.id)).toEqual(["weak-other-source"]);
    expect(new Set([...first.results, ...second.results].map(hit => hit.unit.id)).size).toBe(7);
  });

  test("image reranking demotes local losers and never compares confidence across provider batches", async () => {
    vi.stubEnv("ARGON_MEMORY_IMAGE_RERANK_ADJUSTMENT", undefined);
    const { provider } = fake(), { index, root } = await make(provider);
    const data = await visualCorpus(root, provider, [0.55, 0.54, 0.53, 0.52, 0.4, 0.39, 0.38, 0.37].map((similarity, i) => ({ id: `photo-${i}`, similarity })));
    provider.rerank = async (_query, units) => units.map((_, index) => ({ index, score: 1 / (61 + (3 - index % 4)) }));
    await index.synchronize(data, { embed: true });
    const request = { query: "户外照片", mode: "semantic" as const, modality: "image" as const, intent: "collect" as const, top_k: 100 };
    const original = await index.search(data, { ...request, rerank: false });
    const before = new Map(original.results.map(hit => [hit.unit.id, hit.score]));
    const ranked = await index.search(data, request);
    const after = new Map(ranked.results.map(hit => [hit.unit.id, hit.score]));
    expect(after.get("photo-0")! / before.get("photo-0")!).toBeCloseTo(0.9);
    expect(after.get("photo-3")! / before.get("photo-3")!).toBeCloseTo(1.1);
    expect(after.get("photo-4")! / before.get("photo-4")!).toBeCloseTo(0.9);
    expect(after.get("photo-7")! / before.get("photo-7")!).toBeCloseTo(1.1);
    expect(ranked.results).toHaveLength(8);
    expect(ranked.results.every(hit => hit.channels.includes("rerank"))).toBe(true);
    expect(ranked.models.rerank_limits).toMatchObject({ image_comparison_group_size: 4, image_adjustment_max_ratio: 0.1 });
  });

  test("image rerank adjustment is bounded and configuration changes invalidate rankings and cursors", async () => {
    vi.stubEnv("ARGON_MEMORY_IMAGE_RERANK_ADJUSTMENT", "0.1");
    const { provider } = fake(), { index, root } = await make(provider);
    const data = await visualCorpus(root, provider, [0.55, 0.54, 0.53, 0.52].map((similarity, i) => ({ id: `photo-${i}`, similarity })));
    provider.rerank = async (_query, units) => units.map((_, index) => ({ index, score: 1 / (61 + 3 - index) }));
    await index.synchronize(data, { embed: true });
    const request = { query: "户外照片", mode: "semantic" as const, modality: "image" as const, intent: "collect" as const, top_k: 2 };
    const original = await index.search(data, { ...request, top_k: 100, rerank: false });
    const before = new Map(original.results.map(hit => [hit.unit.id, hit.score]));
    const first = await index.search(data, request);
    for (const [configured, expected] of [["0.4", 0.4], ["2", 0.5], ["-1", 0], ["invalid", 0.1], ["", 0.1]] as const) {
      vi.stubEnv("ARGON_MEMORY_IMAGE_RERANK_ADJUSTMENT", configured);
      const ranked = await index.search(data, { ...request, top_k: 100 });
      const after = new Map(ranked.results.map(hit => [hit.unit.id, hit.score]));
      expect(after.get("photo-0")! / before.get("photo-0")!).toBeCloseTo(1 - expected);
      expect(after.get("photo-3")! / before.get("photo-3")!).toBeCloseTo(1 + expected);
      expect(ranked.results).toHaveLength(4);
      expect(ranked.models.rerank_limits).toMatchObject({ image_adjustment_max_ratio: expected });
      if (expected !== 0.1) await expect(index.search(data, { ...request, cursor: first.next_cursor })).rejects.toThrow(/scope/);
    }
  });
});
