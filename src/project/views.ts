/** Rebuildable structured views derived from canonical project records. */

import type { KnowledgeRecord } from "./runtime.js";

export const PROJECT_VIEW_KINDS = ["overview", "timeline", "people", "deliverables", "risks", "quality"] as const;
export type ProjectViewKind = typeof PROJECT_VIEW_KINDS[number];

function sameProject(record: KnowledgeRecord, projectId: string): boolean {
  return record.project_id === projectId || (record.type === "project" && record.id === projectId);
}

function compact(record: KnowledgeRecord): Record<string, unknown> {
  return { id: record.id, type: record.type, title: record.title, status: record.status, confidentiality: record.confidentiality };
}

export function buildProjectView(records: KnowledgeRecord[], projectId: string, kind: ProjectViewKind): Record<string, unknown> {
  const scoped = records.filter(record => sameProject(record, projectId));
  const project = scoped.find(record => record.type === "project") ?? null;
  if (kind === "overview") {
    const counts = Object.fromEntries([...new Set(scoped.map(record => record.type))].sort().map(type => [type, scoped.filter(record => record.type === type).length]));
    return {
      project_id: projectId,
      project: project && { ...compact(project), mission: project.mission, current_phase: project.current_phase },
      record_counts: counts,
      active_work: scoped.filter(record => record.type === "work_item" && ["in_progress", "awaiting_closeout", "blocked"].includes(record.status)).map(compact),
      generated_from: "canonical_markdown_records",
    };
  }
  if (kind === "timeline") return {
    project_id: projectId,
    events: scoped.filter(record => record.type === "activity" || record.type === "work_item" || record.type === "deliverable")
      .map(record => ({ ...compact(record), at: record.occurred_at ?? record.completed_at ?? record.updated_at }))
      .sort((a, b) => String(a.at).localeCompare(String(b.at))),
  };
  if (kind === "people") return {
    project_id: projectId,
    people: scoped.filter(record => record.type === "person" || record.type === "organization").map(record => ({ ...compact(record), display_name: record.display_name ?? record.title, roles: record.roles ?? [] })),
  };
  if (kind === "deliverables") return {
    project_id: projectId,
    deliverables: scoped.filter(record => record.type === "deliverable").map(record => ({ ...compact(record), kind: record.kind, version: record.version, artifact_refs: record.artifact_refs ?? [] })),
  };
  if (kind === "risks") return {
    project_id: projectId,
    risks: scoped.filter(record => record.type === "risk" || record.type === "issue").map(record => ({ ...compact(record), owner: record.owner, probability: record.probability, impact: record.impact, mitigation: record.mitigation })),
  };
  return {
    project_id: projectId,
    invalid_records: [],
    note: "Quality findings are supplied by ProjectRuntime.lint() so they always reflect current canonical records.",
  };
}
