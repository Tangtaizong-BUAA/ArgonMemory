import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectRuntime } from "../src/project/runtime.js";
import { changePacketSchema, type ChangePacket } from "../src/project/maintenance/contracts.js";
import { JevHttpEvaluator, type JevEvaluator, type JevQuestion } from "../src/project/maintenance/jev-provider.js";
import { JevMaintenanceAdvisor, jevMaintenanceOptions } from "../src/project/maintenance/jev-maintenance.js";
import { buildRoutingSnapshot, judgeRouting, sampleRoutingEvidence } from "../src/project/maintenance/jev-routing.js";

const runtimes: ProjectRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) { runtime.close(); await rm(runtime.root, { recursive: true, force: true }); } });

async function fixture(): Promise<{ runtime: ProjectRuntime; packet: ChangePacket }> {
  const root = await mkdtemp(join(tmpdir(), "argon-memory-jev-test-"));
  const runtime = new ProjectRuntime(root, { retrievalProvider: null }); runtimes.push(runtime); await runtime.initialize();
  await runtime.upsertRecord({ id: "project:test", type: "project", title: "Synthetic project", status: "active", project_id: "project:test", created_by: "test" }, "# Overview\n\n## Scope\n\nIndependent retrieval.\n");
  for (const [id, title, parent] of [["practice", "社会实践", "project:test"], ["tech", "测绘技术", "section:practice"], ["photos", "活动照片", "section:tech"], ["finance", "财务报销", "project:test"]]) {
    await runtime.upsertRecord({ id: `section:${id}`, type: "knowledge_section", title: title!, summary: `${title}的资料与证据`, status: "active", project_id: "project:test", parent_ref: parent, created_by: "test" }, `# ${title}\n\n## 已有记录\n\n待补充的独立章节。\n`);
  }
  await mkdir(join(root, "normalized"));
  await writeFile(join(root, "normalized/source.md"), "# Synthetic field note\n\n甲团队在虚构园区开展社区走访，测试航拍测绘流程，并保存活动合照。\n");
  await runtime.upsertRecord({ id: "artifact:sample", type: "artifact", title: "Synthetic sample", status: "parsed", project_id: "project:test", created_by: "test", normalized_markdown_path: "normalized/source.md" }, "");
  const pointer = (await runtime.revisionStore.pointer())!;
  const packet = changePacketSchema.parse({ schema: "argon-memory-change-packet/v1", packet_id: "packet:test", project_id: "project:test", idempotency_key: "synthetic-test",
    trigger: "artifact_parsed", base_revisions: { knowledge_revision: pointer.knowledge_revision, topology_revision: pointer.topology_revision, index_revision: pointer.index_revision },
    evidence_refs: ["artifact:sample"], candidate_section_refs: ["section:practice"], open_conflict_refs: ["conflict:existing"], text_context: "Synthetic source uploaded",
    media: [], budget: { max_cost_usd: 0.5 }, egress_policy: { maximum_confidentiality: "internal", provider: "alibaba_model_studio", region: "cn-beijing" } });
  return { runtime, packet };
}

function evaluator(probabilities: Record<string, number> = {}): JevEvaluator & { evaluate: ReturnType<typeof vi.fn> } {
  return { evaluate: vi.fn(async (state: { sections: Array<{ id: string }> }, questions: Record<string, JevQuestion>) => ({
    model: "jev-test", probabilities: Object.fromEntries(Object.keys(questions).map((key, index) => [key, probabilities[state.sections[index]!.id] ?? 0.9])), input_tokens: 100, output_tokens: 20,
  })) };
}

