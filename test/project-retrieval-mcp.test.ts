import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProjectRuntime } from "../src/project/runtime.js";
import { PROJECT_SKILL_VERSION } from "../src/client-skill.js";
import { registerProjectTools } from "../src/mcp/tools/project.js";
import type { RetrievalProvider } from "../src/project/retrieval/types.js";

// A valid, decodable one-pixel PNG. The synthetic provider recognizes its bytes;
// this proves pixel transport and retrieval plumbing, not real model perception.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const PROJECT = "project:mcp-fixture";
const cleanups: Array<() => Promise<void>> = [];
function textControl(response: any, kind: "search" | "read"): any {
  const text = response.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n");
  const match = new RegExp(`MCP ${kind} control[^\\n]*:\\n\x60\x60\x60json\\n([^\\n]+)\\n\x60\x60\x60`).exec(text);
  expect(match, "text-only clients receive executable continuation information").not.toBeNull();
  return JSON.parse(match![1]!);
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "argon-memory-retrieval-mcp-"));
  const textCalls: string[] = [];
  const imageCalls: string[] = [];
  const provider: RetrievalProvider = {
    fingerprint: "synthetic-pixel-and-synonym-v1", textModel: "synthetic-text", imageModel: "synthetic-image", dimension: 3,
    embedText: vi.fn(async (texts, purpose) => {
      textCalls.push(...texts);
      return texts.map(text => text.includes("王澄") || (purpose === "query" && text.includes("安全带队")) ? [1, 0, 0] : [0, 0, 1]);
    }),
    embedImages: vi.fn(async images => images.map(value => {
      imageCalls.push(value);
      expect(value).toMatch(/^data:image\/png;base64,/);
      expect(Buffer.from(value.split(",")[1]!, "base64")).toEqual(PNG);
      return [0, 1, 0];
    })),
    embedImageQuery: vi.fn(async () => [0, 1, 0]),
  };
  const runtime = new ProjectRuntime(root, { retrievalProvider: provider });
  const server = new McpServer({ name: "retrieval-contract-fixture", version: "1" });
  const client = new Client({ name: "retrieval-contract-client", version: "1" });
  cleanups.push(async () => { await client.close(); await server.close(); runtime.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.initialize();
  await mkdir(join(root, "normalized"), { recursive: true });
  await mkdir(join(root, "agent-resources"), { recursive: true });
  registerProjectTools(server, runtime, "project-read");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => client.callTool({ name, arguments: args });
  const artifact = async (id: string, text: string, confidentiality: "internal" | "restricted" | "secret" = "internal", extra: Record<string, unknown> = {}) => {
    const path = `normalized/${id.replaceAll(":", "-")}.md`;
    await writeFile(join(root, path), text);
    await runtime.upsertRecord({ id, type: "artifact", title: id, status: "parsed", project_id: PROJECT, created_by: "fixture", confidentiality,
      normalized_markdown_path: path, mime_type: "text/markdown", sha256: createHash("sha256").update(text).digest("hex"), ...extra });
    return path;
  };
  return { root, runtime, client, call, artifact, provider, textCalls, imageCalls };
}

describe("Project retrieval through MCP transport and registered tools", () => {
  test("semantic paraphrase finds a long document's tail and its advertised evidence URI reads the exact passage", async () => {
    const f = await fixture();
    const source = `# 勘察记录\n${"常规背景材料。".repeat(900)}\n\n## 末端安排\n王澄担任应急联络员。\n`;
    await f.artifact("artifact:tail", source);
    await f.runtime.rebuildRetrieval(true);
    const found = await f.call("kb_search", { query: "现场安全带队由哪个人负责", mode: "semantic", modality: "text", project_id: PROJECT, top_k: 1, rerank: false });
    expect(found.isError).not.toBe(true);
    const hit = found.structuredContent.results[0];
    expect(hit.channels).toContain("text_semantic");
    expect(found.structuredContent.warnings).toContain("no_structural_route_global_rag_required");
    expect(hit.snippet).toContain("王澄担任应急联络员");
    expect(hit.locator.start_char).toBeGreaterThan(4000);
    expect(hit.uri).toMatch(/^kb:\/\/evidence\//);
    expect(hit.source_uri).toBe("kb://artifact/artifact%3Atail/document");
    const read = await f.call("kb_read", { resource_id: hit.uri, max_tokens: 4000 });
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent.text).toBe(source.slice(hit.locator.start_char, hit.locator.end_char));
    expect(read.structuredContent.text).toContain("王澄担任应急联络员");
    expect(read.content[0].type).toBe("resource");
  });

  test("collect traverses more than 20 distinct sources without duplicates or hidden records", async () => {
    const f = await fixture();
    const expected = Array.from({ length: 27 }, (_, index) => `artifact:source-${index}`);
    for (const id of expected) await f.artifact(id, `# 调查纪要\n线索归档：${id}。\n`);
    await f.artifact("artifact:hidden-sentinel", "# 调查纪要\n线索归档：HIDDEN_SENTINEL。\n", "secret");
    const args = { query: "调查纪要 线索归档", intent: "collect", mode: "lexical", modality: "text", project_id: PROJECT, top_k: 8, max_per_source: 1, rerank: false };
    const ids: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const page = await f.call("kb_search", { ...args, ...(cursor ? { cursor } : {}) });
      expect(page.isError).not.toBe(true);
      expect(JSON.stringify(page)).not.toMatch(/HIDDEN_SENTINEL|hidden-sentinel/);
      ids.push(...page.structuredContent.results.map((row: any) => row.id));
      expect(page.structuredContent.coverage.matched_units).toBe(27);
      const control = textControl(page, "search");
      expect(control.coverage.matched_units).toBe(27);
      expect(control.coverage.fact_completeness).toBe("not_proven");
      expect(control.has_more).toBe(Boolean(page.structuredContent.next_cursor));
      if (control.next_call) {
        expect(control.next_call.tool).toBe("kb_search");
        expect(control.next_call.arguments).toMatchObject(args);
        expect(control.next_call.arguments.cursor).toBe(page.structuredContent.next_cursor);
      }
      cursor = control.next_call?.arguments.cursor; pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor);
    expect(pages).toBe(4);
    expect(ids).toHaveLength(27);
    expect([...new Set(ids)].sort()).toEqual(expected.sort());
    const coverage = await f.call("kb_coverage", { project_id: PROJECT });
    expect(coverage.structuredContent.artifacts).toBe(27);
    expect(coverage.structuredContent.completeness_scope).toBe("registered_visible_sources_only");
    expect(JSON.stringify(coverage)).not.toMatch(/HIDDEN_SENTINEL|hidden-sentinel/);
    const blocked = await f.call("kb_read", { resource_id: "kb://artifact/artifact%3Ahidden-sentinel/document" });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked)).not.toContain("HIDDEN_SENTINEL");
  });

  test("a text-only client reads a long document fully using server-provided calls", async () => {
    const f = await fixture();
    const text = `# Long record\n${"分散的实践细节和😀原始证据。\n".repeat(70)}END_OF_SOURCE`;
    await f.artifact("artifact:read-continuation", text);
    let args: any = { resource_id: "kb://artifact/artifact%3Aread-continuation/document", max_tokens: 100 };
    const chunks: string[] = [];
    while (args) {
      const response = await f.call("kb_read", args);
      expect(response.isError).not.toBe(true);
      const control = textControl(response, "read");
      const textBlock = response.content.find((item: any) => item.type === "text").text;
      const separator = "\n```\n\n";
      chunks.push(textBlock.slice(textBlock.indexOf(separator) + separator.length));
      expect(control.truncated).toBe(Boolean(control.next_call));
      args = control.next_call?.arguments;
      expect(chunks.length).toBeLessThan(20);
    }
    expect(chunks.join("")).toBe(text);
  });

  test("a text-only client can retrieve and verify the complete Skill delta", async () => {
    const f = await fixture();
    const response = await f.call("kb_sync_skill", { client: "generic", installed_version: "0.5.0" });
    expect(response.isError).not.toBe(true);
    const text = response.content.find((item: any) => item.type === "text").text;
    const delta = JSON.parse(text.slice(text.indexOf("\n\n") + 2));
    expect(delta.status).toBe("update_required");
    expect(delta.target_version).toBe(PROJECT_SKILL_VERSION);
    expect(delta).toEqual(response.structuredContent);
    for (const file of delta.delta.files) expect(createHash("sha256").update(file.content).digest("hex")).toBe(file.sha256);
    const installed = delta.delta.files.filter((file: any) => file.path !== "skill-version.json").map((file: any) => ({ path: file.path, sha256: file.sha256 }));
    const current = await f.call("kb_sync_skill", { client: "generic", installed_version: delta.target_version, installed_files: installed });
    expect(current.structuredContent.status).toBe("current");
  });

  test("coverage keeps current counts, images and gaps in one scope without mixing historical or unverified inventory", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "agent-resources/current.png"), PNG);
    await f.artifact("artifact:current", "# Current\n![active](../agent-resources/current.png)\n");
    await f.artifact("artifact:active-missing", "unused", "internal", { normalized_markdown_path: "normalized/absent-current.md" });
    await f.artifact("artifact:historic", `# Historical\n${"historical body\n".repeat(300)}![](../agent-resources/current.png)\n![](missing-historic.png)`, "internal", { status: "stale" });
    await f.artifact("artifact:historic-missing", "unused", "internal", { status: "archived", normalized_markdown_path: "normalized/absent-historic.md" });
    await f.artifact("artifact:unverified", "# Unverified\n![](missing-unverified.png)", "internal", { status: "candidate" });
    await f.artifact("artifact:hidden", "# Hidden\n![](missing-hidden.png)", "secret");
    await f.artifact("artifact:other-project", "# Other project\n![](missing-other.png)", "internal", { project_id: "project:other" });
    const response = await f.call("kb_coverage", { project_id: PROJECT });
    expect(response.isError).not.toBe(true);
    const coverage = response.structuredContent;
    expect(coverage).toMatchObject({ total_records: 2, records: 2, total_artifacts: 2, artifacts: 2, text_units: 2, image_units: 1, evidence_units: 3,
      scope: { project_id: PROJECT, maximum_confidentiality: "internal", include_history: false, include_unverified: false } });
    expect(coverage.evidence_units).toBe(coverage.text_units + coverage.image_units);
    expect(coverage.text_embedding_eligible_units + coverage.lexical_only_units).toBe(coverage.text_units);
    expect(coverage.missing_documents).toEqual(["artifact:active-missing"]);
    expect(coverage.unparsed_artifacts).toEqual(["artifact:active-missing"]);
    expect(coverage.text_unavailable_artifacts).toEqual(["artifact:active-missing"]);
    expect(coverage.unavailable_images).toEqual([]);
    expect(JSON.stringify(coverage)).not.toMatch(/artifact:(?:historic|unverified|hidden|other-project)/);
  });

  test("opaque filename image is embedded from pixels and both search and read return image content", async () => {
    const f = await fixture();
    expect(inflateSync(PNG.subarray(41, 53))).toEqual(Buffer.from([0, 255, 0, 0]));
    await writeFile(join(f.root, "agent-resources", "d0e9a4.png"), PNG);
    await f.runtime.upsertRecord({ id: "artifact:opaque-image", title: "d0e9a4.png", type: "artifact", status: "parsed", project_id: PROJECT, created_by: "fixture",
      mime_type: "image/png", managed_relative_path: "agent-resources/d0e9a4.png", original_relative_path: "d0e9a4.png", sha256: createHash("sha256").update(PNG).digest("hex") });
    await f.runtime.upsertRecord({ id: "artifact:hidden-image", title: "HIDDEN_PIXELS", type: "artifact", status: "parsed", project_id: PROJECT, created_by: "fixture", confidentiality: "secret",
      mime_type: "image/png", managed_relative_path: "agent-resources/d0e9a4.png", original_relative_path: "d0e9a4.png", sha256: createHash("sha256").update(PNG).digest("hex") });
    await f.runtime.rebuildRetrieval(true);
    expect(f.imageCalls).toHaveLength(1);
    const found = await f.call("kb_search", { query: "多人并肩站立", mode: "semantic", modality: "image", project_id: PROJECT, include_images: true, rerank: false });
    expect(found.isError).not.toBe(true);
    expect(found.structuredContent.results).toHaveLength(1);
    expect(JSON.stringify(found)).not.toMatch(/HIDDEN_PIXELS|hidden-image/);
    expect(found.structuredContent.results[0].channels).toContain("image_semantic");
    expect(found.structuredContent.returned_images).toBe(1);
    const shown = found.content.find((block: any) => block.type === "image");
    expect(["image/jpeg", "image/png"]).toContain(shown.mimeType);
    expect(Buffer.byteLength(shown.data, "base64")).toBeLessThanOrEqual(256 * 1024);
    expect(found.structuredContent.originals_via).toBe("kb_read");
    const automatic = await f.call("kb_search", { query: "团队合照", project_id: PROJECT, rerank: false });
    expect(automatic.structuredContent.resolved_modality).toBe("image");
    expect(automatic.structuredContent.results[0].channels).toContain("image_semantic");
    expect(automatic.structuredContent.returned_images).toBe(1);
    const explicit = await f.call("kb_search", { query: "团队合照", modality: "text", project_id: PROJECT, rerank: false });
    expect(explicit.structuredContent.resolved_modality).toBe("text");
    expect(explicit.structuredContent.results.every((row: any) => row.modality === "text")).toBe(true);
    const read = await f.call("kb_read", { resource_id: found.structuredContent.results[0].uri });
    expect(read.isError).not.toBe(true);
    expect(Buffer.from(read.content.find((block: any) => block.type === "image").data, "base64")).toEqual(PNG);
    const denied = await f.call("kb_read", { resource_id: "kb://artifact/artifact%3Ahidden-image/image/0" });
    expect(denied.isError).toBe(true);
    expect(denied.content.some((block: any) => block.type === "image")).toBe(false);
    expect(JSON.stringify(denied)).not.toContain("HIDDEN_PIXELS");
  });

  test("secret documents never reach the embedding provider or related-conflict response", async () => {
    const f = await fixture();
    await f.artifact("artifact:visible", "王澄担任应急联络员。");
    await f.artifact("artifact:hidden", "HIDDEN_BODY 王澄担任应急联络员。", "secret", { title: "HIDDEN_TITLE" });
    await f.runtime.upsertRecord({ id: "conflict:hidden", title: "HIDDEN_CONFLICT", type: "conflict", status: "open", confidentiality: "restricted", project_id: PROJECT, created_by: "fixture", artifact_refs: ["artifact:visible"], suggested_user_question: "HIDDEN_QUESTION" });
    await f.runtime.rebuildRetrieval(true);
    expect(f.textCalls.join("\n")).not.toMatch(/HIDDEN_/);
    const result = await f.call("kb_search", { query: "现场安全带队由哪个人负责", mode: "semantic", modality: "text", project_id: PROJECT, rerank: false });
    expect(result.structuredContent.results.map((row: any) => row.id)).toEqual(["artifact:visible"]);
    expect(result.structuredContent.related_conflicts).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/HIDDEN_|artifact:hidden|conflict:hidden/);
    const denied = await f.call("kb_search", { query: "HIDDEN_BODY", include_unverified: true });
    expect(denied.isError).toBe(true);
  });

  test("source updates invalidate search and read cursors rather than mixing revisions", async () => {
    const f = await fixture();
    for (const id of ["artifact:a", "artifact:b", "artifact:c"]) await f.artifact(id, `# 档案\n调查纪要 ${"旧版本正文。".repeat(120)}`);
    const args = { query: "调查纪要", intent: "collect", mode: "lexical", modality: "text", project_id: PROJECT, top_k: 1, rerank: false };
    const first = await f.call("kb_search", args);
    expect(first.structuredContent.next_cursor).toBeTruthy();
    const initialRead = await f.call("kb_read", { resource_id: "kb://artifact/artifact%3Aa/document", max_tokens: 100 });
    expect(initialRead.structuredContent.next_cursor).toBeTruthy();
    await f.artifact("artifact:a", `# 档案\n调查纪要 ${"新版本正文。".repeat(120)}`);
    const staleSearch = await f.call("kb_search", { ...args, cursor: first.structuredContent.next_cursor });
    expect(staleSearch.isError).toBe(true);
    expect(JSON.stringify(staleSearch)).toMatch(/revision|scope|stale/);
    const staleRead = await f.call("kb_read", { resource_id: "kb://artifact/artifact%3Aa/document", max_tokens: 100, cursor: initialRead.structuredContent.next_cursor });
    expect(staleRead.isError).toBe(true);
    expect(JSON.stringify(staleRead)).toContain("stale");
  });

  test("related conflicts follow matched source evidence even when their title does not match the query", async () => {
    const f = await fixture();
    await f.artifact("artifact:date", "调查安排：集合日期为九月九日。");
    await f.runtime.upsertRecord({ id: "conflict:calendar", type: "conflict", title: "尚待确认的版本分歧", status: "open", project_id: PROJECT, created_by: "fixture", artifact_refs: ["artifact:date"], suggested_user_question: "请确认两个原始日期中的哪一个有效？" });
    const found = await f.call("kb_search", { query: "集合日期 九月九日", mode: "lexical", modality: "text", project_id: PROJECT, rerank: false });
    expect(found.isError).not.toBe(true);
    expect(found.structuredContent.results.map((row: any) => row.id)).toContain("artifact:date");
    expect(found.structuredContent.related_conflicts).toEqual([expect.objectContaining({ id: "conflict:calendar", status: "open", question: "请确认两个原始日期中的哪一个有效？" })]);
  });

  test("structure plans deep linked sources while global recall also finds unlinked evidence and reports missing source content", async () => {
    const f = await fixture();
    await f.artifact("artifact:linked", "王澄负责现场统筹。");
    await f.artifact("artifact:deep", "王澄负责嵌套子专题中的应急联络。");
    await f.artifact("artifact:unlinked", "王澄负责独立材料中的集合清点。");
    await f.artifact("artifact:secret-linked", "HIDDEN_STRUCTURAL_SOURCE", "secret");
    await f.runtime.upsertRecord({ id: "artifact:missing-body", title: "测绘职责附件", type: "artifact", status: "parsed", project_id: PROJECT, created_by: "fixture",
      normalized_markdown_path: "normalized/does-not-exist.md", mime_type: "text/markdown" });
    for (let depth = 0; depth < 6; depth++) {
      await f.runtime.upsertRecord({ id: `section:depth-${depth}`, type: "knowledge_section", title: depth === 0 ? "测绘职责" : `子专题 ${depth}`, status: "active", project_id: PROJECT, created_by: "fixture",
        parent_ref: depth ? `section:depth-${depth - 1}` : PROJECT,
        child_section_refs: depth < 5 ? [`section:depth-${depth + 1}`] : [],
        artifact_refs: depth === 0 ? ["artifact:linked", "artifact:missing-body", "artifact:secret-linked"] : depth === 5 ? ["artifact:deep"] : [],
      }, depth === 0 ? "# 测绘职责\n\n## 人员分工\n\n## 应急流程\n" : `# 子专题 ${depth}\n`);
    }
    await f.runtime.rebuildRetrieval(true);
    const result = await f.call("kb_search", { query: "测绘职责 安全带队", mode: "hybrid", intent: "collect", modality: "text", project_id: PROJECT, top_k: 100, rerank: false });
    expect(result.isError).not.toBe(true);
    const data = result.structuredContent;
    const ids = data.results.map((row: any) => row.id);
    expect(ids).toEqual(expect.arrayContaining(["artifact:linked", "artifact:deep", "artifact:unlinked"]));
    expect(data.retrieval_plan.selected_sections.map((section: any) => section.id)).toEqual(expect.arrayContaining(Array.from({ length: 6 }, (_, depth) => `section:depth-${depth}`)));
    expect(data.retrieval_plan.planned_artifact_ids.sort()).toEqual(["artifact:deep", "artifact:linked", "artifact:missing-body"]);
    expect(data.retrieval_plan.facets).toEqual(expect.arrayContaining([expect.objectContaining({ label: "人员分工", source: "heading" }), expect.objectContaining({ label: "应急流程", source: "heading" })]));
    expect(data.coverage.structure_is_recall_boundary).toBe(false);
    expect(data.coverage.returned_unlinked_sources).toContain("artifact:unlinked");
    expect(data.coverage.missing_documents).toContain("artifact:missing-body");
    expect(data.coverage.planned_sources_without_content).toContain("artifact:missing-body");
    expect(data.coverage.fact_completeness).toBe("not_proven");
    expect(JSON.stringify(result)).not.toMatch(/HIDDEN_STRUCTURAL_SOURCE|artifact:secret-linked/);
  });
});
