import { z } from "zod";

export const MAINTENANCE_HARNESS_VERSION = "0.1.0";
export const MAINTENANCE_PROMPT_VERSION = "argon-memory-maintenance/0.1.0";
export const MAINTENANCE_TOOL_SCHEMA_VERSION = "argon-memory-maintenance-tools/0.1.0";
export const DEFAULT_MAINTENANCE_MODEL = "operator-configured";

export const evidenceLocatorSchema = z.object({
  page: z.number().int().positive().optional(),
  slide: z.number().int().positive().optional(),
  section: z.string().max(500).optional(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  sheet: z.string().max(240).optional(),
  cell_range: z.string().max(80).optional(),
  start_ms: z.number().int().nonnegative().optional(),
  end_ms: z.number().int().positive().optional(),
});

export const mediaDescriptorSchema = z.object({
  evidence_id: z.string().min(1),
  artifact_id: z.string().min(1),
  modality: z.enum(["image", "video"]),
  mime_type: z.string().min(3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  locator: evidenceLocatorSchema,
  transport: z.enum(["base64_data_uri", "signed_url"]),
  value: z.string().min(1),
  expires_at: z.string().datetime().optional(),
  native_video_required: z.boolean().default(false),
});

export const maintenanceBudgetSchema = z.object({
  max_tool_calls: z.number().int().min(1).max(8).default(8),
  max_cumulative_input_tokens: z.number().int().min(1).max(12000).default(12000),
  max_context_tokens_per_step: z.number().int().min(1).max(6000).default(6000),
  max_cumulative_output_tokens: z.number().int().min(1).max(3000).default(3000),
  max_sections: z.number().int().min(1).max(6).default(6),
  max_evidence_units: z.number().int().min(1).max(40).default(40),
  max_multimodal_assets: z.number().int().min(0).max(12).default(12),
  max_cost_usd: z.number().positive(),
});

export const changePacketSchema = z.object({
  schema: z.literal("argon-memory-change-packet/v1"),
  packet_id: z.string().min(1),
  project_id: z.string().min(1),
  idempotency_key: z.string().min(8),
  trigger: z.enum(["artifact_parsed", "resource_published", "context_captured", "work_finished", "user_resolution_locked", "stale_evidence", "calibration", "legacy_proposal"]),
  base_revisions: z.object({
    knowledge_revision: z.string().min(1),
    topology_revision: z.string().min(1),
    index_revision: z.string().min(1),
  }),
  evidence_refs: z.array(z.string()).max(40),
  candidate_section_refs: z.array(z.string()).max(6),
  open_conflict_refs: z.array(z.string()).max(30),
  text_context: z.string().max(24000),
  media: z.array(mediaDescriptorSchema).max(12),
  budget: maintenanceBudgetSchema,
  egress_policy: z.object({ maximum_confidentiality: z.enum(["public", "internal", "restricted"]), provider: z.string().min(1), region: z.string().min(1) }),
  locked_user_resolution_ref: z.string().optional(),
});

const evidenceRefs = z.array(z.string().min(1)).min(1).max(40);
const documentPatchSchema = z.object({
  target_ref: z.string().min(1),
  expected_revision: z.string().min(1),
  block_key: z.string().min(1).max(160),
  previous_block_hash: z.string().regex(/^[a-f0-9]{64}$/),
  replacement_markdown: z.string().max(80000),
  evidence_refs: evidenceRefs,
  reason: z.string().min(3).max(1000),
});

export const maintenanceOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("no_change"), reason: z.string().min(3).max(1000) }),
  z.object({ op: z.literal("patch_main"), patch: documentPatchSchema }),
  z.object({ op: z.literal("patch_section"), patch: documentPatchSchema }),
  z.object({ op: z.literal("create_section"), proposal: z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/), title: z.string().min(2), summary: z.string().min(8), markdown: z.string().min(8), evidence_refs: evidenceRefs }) }),
  z.object({ op: z.literal("update_topology"), patch: z.object({ target_ref: z.string(), expected_revision: z.string(), add_refs: z.array(z.string()).max(50), evidence_refs: evidenceRefs }) }),
  z.object({ op: z.literal("register_conflict"), conflict: z.object({ topic: z.string().min(2), claim_variants: z.array(z.string().min(1)).min(2), evidence_refs: evidenceRefs, suggested_user_question: z.string().min(3) }) }),
  z.object({ op: z.literal("observe_conflict"), observation: z.object({ conflict_id: z.string(), expected_conflict_revision: z.string(), target_claim_variant_refs: z.array(z.string()).min(1), evidence_refs: evidenceRefs }) }),
]);

