import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { MAINTENANCE_PROMPT_VERSION, MAINTENANCE_TOOL_SCHEMA_VERSION, changePacketSchema, maintenancePlanJsonSchema, validateMaintenancePlan, type ChangePacket, type MaintenancePlan } from "./contracts.js";

export type MsAgentAdapterOptions = {
  pythonExecutable?: string;
  workerPath?: string;
  mode?: "offline" | "live";
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
};

function defaultWorkerPath(): string {
  return fileURLToPath(new URL("../../backends/python/cyj_maintenance_worker.py", import.meta.url));
}

export function isRetryableMaintenanceFailure(message: string): boolean {
  return /timeout|429|5\d\d|temporar|connection/i.test(message)
    || /model (did not submit a terminal maintenance plan|returned an incomplete maintenance plan|returned an invalid maintenance plan schema)/i.test(message);
}

export function normalizeModelMaintenancePlan(packet: ChangePacket, input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const raw = input as Record<string, unknown>;
  const operations = Array.isArray(raw.operations) ? raw.operations.map(operation => {
    if (!operation || typeof operation !== "object") return operation;
    const value = operation as Record<string, unknown>;
    if (value.op === "patch_main" || value.op === "patch_section") {
      const { op: originalOp, ...fields } = value;
      const patch = value.patch && typeof value.patch === "object" ? value.patch as Record<string, unknown> : fields;
      // Target identity is code-owned. Correct the operation label without
      // inventing a target, revision, hash, evidence reference, or patch text.
      const op = patch.target_ref === packet.project_id ? "patch_main"
        : typeof patch.target_ref === "string" && packet.candidate_section_refs.includes(patch.target_ref) ? "patch_section" : originalOp;
      return { ...value, op, patch };
    }
    return operation;
  }) : raw.operations;
  return {
    ...raw,
    schema: "argon-memory-maintenance-plan/v1",
    packet_id: packet.packet_id,
    base_knowledge_revision: packet.base_revisions.knowledge_revision,
    expected_topology_revision: packet.base_revisions.topology_revision,
    prompt_version: MAINTENANCE_PROMPT_VERSION,
    tool_schema_version: MAINTENANCE_TOOL_SCHEMA_VERSION,
    operations,
    native_video_evidence_ids: Array.isArray(raw.native_video_evidence_ids) ? raw.native_video_evidence_ids : [],
  };
}

export class MsAgentMaintenanceAdapter {
  readonly options: Required<Pick<MsAgentAdapterOptions, "pythonExecutable" | "workerPath" | "mode" | "timeoutMs">> & Omit<MsAgentAdapterOptions, "pythonExecutable" | "workerPath" | "mode" | "timeoutMs">;

  constructor(options: MsAgentAdapterOptions = {}) {
    this.options = {
      pythonExecutable: options.pythonExecutable ?? process.env.ARGON_MEMORY_MAINTENANCE_PYTHON ?? "python3",
      workerPath: options.workerPath ?? defaultWorkerPath(),
      mode: options.mode ?? "live",
      timeoutMs: options.timeoutMs ?? 120_000,
      model: options.model,
      baseUrl: options.baseUrl,
    };
  }

  async propose(packetInput: ChangePacket): Promise<MaintenancePlan> {
    const packet = changePacketSchema.parse(packetInput);
    const requestId = randomUUID();
    const response = await this.call({
      request_id: requestId,
      method: "propose",
      mode: this.options.mode,
      packet,
      options: { model: this.options.model, base_url: this.options.baseUrl, plan_schema: maintenancePlanJsonSchema },
    });
    if (response.request_id !== requestId || response.ok !== true) throw new Error(String(response.error ?? "Invalid MS-Agent worker response"));
    try {
      return validateMaintenancePlan(packet, normalizeModelMaintenancePlan(packet, response.result));
    } catch (error) {
      if (error instanceof ZodError) {
        // Retry a new proposal within the queue's existing attempt limit.
        // Keep field paths, never echo supplied values or repair model hashes.
        const fields = error.issues.map(issue => `${issue.path.join(".")}:${issue.code}`).join(", ").slice(0, 900);
        throw new Error(`Model returned an invalid maintenance plan schema: ${fields}`);
      }
      throw error;
    }
  }

  async selfTest(): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    const response = await this.call({ request_id: requestId, method: "self_test" });
    if (response.request_id !== requestId || response.ok !== true || !response.result || typeof response.result !== "object") throw new Error(String(response.error ?? "MS-Agent worker self-test failed"));
    return response.result as Record<string, unknown>;
  }

  private async call(request: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.pythonExecutable, [this.options.workerPath], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      const output = createInterface({ input: child.stdout });
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("MS-Agent maintenance worker timed out"));
      }, this.options.timeoutMs);
      child.stderr.on("data", chunk => { stderr += String(chunk).slice(0, 4000); });
      output.once("line", line => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        try { resolve(JSON.parse(line) as Record<string, unknown>); }
        catch { reject(new Error(`Invalid MS-Agent worker JSON: ${line.slice(0, 500)}`)); }
      });
      child.once("error", error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
      child.once("exit", code => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`MS-Agent worker exited ${code}: ${stderr}`)); } });
      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
  }
}
