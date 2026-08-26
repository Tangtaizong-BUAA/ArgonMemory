/** Schema and cross-record validation for Argon Memory Markdown records. */

import type { KnowledgeRecord } from "./runtime.js";

export type ValidationIssue = {
  code: string;
  record_id: string;
  field?: string;
  message: string;
  severity: "error" | "warning";
};

const COMMON = ["id", "type", "title", "status", "project_id", "created_at", "updated_at", "created_by"] as const;
const CONFIDENTIALITY = new Set(["public", "internal", "restricted", "secret"]);
const TYPE_RULES: Record<string, { statuses: string[]; required: string[] }> = {
  project: { statuses: ["planned", "active", "paused", "completed", "archived"], required: ["mission"] },
  knowledge_section: { statuses: ["active", "archived"], required: ["key", "summary", "parent_ref", "revision_hash"] },
  workstream: { statuses: ["planned", "active", "paused", "completed", "archived"], required: ["key", "objective"] },
  work_item: { statuses: ["planned", "in_progress", "awaiting_closeout", "blocked", "completed", "cancelled"], required: ["objective", "acceptance_criteria"] },
  activity: { statuses: ["planned", "active", "completed", "cancelled"], required: ["kind", "occurred_at"] },
  person: { statuses: ["active", "inactive", "archived"], required: ["display_name"] },
  organization: { statuses: ["active", "inactive", "archived"], required: ["display_name"] },
  location: { statuses: ["active", "inactive", "archived"], required: ["display_name"] },
  artifact: { statuses: ["registered", "queued", "parsing", "parsed", "validating", "quarantined", "accepted", "indexed", "failed", "stale"], required: ["mime_type", "size_bytes", "sha256", "original_relative_path", "acquired_at"] },
  evidence: { statuses: ["proposed", "verified", "quarantined", "rejected", "stale"], required: ["artifact_id", "locator", "content_fingerprint"] },
  claim: { statuses: ["proposed", "supported", "disputed", "rejected", "superseded"], required: ["kind", "statement"] },
  decision: { statuses: ["proposed", "accepted", "rejected", "superseded"], required: ["question", "outcome", "decided_by", "decided_at", "rationale"] },
  deliverable: { statuses: ["planned", "draft", "review", "accepted", "published", "archived"], required: ["kind", "version", "artifact_refs"] },
  risk: { statuses: ["open", "monitoring", "mitigated", "occurred", "closed"], required: ["probability", "impact", "owner", "mitigation"] },
  issue: { statuses: ["open", "in_progress", "blocked", "resolved", "closed"], required: ["severity", "owner", "description"] },
  memory: { statuses: ["candidate", "validating", "quarantined", "accepted", "rejected", "disputed", "superseded"], required: ["kind", "statement", "scope", "source_work_id"] },
  validation_event: { statuses: ["completed", "failed"], required: ["subject_ref", "policy_id", "policy_version", "input_hash", "decision", "reason_codes", "trace_id"] },
  ingestion_job: { statuses: ["queued", "running", "completed", "failed", "quarantined"], required: ["operation", "request_hash"] },
};

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
}

function looksLikeProjectId(value: string): boolean {
  return /^(project|section|workstream|work_item|activity|person|organization|location|artifact|evidence|claim|decision|deliverable|risk|issue|memory|validation_event):/.test(value);
}

export function validateProjectRecords(records: KnowledgeRecord[]): ValidationIssue[] {
  const ids = new Set(records.map(record => record.id));
  const issues: ValidationIssue[] = [];
  for (const record of records) {
    for (const field of COMMON) {
      if (!present(record[field])) issues.push({ code: "missing_common_field", record_id: record.id || "<unknown>", field, message: `Missing required field: ${field}`, severity: "error" });
    }
    const rule = TYPE_RULES[record.type];
    if (!rule) {
      issues.push({ code: "unknown_record_type", record_id: record.id, field: "type", message: `Unsupported record type: ${record.type}`, severity: "error" });
      continue;
    }
    if (!rule.statuses.includes(record.status)) issues.push({ code: "invalid_status", record_id: record.id, field: "status", message: `${record.type} cannot use status ${record.status}`, severity: "error" });
    for (const field of rule.required) if (!present(record[field])) issues.push({ code: "missing_type_field", record_id: record.id, field, message: `${record.type} requires ${field}`, severity: "error" });
    if (record.confidentiality && !CONFIDENTIALITY.has(String(record.confidentiality))) issues.push({ code: "invalid_confidentiality", record_id: record.id, field: "confidentiality", message: `Invalid confidentiality: ${record.confidentiality}`, severity: "error" });
    if (record.type === "claim" && record.status === "supported" && !present(record.evidence_refs)) issues.push({ code: "supported_claim_missing_evidence", record_id: record.id, field: "evidence_refs", message: "A supported claim requires evidence_refs", severity: "error" });
    if (record.type === "decision" && record.status === "accepted" && !present(record.source_refs)) issues.push({ code: "accepted_decision_missing_sources", record_id: record.id, field: "source_refs", message: "An accepted decision requires source_refs", severity: "error" });
    if (record.type === "work_item" && record.status === "completed" && !present(record.closeout_result) && !present(record.deliverable_refs)) issues.push({ code: "completed_work_missing_closeout", record_id: record.id, message: "Completed work requires closeout_result or deliverable_refs", severity: "error" });
    if (record.type === "memory" && record.status === "accepted" && (!present(record.validation_event_ref) || record.kind !== "open_question" && !present(record.evidence_refs))) issues.push({ code: "accepted_memory_missing_validation", record_id: record.id, message: "Accepted memory requires a validation event, and non-question memory also requires evidence_refs", severity: "error" });
    if (record.status === "superseded" && !present(record.supersedes)) issues.push({ code: "superseded_missing_target", record_id: record.id, field: "supersedes", message: "Superseded record requires supersedes", severity: "error" });
    for (const ref of [...(Array.isArray(record.source_refs) ? record.source_refs : []), ...("supersedes" in record && typeof record.supersedes === "string" ? [record.supersedes] : [])]) {
      if (typeof ref === "string" && looksLikeProjectId(ref) && !ids.has(ref)) issues.push({ code: "broken_record_reference", record_id: record.id, message: `Missing referenced record: ${ref}`, severity: "warning" });
    }
  }
  return issues;
}
