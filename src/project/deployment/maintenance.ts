import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ProjectRuntime } from "../runtime.js";
import { MAINTENANCE_PROMPT_VERSION, MAINTENANCE_TOOL_SCHEMA_VERSION, type ChangePacket, type MaintenancePlan } from "../maintenance/contracts.js";
import { JevMaintenanceAdvisor } from "../maintenance/jev-maintenance.js";
import { MsAgentMaintenanceAdapter, isRetryableMaintenanceFailure } from "../maintenance/ms-agent-adapter.js";
import type { Deployment } from "./config.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const label = (text: string) => text.replace(/[\r\n]/g, " ").replace(/[\[\]\\]/g, "\\$&");

/** Offline baseline maintains source navigation, never synthesizes facts.
 * It uses the same evidence/atomic commit harness as a live Qwen proposal. */
export async function sourceCatalogPlan(runtime: ProjectRuntime, packet: ChangePacket): Promise<MaintenancePlan> {
  const operations: MaintenancePlan["operations"] = [];
  for (const ref of packet.evidence_refs) {
    const item = await runtime.get(ref);
    if (!item || item.record.type !== "artifact" || item.record.project_id !== packet.project_id || item.record.status !== "parsed" || ![undefined, "public", "internal"].includes(item.record.confidentiality)) continue;
    const key = `source-${hash(ref).slice(0, 20)}`;
    const existing = await runtime.lookup("knowledge_section", { project_id: packet.project_id, key }, 1);
    if (existing.length) continue;
    operations.push({ op: "create_section", proposal: { key, title: `Source: ${item.record.title}`, summary: "Registered original evidence; verify facts by reading the source.",
      markdown: `# ${label(item.record.title)}\n\n## Original evidence\n\n[Read source](kb://artifact/${encodeURIComponent(ref)}/document) · [Original file](kb://artifact/${encodeURIComponent(ref)}/raw)\n\nThis section records source navigation only. It does not establish the source's claims.\n`, evidence_refs: [ref] } });
    if (operations.length >= 6) break;
  }
  return { schema: "argon-memory-maintenance-plan/v1", packet_id: packet.packet_id, base_knowledge_revision: packet.base_revisions.knowledge_revision,
    expected_topology_revision: packet.base_revisions.topology_revision, prompt_version: MAINTENANCE_PROMPT_VERSION, tool_schema_version: MAINTENANCE_TOOL_SCHEMA_VERSION,
    operations: operations.length ? operations : [{ op: "no_change", reason: "No new parsed source navigation; catalog mode does not synthesize facts or resolve conflicts." }], native_video_evidence_ids: [] };
}

export async function runDeploymentMaintenance(runtime: ProjectRuntime, deployment: Deployment, options: { once?: boolean; signal?: AbortSignal } = {}): Promise<{ completed: number; failed: number }> {
  const owner = `knowledge-maintainer:${process.pid}`;
  const advisor = new JevMaintenanceAdvisor();
  const adapter = new MsAgentMaintenanceAdapter({ mode: "live", model: deployment.config.maintenance.model });
  let completed = 0, failed = 0;
  do {
    const job = await runtime.maintenanceQueue.lease(owner, 450_000);
    if (!job) { if (options.once) break; await delay(2000, undefined, { signal: options.signal }).catch(() => undefined); continue; }
    try {
      for (let retry = 0; ; retry++) {
        const { packet, receipt } = await advisor.prepare(runtime, job.packet);
        const plan = deployment.config.maintenance.mode === "qwen" ? await adapter.propose(packet) : await sourceCatalogPlan(runtime, packet);
        try {
          const result = await runtime.applyMaintenancePlan(packet, plan, owner);
          console.error(JSON.stringify({ event: "maintenance_committed", packet_id: packet.packet_id, mode: deployment.config.maintenance.mode, jev: receipt.status, changed: result.changed_records.length }));
          break;
        } catch (error) {
          if (retry >= 2 || !/base revision is stale|document revision conflict|section already exists/i.test(String(error))) throw error;
        }
      }
      await runtime.maintenanceQueue.complete(job.packet.packet_id, owner); completed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Maintenance failed";
      await runtime.maintenanceQueue.fail(job.packet.packet_id, owner, message, isRetryableMaintenanceFailure(message)); failed++;
      console.error(JSON.stringify({ event: "maintenance_failed", packet_id: job.packet.packet_id, message }));
    }
  } while (!options.signal?.aborted);
  return { completed, failed };
}