describe("Jev maintenance routing", () => {
  test("off and unauthorized modes make zero provider calls; offline overrides configuration", async () => {
    const { runtime, packet } = await fixture(), provider = evaluator();
    for (const mode of ["off", "shadow", "advisory"] as const) {
      const result = await new JevMaintenanceAdvisor({ mode, allowEgress: false, evaluator: provider }).prepare(runtime, packet);
      expect(result.packet.semantic_routing).toBeUndefined();
      expect(result.packet.candidate_section_refs).toEqual(packet.candidate_section_refs);
    }
    expect(provider.evaluate).not.toHaveBeenCalled();
    expect(jevMaintenanceOptions({ TYPESAFE_API_KEY: "test" }).mode).toBe("off");
    expect(jevMaintenanceOptions({ ARGON_MEMORY_MAINTENANCE_MODE: "offline", ARGON_MEMORY_JEV_MODE: "advisory", ARGON_MEMORY_JEV_EGRESS_ALLOWED: "true", TYPESAFE_API_KEY: "test" }).mode).toBe("off");
  });

  test("shadow records judgments without changing candidate selection or canonical revision", async () => {
    const { runtime, packet } = await fixture(), provider = evaluator();
    const before = await runtime.revisionStore.pointer();
    const result = await new JevMaintenanceAdvisor({ mode: "shadow", allowEgress: true, evaluator: provider }).prepare(runtime, packet);
    expect(result.receipt.status).toBe("shadow");
    expect(result.packet.candidate_section_refs).toEqual(packet.candidate_section_refs);
    expect(result.packet.semantic_routing).toBeUndefined();
    expect(await runtime.revisionStore.pointer()).toEqual(before);
    const paths = await readdir(join(runtime.root, "maintenance/jev-receipts"));
    const receipt = await readFile(join(runtime.root, "maintenance/jev-receipts", paths[0]!), "utf8");
    expect(receipt).toContain("section:photos");
    expect(receipt).not.toContain("甲团队");
    expect(receipt).not.toContain("normalized/source.md");
  });

  test("advisory adds multiple deep matches, preserves a low-scoring existing candidate and hydrates exact blocks", async () => {
    const { runtime, packet } = await fixture(), provider = evaluator({ "section:practice": 0.02, "section:tech": 0.95, "section:photos": 0.88, "section:finance": 0.1 });
    const before = await runtime.revisionStore.pointer();
    const result = await new JevMaintenanceAdvisor({ mode: "advisory", allowEgress: true, evaluator: provider }).prepare(runtime, packet);
    expect(result.packet.candidate_section_refs).toEqual(["section:practice", "section:tech", "section:photos"]);
    expect(result.packet.evidence_refs).toEqual(packet.evidence_refs);
    expect(result.packet.text_context).toContain("target_ref: section:photos");
    expect(result.packet.text_context).toContain("previous_block_hash:");
    expect(result.packet.semantic_routing?.suggested_section_refs).toEqual(["section:tech", "section:photos"]);
    const state = provider.evaluate.mock.calls[0]![0];
    expect(state.sections.find((s: any) => s.id === "section:photos").path).toEqual(["社会实践", "测绘技术"]);
    expect(await runtime.revisionStore.pointer()).toEqual(before);
    expect(changePacketSchema.parse(result.packet).semantic_routing).toBeDefined();
  });

  test("filters restricted, secret, foreign, disputed and unparsed materials before egress", async () => {
    const { runtime, packet } = await fixture();
    for (const [suffix, fields] of [["restricted", { confidentiality: "restricted" }], ["secret", { confidentiality: "secret" }], ["foreign", { project_id: "project:other" }], ["disputed", { status: "disputed" }], ["unparsed", { status: "registered" }]] as const) {
      await runtime.upsertRecord({ id: `artifact:${suffix}`, type: "artifact", title: "EXCLUDED_SOURCE", status: "parsed", project_id: "project:test", created_by: "test", normalized_markdown_path: "normalized/source.md", ...fields }, "EXCLUDED_BODY");
      packet.evidence_refs.push(`artifact:${suffix}`);
    }
    await runtime.upsertRecord({ id: "section:secret", type: "knowledge_section", title: "EXCLUDED_SECTION", status: "active", project_id: "project:test", confidentiality: "secret", created_by: "test" }, "# EXCLUDED_HEADING");
    packet.text_context = "STALE_PACKET_TEXT_MUST_NOT_LEAVE";
    const provider = evaluator();
    await new JevMaintenanceAdvisor({ mode: "shadow", allowEgress: true, evaluator: provider }).prepare(runtime, packet);
    const state = JSON.stringify(provider.evaluate.mock.calls);
    expect(state).not.toContain("EXCLUDED");
    expect(state).not.toContain("STALE_PACKET_TEXT");
    expect(state).not.toContain("artifact:restricted");
    expect(state).toContain("artifact:sample");
  });

  test("refuses normalization path escapes and symlinks; never sends artifact metadata as document body", async () => {
    const { runtime, packet } = await fixture();
    await symlink(join(runtime.root, "normalized/source.md"), join(runtime.root, "normalized/link.md"));
    for (const path of ["../../outside.md", "/etc/passwd", "normalized/link.md"]) {
      await runtime.upsertRecord({ id: "artifact:sample", type: "artifact", title: "UNREAD_SOURCE", status: "parsed", project_id: "project:test", created_by: "test", normalized_markdown_path: path }, "Metadata fallback is forbidden");
      const snapshot = await buildRoutingSnapshot(runtime, packet);
      expect(snapshot.evidence).toEqual([]);
      expect(snapshot.warnings).toContain("evidence_unreadable");
    }
  });

  test("samples document tail as well as beginning and reports bounded coverage", () => {
    const text = "BEGIN" + "x".repeat(15000) + "END_IMPORTANT_DETAIL";
    const sample = sampleRoutingEvidence("artifact:x", "sample", text);
    expect(sample.excerpts[0]!.text).toContain("BEGIN");
    expect(sample.excerpts.at(-1)!.text).toContain("END_IMPORTANT_DETAIL");
    expect(sample.excerpts).toHaveLength(4);
    for (const excerpt of sample.excerpts) expect(text.slice(excerpt.start_char, excerpt.end_char)).toBe(excerpt.text);
  });

  test("revision or source change during provider work discards advice", async () => {
    for (const change of ["revision", "source"] as const) {
      const { runtime, packet } = await fixture();
      const provider = evaluator();
      const regular = provider.evaluate.getMockImplementation()!;
      provider.evaluate.mockImplementation(async (...args: any[]) => {
        if (change === "source") await writeFile(join(runtime.root, "normalized/source.md"), "Changed source after classification began.");
        else await runtime.upsertRecord({ id: "section:extra", type: "knowledge_section", title: "Concurrent update", status: "active", project_id: "project:test", created_by: "test" }, "# Changed topology");
        return regular(...args);
      });
      const result = await new JevMaintenanceAdvisor({ mode: "advisory", allowEgress: true, evaluator: provider }).prepare(runtime, packet);
      expect(result.receipt.error_code).toBe("jev_stale_snapshot");
      expect(result.packet.semantic_routing).toBeUndefined();
      expect(result.packet.candidate_section_refs).toEqual(packet.candidate_section_refs);
    }
  });

  test("failure falls back and circuit breaker prevents repeated provider waits", async () => {
    const { runtime, packet } = await fixture(), provider = evaluator();
    provider.evaluate.mockRejectedValue(new Error("unsanitized request with secret and private content"));
    const advisor = new JevMaintenanceAdvisor({ mode: "advisory", allowEgress: true, evaluator: provider });
    for (let i = 0; i < 3; i++) {
      const result = await advisor.prepare(runtime, packet);
      expect(result.receipt.error_code).toBe("jev_unavailable");
      expect(JSON.stringify(result.receipt)).not.toContain("unsanitized");
      expect(result.packet.candidate_section_refs).toEqual(packet.candidate_section_refs);
    }
    expect((await advisor.prepare(runtime, packet)).receipt.status).toBe("circuit_open");
    expect(provider.evaluate).toHaveBeenCalledTimes(3);
  });

  test("full section slots remain intact and report unadmitted suggestions", async () => {
    const { runtime, packet } = await fixture();
    packet.budget.max_sections = 1;
    const result = await new JevMaintenanceAdvisor({ mode: "advisory", allowEgress: true, evaluator: evaluator() }).prepare(runtime, packet);
    expect(result.packet.candidate_section_refs).toEqual(["section:practice"]);
    expect(result.packet.semantic_routing?.warnings).toContain("maintenance_section_budget_exhausted");
  });

  test("bounded batches retain independent answers and check revision before each call", async () => {
    const { runtime, packet } = await fixture(), provider = evaluator();
    const snapshot = await buildRoutingSnapshot(runtime, packet);
    snapshot.sections = Array.from({ length: 33 }, (_, i) => ({ ...snapshot.sections[0]!, id: `section:${i}` }));
    const result = await judgeRouting(snapshot, provider);
    expect(result.calls).toBe(3); expect(result.scores).toHaveLength(33);
    expect(provider.evaluate.mock.calls.map(c => Object.keys(c[1]).length)).toEqual([16, 16, 1]);
    provider.evaluate.mockClear();
    let checks = 0;
    await expect(judgeRouting(snapshot, provider, async () => ++checks < 2)).rejects.toThrow("jev_stale_snapshot");
    expect(provider.evaluate).toHaveBeenCalledTimes(1);
  });
});