export const maintenancePlanSchema = z.object({
  schema: z.literal("argon-memory-maintenance-plan/v1"),
  packet_id: z.string().min(1),
  base_knowledge_revision: z.string().min(1),
  expected_topology_revision: z.string().min(1),
  prompt_version: z.literal(MAINTENANCE_PROMPT_VERSION),
  tool_schema_version: z.literal(MAINTENANCE_TOOL_SCHEMA_VERSION),
  operations: z.array(maintenanceOperationSchema).min(1).max(20),
  native_video_evidence_ids: z.array(z.string()).max(12).default([]),
  typed_resolution: z.object({
    conflict_id: z.string().min(1),
    locked_user_resolution_ref: z.string().min(1),
    outcome: z.enum(["supersede_one_claim", "accept_multiple_claims_with_narrowed_scopes", "reject_all_claims_and_record_new_statement", "reject_candidate_claim", "remain_open"]),
    affected_claim_refs: z.array(z.string()).max(50),
    resulting_scopes: z.array(z.string()).max(50),
  }).optional(),
});

export type ChangePacket = z.infer<typeof changePacketSchema>;
export type MaintenancePlan = z.infer<typeof maintenancePlanSchema>;
export type MaintenanceBudget = z.infer<typeof maintenanceBudgetSchema>;

const PROTECTED_BLOCK = /(?:^|[-_:])(conflicts?|global[-_]conflict|conflict[-_]refs?)(?:$|[-_:])|冲突/i;

export function validateMaintenancePlan(packetInput: unknown, planInput: unknown): MaintenancePlan {
  const packet = changePacketSchema.parse(packetInput);
  const plan = maintenancePlanSchema.parse(planInput);
  if (plan.packet_id !== packet.packet_id) throw new Error("Maintenance plan packet_id mismatch");
  if (plan.base_knowledge_revision !== packet.base_revisions.knowledge_revision) throw new Error("Maintenance plan is stale");
  if (plan.expected_topology_revision !== packet.base_revisions.topology_revision) throw new Error("Maintenance topology revision mismatch");
  for (const operation of plan.operations) {
    if ((operation.op === "patch_main" || operation.op === "patch_section") && PROTECTED_BLOCK.test(operation.patch.block_key)) {
      throw new Error("Generic maintenance patches cannot modify conflict-protected blocks");
    }
    const refs = operation.op === "no_change" ? []
      : operation.op === "patch_main" || operation.op === "patch_section" ? operation.patch.evidence_refs
      : operation.op === "create_section" ? operation.proposal.evidence_refs
      : operation.op === "update_topology" ? operation.patch.evidence_refs
      : operation.op === "register_conflict" ? operation.conflict.evidence_refs
      : operation.observation.evidence_refs;
    if (refs.some(ref => !packet.evidence_refs.includes(ref) && ref !== packet.locked_user_resolution_ref)) throw new Error("Maintenance plan references evidence outside the ChangePacket");
  }
  const requiredNativeVideos = packet.media.filter(item => item.modality === "video" && item.native_video_required).map(item => item.evidence_id);
  for (const id of plan.native_video_evidence_ids) {
    const descriptor = packet.media.find(item => item.evidence_id === id && item.modality === "video");
    if (!descriptor) throw new Error(`Plan claims unknown native video evidence: ${id}`);
  }
  if (requiredNativeVideos.some(id => !plan.native_video_evidence_ids.includes(id))) throw new Error("Required native video was not acknowledged by the maintenance model");
  if (packet.locked_user_resolution_ref) {
    if (!plan.typed_resolution || plan.typed_resolution.locked_user_resolution_ref !== packet.locked_user_resolution_ref) throw new Error("Locked user resolution requires a matching typed_resolution");
    if (!packet.open_conflict_refs.includes(plan.typed_resolution.conflict_id)) throw new Error("typed_resolution conflict is not routed in the packet");
  } else if (plan.typed_resolution) throw new Error("typed_resolution requires a locked user resolution packet");
  return plan;
}
