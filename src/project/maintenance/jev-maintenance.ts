import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectRuntime } from "../runtime.js";
import type { ChangePacket } from "./contracts.js";
import { JevHttpEvaluator, JEV_ROUTING_VERSION, type JevEvaluator } from "./jev-provider.js";
import { buildRoutingSnapshot, judgeRouting, routingHash, type RoutingJudgment, type RoutingSnapshot } from "./jev-routing.js";

export type JevMode = "off" | "shadow" | "advisory";
export type JevMaintenanceOptions = { mode: JevMode; allowEgress: boolean; evaluator?: JevEvaluator };
export type JevRoutingReceipt = {
  schema: "argon-memory-jev-receipt/v1"; version: string; packet_id: string; mode: JevMode; status: string;
  created_at: string; elapsed_ms: number; judgment?: RoutingJudgment; error_code?: string;
  knowledge_revision?: string; topology_revision?: string; evidence_hashes?: Array<{ id: string; sha256: string }>;
  selected_section_refs?: string[];
};

export function jevMaintenanceOptions(env: NodeJS.ProcessEnv = process.env): JevMaintenanceOptions {
  const mode = env.ARGON_MEMORY_MAINTENANCE_MODE === "offline" ? "off"
    : env.ARGON_MEMORY_JEV_MODE === "shadow" || env.ARGON_MEMORY_JEV_MODE === "advisory" ? env.ARGON_MEMORY_JEV_MODE : "off";
  const allowEgress = env.ARGON_MEMORY_JEV_EGRESS_ALLOWED === "true";
  return { mode, allowEgress, ...(mode !== "off" && allowEgress && env.TYPESAFE_API_KEY ? { evaluator: new JevHttpEvaluator(env.TYPESAFE_API_KEY) } : {}) };
}

export class JevMaintenanceAdvisor {
  private failures = 0;
  private retryAfter = 0;
  constructor(private readonly options: JevMaintenanceOptions = jevMaintenanceOptions()) {}

  async prepare(runtime: ProjectRuntime, input: ChangePacket): Promise<{ packet: ChangePacket; receipt: JevRoutingReceipt }> {
    // Always rebuild normal mutable blocks, including when Jev is unavailable.
    // An old model opinion is never retained when mode changes or a retry fails.
    const { semantic_routing: _oldAdvice, ...original } = input;
    let packet = await runtime.refreshMaintenancePacket(original);
    const started = Date.now();
    const receipt: JevRoutingReceipt = { schema: "argon-memory-jev-receipt/v1", version: JEV_ROUTING_VERSION,
      packet_id: input.packet_id, mode: this.options.mode, status: "disabled", created_at: new Date().toISOString(), elapsed_ms: 0 };
    if (this.options.mode === "off") return { packet, receipt };
    if (!this.options.allowEgress) receipt.status = "egress_not_authorized";
    else if (!this.options.evaluator) receipt.status = "missing_key";
    else if (Date.now() < this.retryAfter) receipt.status = "circuit_open";
    else {
      try {
        const snapshot = await buildRoutingSnapshot(runtime, packet);
        receipt.knowledge_revision = snapshot.knowledge_revision; receipt.topology_revision = snapshot.topology_revision;
        receipt.evidence_hashes = snapshot.evidence.map(({ id, sha256 }) => ({ id, sha256 }));
        const stillCurrent = async () => {
          const pointer = await runtime.revisionStore.pointer();
          return (pointer?.knowledge_revision ?? "legacy") === snapshot.knowledge_revision
            && (pointer?.topology_revision ?? "legacy") === snapshot.topology_revision;
        };
        const judgment = await judgeRouting(snapshot, this.options.evaluator, stillCurrent);
        // Re-read source bytes as well as revisions. A changed normalization
        // output or confidentiality must invalidate even a successful response.
        if (routingHash(await buildRoutingSnapshot(runtime, packet)) !== routingHash(snapshot)) throw new Error("jev_stale_snapshot");
        receipt.judgment = judgment;
        this.failures = 0;
        if (this.options.mode === "shadow") receipt.status = "shadow";
        else {
          packet = this.augment(packet, snapshot, judgment);
          packet = await runtime.refreshMaintenancePacket(packet);
          if (!await stillCurrent() || !packet.semantic_routing) throw new Error("jev_stale_snapshot");
          receipt.status = "advisory"; receipt.selected_section_refs = packet.candidate_section_refs;
        }
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        receipt.error_code = /^jev_(stale_snapshot|no_candidates|input_budget|invalid_response|model_changed|unavailable|timeout|http_\d{3}|request_budget|response_budget|missing_key|question_budget)$/.test(code) ? code : "jev_unavailable";
        receipt.status = "fallback";
        if (receipt.error_code !== "jev_no_candidates" && receipt.error_code !== "jev_stale_snapshot" && ++this.failures >= 3) this.retryAfter = Date.now() + 60_000;
        packet = await runtime.refreshMaintenancePacket(original);
      }
    }
    receipt.elapsed_ms = Date.now() - started;
    await this.saveReceipt(runtime.root, receipt);
    return { packet, receipt };
  }

  private augment(packet: ChangePacket, snapshot: RoutingSnapshot, judgment: RoutingJudgment): ChangePacket {
    const eligible = new Set(snapshot.sections.map(section => section.id));
    // Retain deterministic candidates, including those outside Jev's bounded
    // catalog, and only fill free slots. A low probability never removes one.
    const candidates = [...new Set(packet.candidate_section_refs)];
    const suggestions = judgment.suggested_section_refs.filter(id => eligible.has(id));
    for (const id of suggestions) if (!candidates.includes(id) && candidates.length < packet.budget.max_sections) candidates.push(id);
    const warnings = [...judgment.warnings];
    if (suggestions.some(id => !candidates.includes(id))) warnings.push("maintenance_section_budget_exhausted");
    return { ...packet, candidate_section_refs: candidates,
      semantic_routing: { schema: "argon-memory-routing-advice/v1", provider: "typesafe", model: judgment.model, state_hash: judgment.state_hash,
        knowledge_revision: snapshot.knowledge_revision, topology_revision: snapshot.topology_revision,
        suggested_section_refs: suggestions.filter(id => candidates.includes(id)), warnings } };
  }

  private async saveReceipt(root: string, receipt: JevRoutingReceipt): Promise<void> {
    const directory = join(root, "maintenance", "jev-receipts");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${routingHash(receipt)}.json`), staging = `${path}.${process.pid}.tmp`;
    // Only identifiers, hashes, scores and sanitized status; no passages, URLs,
    // source metadata, request bodies, headers or provider error bodies.
    await writeFile(staging, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    await rename(staging, path);
  }
}