describe("TypeSafe HTTP boundary", () => {
  const questions: Record<string, JevQuestion> = { a: { type: "noul", instructions: "Relevant?", criteria: { true: "Relevant", false: "Irrelevant" } } };
  const response = (answers: unknown) => new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 2 } }));
  test("accepts documented Noul response and fixes endpoint, timeout and redirect policy", async () => {
    const fetcher = vi.fn(async () => response({ a: { type: "noul", noul: 0.9 } }));
    const result = await new JevHttpEvaluator("synthetic-key", fetcher as typeof fetch).evaluate({}, questions);
    expect(result.probabilities.a).toBe(0.9);
    const [url, options] = fetcher.mock.calls[0] as any;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(options.redirect).toBe("error"); expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  test.each([{}, { a: { type: "noul", noul: 1.2 } }, { a: { type: "score", score: 1 } }, { a: { type: "noul", noul: 0.9 }, extra: { type: "noul", noul: 0.8 } }])("rejects missing, out-of-range, wrong-type and unexpected answers", async answers => {
    await expect(new JevHttpEvaluator("synthetic", (async () => response(answers)) as typeof fetch).evaluate({}, questions)).rejects.toThrow("jev_invalid_response");
  });
  test("does not expose upstream error text or follow a redirect", async () => {
    await expect(new JevHttpEvaluator("synthetic", (async () => new Response("provider secret text", { status: 429 })) as typeof fetch).evaluate({}, questions)).rejects.toThrow("jev_http_429");
    await expect(new JevHttpEvaluator("synthetic", (async () => new Response("redirect", { status: 302, headers: { Location: "https://untrusted.invalid" } })) as typeof fetch).evaluate({}, questions)).rejects.toThrow("jev_http_302");
  });
});
