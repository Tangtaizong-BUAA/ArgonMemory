import type { KnowledgeRecord } from "../runtime.js";
import type { EvidenceCorpus, RetrievalRequest } from "./types.js";
import { retrievalTerms } from "./index.js";

export type PlannedSection = {
  id: string; title: string; reasons: string[]; artifact_ids: string[]; child_section_ids: string[];
};
export type RetrievalFacet = {
  section_id: string; label: string; source: "heading" | "field"; field?: string; level?: number;
};
export type RetrievalPlan = {
  selected_sections: PlannedSection[]; planned_artifact_ids: string[]; unlinked_artifact_ids: string[];
  facets: RetrievalFacet[]; evidence_modalities: Array<"text" | "image">; warnings: string[];
};
const rank: Record<string, number> = { public: 0, internal: 1, restricted: 2, secret: 3 };
const historic = new Set(["superseded", "stale", "archived", "deleted", "retired", "deprecated"]);
const unverified = new Set(["candidate", "validating", "quarantined", "rejected", "disputed", "proposal", "proposed", "queued"]);
const structureTypes = new Set(["knowledge_section", "workstream", "deliverable"]);
const strings = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((value): value is string => typeof value === "string") : [];
const unique = (values: string[]): string[] => [...new Set(values)];
const generic = new Set(["项目", "资料", "信息", "全部", "所有", "相关", "详细", "情况", "全面"]);
const administrative = new Set(["id", "type", "title", "summary", "status", "project_id", "key", "created_at", "updated_at", "created_by", "updated_by", "confidentiality", "schema_version", "revision_hash", "parent_ref", "change_summary", "last_section_audit_id"]);

function visible(record: KnowledgeRecord, request: RetrievalRequest): boolean {
  if (request.project_id && record.project_id !== request.project_id) return false;
  if ((rank[record.confidentiality ?? "internal"] ?? 99) > (rank[request.maximum_confidentiality ?? "internal"] ?? 1)) return false;
  if (!request.include_history && historic.has(record.status)) return false;
  return !!request.include_unverified || !unverified.has(record.status);
}

