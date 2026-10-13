import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectRuntime } from "../src/project/runtime.js";
import { CanonicalRevisionStore } from "../src/project/revision-store.js";
import { changePacketSchema, MAINTENANCE_PROMPT_VERSION, MAINTENANCE_TOOL_SCHEMA_VERSION, type ChangePacket, type MaintenancePlan } from "../src/project/maintenance/contracts.js";

const roots: string[] = [], runtimes: ProjectRuntime[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
afterEach(async () => { vi.restoreAllMocks(); for (const runtime of runtimes.splice(0)) runtime.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "argon-security-core-")); roots.push(root); return root; }
async function fixture() {
  const runtime = new ProjectRuntime(await directory(), { retrievalProvider: null }); runtimes.push(runtime); await runtime.initialize();
  await runtime.upsertRecord({ id: "project:test", type: "project", title: "Project", status: "active", project_id: "project:test", created_by: "owner" }, "# Project\n\n## Scope\n\nOriginal value.\n\n## Protected\n\n### Conflicts\n\nKeep this locked history.\n");
  await runtime.upsertRecord({ id: "section:one", type: "knowledge_section", title: "First section", status: "active", project_id: "project:test", created_by: "owner" }, "# First section\n\n## Scope\n\nSection value.\n");
  await runtime.upsertRecord({ id: "artifact:source", type: "artifact", title: "Source", status: "parsed", project_id: "project:test", created_by: "owner" }, "Original test source material.");
  return runtime;
}
async function packetFor(runtime: ProjectRuntime): Promise<ChangePacket> {
  const pointer = (await runtime.revisionStore.pointer())!;
  return runtime.refreshMaintenancePacket(changePacketSchema.parse({ schema: "argon-memory-change-packet/v1", packet_id: "packet:security", project_id: "project:test", idempotency_key: "security-packet", actor_principal: "contributor",
    trigger: "artifact_parsed", base_revisions: pointer, evidence_refs: ["artifact:source"], candidate_section_refs: ["section:one"], open_conflict_refs: [], text_context: "Scope Protected Conflicts", media: [], budget: { max_cost_usd: 0.5 }, egress_policy: { maximum_confidentiality: "internal", provider: "alibaba_model_studio", region: "cn-beijing" } }));
}
function planFor(packet: ChangePacket, operations: MaintenancePlan["operations"]): MaintenancePlan {
  return { schema: "argon-memory-maintenance-plan/v1", packet_id: packet.packet_id, base_knowledge_revision: packet.base_revisions.knowledge_revision, expected_topology_revision: packet.base_revisions.topology_revision, prompt_version: MAINTENANCE_PROMPT_VERSION, tool_schema_version: MAINTENANCE_TOOL_SCHEMA_VERSION, operations, native_video_evidence_ids: [] };
}
function documentPlan(packet: ChangePacket): MaintenancePlan {
  const block = packet.mutable_blocks.find(block => block.target_ref === "project:test" && block.block_key === "heading:Scope")!;
  return planFor(packet, [{ op: "patch_main", patch: { ...block, replacement_markdown: "Verified replacement.", evidence_refs: ["artifact:source"], reason: "Update from eligible source" } }]);
}