/** Route through maintained structure, without following the project hub. */
export function buildRetrievalPlan(corpus: EvidenceCorpus, request: RetrievalRequest, sectionHints: string[] = []): RetrievalPlan {
  const items = corpus.records.filter(item => visible(item.record, request));
  const byId = new Map(items.map(item => [item.record.id, item]));
  const sections = items.filter(item => structureTypes.has(item.record.type));
  const sectionIds = new Set(sections.map(item => item.record.id));
  const artifacts = items.filter(item => item.record.type === "artifact");
  const artifactIds = new Set(artifacts.map(item => item.record.id));
  // Cross-project edges never expand the route even when no project_id was given.
  const sameProject = (from: string, to: string): boolean => byId.get(from)?.record.project_id === byId.get(to)?.record.project_id;
  const children = new Map<string, string[]>();
  const links = new Map<string, string[]>();
  for (const { record } of sections) {
    const explicit = strings(record.child_section_refs).filter(id => sectionIds.has(id) && sameProject(record.id, id));
    const inferred = sections.filter(item => item.record.parent_ref === record.id && sameProject(record.id, item.record.id)).map(item => item.record.id);
    children.set(record.id, unique([...explicit, ...inferred]));
    links.set(record.id, unique(["artifact_refs", "source_refs", "evidence_refs", "related_refs"].flatMap(key => strings(record[key])).filter(id => artifactIds.has(id) && sameProject(record.id, id))));
  }
  const rawTerms = retrievalTerms(request.query).slice(0, 128);
  const specific = rawTerms.filter(term => !generic.has(term));
  const terms = specific.length ? specific : rawTerms;
  const fields = sections.map(item => ({
    item,
    title: new Set(retrievalTerms(item.record.title)),
    summary: new Set(retrievalTerms(String(item.record.summary ?? ""))),
    body: new Set(retrievalTerms(item.body)),
  }));
  const idf = new Map(terms.map(term => [term, 1 + Math.log((sections.length + 1) / (1 + fields.filter(field => field.title.has(term) || field.summary.has(term) || field.body.has(term)).length))]));
  const scores = fields.map(field => {
    let score = 0;
    const reasons: string[] = [];
    for (const [name, tokens, weight] of [["title", field.title, 5], ["summary", field.summary, 3], ["body", field.body, 1]] as const) {
      const matched = terms.filter(term => tokens.has(term));
      score += matched.reduce((total, term) => total + weight * idf.get(term)!, 0);
      if (matched.length) reasons.push(`${name}_matches:${matched.join(",")}`);
    }
    if (sectionHints.includes(field.item.record.id)) reasons.push("semantic_section_hit");
    return { id: field.item.record.id, score, reasons, hinted: sectionHints.includes(field.item.record.id) };
  }).sort((a, b) => Number(b.hinted) - Number(a.hinted) || b.score - a.score || a.id.localeCompare(b.id));
  const topScore = Math.max(0, ...scores.map(item => item.score));
  const candidates = scores.filter(item => item.hinted || (item.score > 0 && item.score >= topScore * 0.3));
  const seeds = candidates.slice(0, 16);
  const warnings: string[] = [];
  if (candidates.length > seeds.length) warnings.push("structural_seed_limit_reached_global_rag_still_required");
  if (!seeds.length) warnings.push("no_structural_route_global_rag_required");

  const reasons = new Map(seeds.map(item => [item.id, item.reasons]));
  const selected: string[] = [];
  const visiting = new Set<string>(), visited = new Set<string>();
  let cycle = false;
  // Iterative traversal has no depth limit and handles deeply nested sections.
  for (const seed of seeds) {
    const stack: Array<{ id: string; exit: boolean; parent?: string }> = [{ id: seed.id, exit: false }];
    while (stack.length) {
      const frame = stack.pop()!;
      if (frame.exit) { visiting.delete(frame.id); continue; }
      if (visiting.has(frame.id)) { cycle = true; continue; }
      if (visited.has(frame.id)) continue;
      visited.add(frame.id); visiting.add(frame.id); selected.push(frame.id);
      if (frame.parent) reasons.set(frame.id, unique([...(reasons.get(frame.id) ?? []), `descendant_of:${frame.parent}`]));
      stack.push({ id: frame.id, exit: true });
      for (const child of [...(children.get(frame.id) ?? [])].reverse()) stack.push({ id: child, exit: false, parent: frame.id });
    }
  }
  if (cycle) warnings.push("cyclic_section_links_visited_once");
  const selectedSections = selected.map(id => ({ id, title: byId.get(id)!.record.title, reasons: reasons.get(id) ?? [], artifact_ids: links.get(id) ?? [], child_section_ids: children.get(id) ?? [] }));
  const planned = unique(selectedSections.flatMap(section => section.artifact_ids));
  const anyLinked = new Set([...links.values()].flat());
  const unlinked = artifacts.map(item => item.record.id).filter(id => !anyLinked.has(id));
  const facets: RetrievalFacet[] = [];
  for (const id of selected) {
    const { record, body } = byId.get(id)!;
    const text = body.replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "");
    for (const match of text.matchAll(/^(#{2,6})\s+(.+?)\s*#*\s*$/gm)) facets.push({ section_id: id, label: match[2]!, source: "heading", level: match[1]!.length });
    for (const [field, value] of Object.entries(record)) {
      if (administrative.has(field) || /(?:_ref|_refs|_id|_ids|_hash|_path|_revision|_at)$/.test(field)) continue;
      if (typeof value === "string" && value.trim()) facets.push({ section_id: id, label: value, source: "field", field });
      else if (Array.isArray(value)) for (const label of strings(value)) if (label.trim()) facets.push({ section_id: id, label, source: "field", field });
    }
  }
  const facetKeys = new Set<string>();
  const dedupedFacets = facets.filter(facet => { const key = `${facet.section_id}\0${facet.source}\0${facet.field ?? ""}\0${facet.label}`; if (facetKeys.has(key)) return false; facetKeys.add(key); return true; });
  return {
    selected_sections: selectedSections, planned_artifact_ids: planned, unlinked_artifact_ids: unlinked,
    facets: dedupedFacets,
    evidence_modalities: request.modality === "text" ? ["text"] : request.modality === "image" ? ["image"] : ["text", "image"],
    warnings,
  };
}