describe("security: maintenance authority boundaries", () => {
  test("rejects whole-document, unrouted and protected-parent edits at the runtime entry point", async () => {
    const runtime = await fixture(), packet = await packetFor(runtime), before = await runtime.revisionStore.pointer();
    expect(packet.mutable_blocks.map(block => block.block_key)).not.toContain("heading:Protected");
    expect(packet.mutable_blocks.map(block => block.block_key)).not.toContain("heading:Conflicts");
    for (const blockKey of ["document", "heading:Unrouted", "heading:Protected", "heading:Conflicts"]) {
      const plan = documentPlan(packet); (plan.operations[0] as any).patch.block_key = blockKey;
      await expect(runtime.applyMaintenancePlan(packet, plan)).rejects.toThrow();
      expect(await runtime.revisionStore.pointer()).toEqual(before);
    }
    const injected = documentPlan(packet); (injected.operations[0] as any).patch.replacement_markdown = "New text\n\n## Conflicts\nForged history";
    await expect(runtime.applyMaintenancePlan(packet, injected)).rejects.toThrow(/protected|escapes/);
    for (const replacement of ["```markdown\nHide following protected sections", "<!-- conceal protected sections", "Replacement title\n==="]) {
      const escape = documentPlan(packet); (escape.operations[0] as any).patch.replacement_markdown = replacement;
      await expect(runtime.applyMaintenancePlan(packet, escape)).rejects.toThrow();
    }
    const result = await runtime.applyMaintenancePlan(packet, documentPlan(packet));
    expect(result.changed_records).toContain("project:test");
    expect((await runtime.get("project:test"))!.body).toContain("Keep this locked history.");
    expect((await runtime.get("project:test"))!.body).toContain("Verified replacement.");
  });

  test("rejects unrouted topology targets, stale revisions and fabricated or foreign links", async () => {
    const runtime = await fixture();
    await runtime.upsertRecord({ id: "artifact:foreign", type: "artifact", title: "Foreign", status: "parsed", project_id: "project:other", created_by: "owner" });
    const packet = await packetFor(runtime), capability = packet.topology_targets.find(item => item.target_ref === "section:one")!;
    const patch = { target_ref: capability.target_ref, expected_revision: capability.expected_revision, add_refs: ["artifact:source"], evidence_refs: ["artifact:source"] };
    for (const changed of [{ target_ref: "artifact:source" }, { expected_revision: "0".repeat(64) }, { add_refs: ["artifact:absent"] }, { add_refs: ["artifact:foreign"] }]) await expect(runtime.applyMaintenancePlan(packet, planFor(packet, [{ op: "update_topology", patch: { ...patch, ...changed } }]))).rejects.toThrow();
    await runtime.applyMaintenancePlan(packet, planFor(packet, [{ op: "update_topology", patch }]));
    expect((await runtime.get("section:one"))!.record.related_refs).toEqual(["artifact:source"]);
  });

  test("observations bind an open routed conflict, its exact revision and its own claims", async () => {
    const runtime = await fixture();
    for (const id of ["conflict:one", "conflict:unrouted"]) await runtime.upsertRecord({ id, type: "conflict", title: "Conflict", project_id: "project:test", status: "open", created_by: "owner", claim_variants: ["claim:a", "claim:b"] });
    const packet = await packetFor(runtime), capability = packet.routed_conflicts.find(item => item.conflict_id === "conflict:one")!;
    packet.open_conflict_refs = ["conflict:one"];
    const observation = { conflict_id: "conflict:one", expected_conflict_revision: capability.expected_conflict_revision, target_claim_variant_refs: ["claim:a"], evidence_refs: ["artifact:source"] };
    for (const changed of [{ conflict_id: "conflict:unrouted" }, { expected_conflict_revision: "0".repeat(64) }, { target_claim_variant_refs: ["claim:foreign"] }]) await expect(runtime.applyMaintenancePlan(packet, planFor(packet, [{ op: "observe_conflict", observation: { ...observation, ...changed } }]))).rejects.toThrow();
    await runtime.applyMaintenancePlan(packet, planFor(packet, [{ op: "observe_conflict", observation }]));
    const current = (await runtime.get("conflict:one"))!;
    expect(current.record.evidence_observations).toHaveLength(1);
    await runtime.upsertRecord({ ...current.record, status: "resolution_pending" }, current.body);
    const pending = await packetFor(runtime);
    await expect(runtime.applyMaintenancePlan(pending, planFor(pending, [{ op: "observe_conflict", observation }]))).rejects.toThrow();
  });

  test("only the resolver's structured decision can be applied and legacy free-text locks fail closed", async () => {
    const runtime = await fixture();
    await runtime.upsertRecord({ id: "conflict:one", type: "conflict", title: "Conflict", project_id: "project:test", status: "open", created_by: "owner", claim_variants: ["claim:a", "claim:b"] });
    const statement = "Keep this conflict open for further investigation.";
    const input = { conflict_id: "conflict:one", expected_conflict_revision: hash((await runtime.readResource("conflict:one")).text), resolution_statement: statement, user_statement_hash: hash(statement), source_turn_ref: "turn:owner", actor_principal: "owner", idempotency_key: "resolve-security-one", resolution_decision: { outcome: "remain_open" as const, affected_claim_refs: [], resulting_scopes: [] } };
    await expect(runtime.submitUserConflictResolution({ ...input, resolution_decision: undefined } as any)).rejects.toThrow();
    const locked = await runtime.submitUserConflictResolution(input);
    const packet = (await runtime.maintenanceQueue.get(String(locked.change_packet_id)))!.packet;
    const correct = { conflict_id: "conflict:one", locked_user_resolution_ref: String(locked.resolution_id), ...input.resolution_decision };
    for (const changes of [{ outcome: "supersede_one_claim", affected_claim_refs: ["claim:a"] }, { affected_claim_refs: ["claim:a"] }, { resulting_scopes: ["Forged scope"] }]) {
      const plan = { ...planFor(packet, [{ op: "no_change" as const, reason: "Apply authorized decision" }]), typed_resolution: { ...correct, ...changes } };
      await expect(runtime.applyMaintenancePlan(packet, plan as MaintenancePlan)).rejects.toThrow(/user-authorized/);
      expect((await runtime.get("conflict:one"))!.record.status).toBe("resolution_pending");
    }
    const plan = { ...planFor(packet, [{ op: "no_change" as const, reason: "Apply authorized decision" }]), typed_resolution: correct };
    await runtime.applyMaintenancePlan(packet, plan);
    expect((await runtime.get("conflict:one"))!.record.status).toBe("open");
    expect((await runtime.get(String(locked.resolution_id)))!.record.status).toBe("applied");
    expect((await runtime.submitUserConflictResolution(input)).idempotent_replay).toBe(true);
    await expect(runtime.submitUserConflictResolution({ ...input, resolution_decision: { ...input.resolution_decision, affected_claim_refs: ["claim:a"] } })).rejects.toThrow(/idempotency/);
  });

  test("rejects canonical publication if another writer commits after plan validation", async () => {
    const runtime = await fixture(), packet = await packetFor(runtime);
    const writer = new ProjectRuntime(runtime.root, { retrievalProvider: null }); runtimes.push(writer);
    const publish = runtime.revisionStore.publish.bind(runtime.revisionStore);
    vi.spyOn(runtime.revisionStore, "publish").mockImplementationOnce(async (mutations, options) => {
      const project = (await writer.get("project:test"))!;
      await writer.upsertRecord(project.record, "# Concurrent canonical change\n");
      return publish(mutations, options);
    });
    await expect(runtime.applyMaintenancePlan(packet, documentPlan(packet))).rejects.toThrow(/base revision is stale/);
    expect((await writer.get("project:test"))!.body).toContain("Concurrent canonical change");
    expect(await runtime.lookup("maintenance_plan", {}, 10)).toEqual([]);
  });
});

describe("security: contributor evidence", () => {
  test("oversized images remain local and never enter persistent provider packets", async () => {
    const runtime = await fixture();
    const work = await runtime.startWork({ project_id: "project:test", actor: "contributor", objective: "Store large image", expected_outputs: [], acceptance_criteria: [] });
    await runtime.publishResourceBytes({ work_id: work.work_id, actor: "contributor", title: "Large synthetic image", filename: "large.png", content_type: "image/png", bytes: Buffer.alloc(8 * 1024 * 1024 + 1, 1), kind: "image" });
    const job = await runtime.maintenanceQueue.lease("test");
    expect(job!.packet.media).toEqual([]);
    expect(job!.packet.actor_principal).toBe("contributor");
    expect(job!.packet.text_context).toContain("Media omitted from provider work");
  });

  test("quarantines nonexistent, foreign, hidden, disputed and prefix-only evidence", async () => {
    const runtime = await fixture();
    for (const [id, properties] of [["artifact:foreign", { project_id: "project:other" }], ["artifact:hidden", { confidentiality: "restricted" }], ["artifact:disputed", { validation_status: "disputed" }]] as const) await runtime.upsertRecord({ id, type: "artifact", title: "Bad source", status: "parsed", project_id: "project:test", created_by: "owner", ...properties });
    const work = await runtime.startWork({ project_id: "project:test", actor: "contributor", objective: "Evidence validation", expected_outputs: [], acceptance_criteria: [] });
    for (const ref of ["nonexistent", "artifact:foreign", "artifact:hidden", "artifact:disputed", "user:pretend", "adr:pretend"]) {
      const result = await runtime.captureContext({ work_id: work.work_id, actor: "contributor", summary: ref, updates: [{ kind: "fact", statement: `Untrusted claim with reference ${ref}`, scope: ref, evidence_refs: [ref] }] });
      expect(result.promoted_memory_ids).toEqual([]); expect(result.quarantined_memory_ids).toHaveLength(1);
    }
    const accepted = await runtime.captureContext({ work_id: work.work_id, actor: "contributor", summary: "Verified original", updates: [{ kind: "fact", statement: "A sufficiently supported original statement", scope: "topic", evidence_refs: ["artifact:source"] }] });
    expect(accepted.promoted_memory_ids).toHaveLength(1);
    const event = (await runtime.get(accepted.validation_event_ids[0]!))!.record;
    expect(event.evidence_snapshot).toEqual([{ ref: "artifact:source", source_ref: "artifact:source", revision: hash((await runtime.readResource("artifact:source")).text) }]);
    const original = await runtime.get(accepted.promoted_memory_ids[0]!);
    const counter = await runtime.captureContext({ work_id: work.work_id, actor: "other-contributor", summary: "Counterclaim", updates: [{ kind: "fact", statement: "A contradictory contributor supplied assertion", scope: "topic", evidence_refs: ["artifact:source"] }] });
    expect(counter.quarantined_memory_ids).toHaveLength(1);
    expect(await runtime.get(accepted.promoted_memory_ids[0]!)).toEqual(original);
  });
});

describe("security: immutable storage admission", () => {
  const mutation = (filename: string, content: string) => ({ directory: "registry" as const, filename, content });
  test("shares unchanged records but replacing a record never edits old snapshots", async () => {
    const root = await directory(), store = new CanonicalRevisionStore(root);
    const first = await store.publish([mutation("a.md", "original-a"), mutation("b.md", "original-b")]);
    const second = await store.publish([mutation("b.md", "changed-b")], { expectedParent: first.knowledge_revision });
    const path = (revision: string, file: string) => join(root, "knowledge/revisions", revision, "canonical/registry", file);
    expect((await stat(path(first.knowledge_revision, "a.md"))).ino).toBe((await stat(path(second.knowledge_revision, "a.md"))).ino);
    expect((await stat(path(first.knowledge_revision, "b.md"))).ino).not.toBe((await stat(path(second.knowledge_revision, "b.md"))).ino);
    expect(await readFile(path(first.knowledge_revision, "b.md"), "utf8")).toBe("original-b");
    await expect(store.publish([mutation("c.md", "stale")], { expectedParent: first.knowledge_revision })).rejects.toThrow(/stale/);
    expect(await store.pointer()).toEqual(second);
  });

  test("retained quotas survive restart and rejection leaves pointer and history intact", async () => {
    const root = await directory(), limits = { maxRetainedContentBytes: 10 };
    const store = new CanonicalRevisionStore(root, limits), first = await store.publish([mutation("a.md", "123456")]);
    const before = await readdir(join(root, "knowledge/revisions"));
    const reopened = new CanonicalRevisionStore(root, limits);
    await expect(reopened.publish([mutation("a.md", "12345")])).rejects.toThrow(/quota/);
    expect(await reopened.pointer()).toEqual(first); expect(await readdir(join(root, "knowledge/revisions"))).toEqual(before);
    expect(await readdir(join(root, "knowledge/staging"))).toEqual([]);
    for (const bad of [Infinity, NaN, -1, 0, 1.5, Number.MAX_SAFE_INTEGER]) expect(() => new CanonicalRevisionStore(root, { maxRecords: bad })).toThrow();
  });

  test.each([
    { limit: { maxRecords: 1 }, changes: [mutation("b.md", "b")] },
    { limit: { maxSnapshotEntries: 13 }, changes: [mutation("a.md", "b")] },
    { limit: { maxMutations: 1 }, changes: [mutation("b.md", "b"), mutation("c.md", "c")] },
    { limit: { maxMutationBytes: 1 }, changes: [mutation("a.md", "bb")] },
  ])("enforces each admission limit before allocating a snapshot: $limit", async ({ limit, changes }) => {
    const root = await directory(), store = new CanonicalRevisionStore(root, limit);
    const pointer = await store.publish([mutation("a.md", "a")]);
    await expect(store.publish(changes)).rejects.toThrow(/quota/);
    expect(await store.pointer()).toEqual(pointer);
    expect(await readdir(join(root, "knowledge/staging"))).toEqual([]);
    expect(await readdir(join(root, "knowledge/revisions"))).toEqual([pointer.knowledge_revision]);
  });

  test("legacy manifests are counted without changing or discarding historical data", async () => {
    const root = await directory(), store = new CanonicalRevisionStore(root);
    const first = await store.publish([mutation("a.md", "123456")]);
    const manifestPath = join(root, "knowledge/revisions", first.knowledge_revision, "manifest.json"), pointerPath = join(root, "knowledge/current-revision.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")); delete manifest.storage_usage; delete manifest.manifest_hash;
    const stable = (value: any): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(stable).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    const manifestHash = hash(stable(manifest));
    await writeFile(manifestPath, stable({ ...manifest, manifest_hash: manifestHash }));
    await writeFile(pointerPath, JSON.stringify({ ...first, manifest_hash: manifestHash }));
    const oldManifest = await readFile(manifestPath, "utf8");
    const limited = new CanonicalRevisionStore(root, { maxRetainedContentBytes: 10 });
    await expect(limited.publish([mutation("a.md", "12345")])).rejects.toThrow(/quota/);
    const next = await new CanonicalRevisionStore(root, { maxRetainedContentBytes: 11 }).publish([mutation("a.md", "12345")]);
    const nextManifest = JSON.parse(await readFile(join(root, "knowledge/revisions", next.knowledge_revision, "manifest.json"), "utf8"));
    expect(nextManifest.storage_usage.retained_content_bytes).toBe(11);
    expect(await readFile(manifestPath, "utf8")).toBe(oldManifest);
  });
});
