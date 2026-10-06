import { describe, expect, test } from "vitest";
import { buildRetrievalPlan } from "../src/project/retrieval/planner.js";
import type { KnowledgeRecord } from "../src/project/runtime.js";
import type { EvidenceCorpus } from "../src/project/retrieval/types.js";

function item(id: string, type: string, title: string, body = "", extra: Partial<KnowledgeRecord> = {}) {
  return { record: { id, type, title, status: type === "artifact" ? "parsed" : "active", project_id: "project:p", created_at: "2026-10-04", updated_at: "2026-10-04", created_by: "test", confidentiality: "internal", ...extra } as KnowledgeRecord, body };
}
function corpus(records: EvidenceCorpus["records"]): EvidenceCorpus {
  return { records, revision: "v1", units: [], coverage: { total_records: records.length, total_artifacts: 0, text_artifacts: 0, image_units: 0, missing_documents: [], unparsed_artifacts: [], unavailable_images: [], warnings: [] } };
}

describe("structural retrieval planner", () => {
  test("selects actual practice structure and all descendants without project hub expansion", () => {
    const data = corpus([
      item("project:p", "project", "长翼久安", "", { section_refs: ["section:practice", "section:finance"] }),
      item("section:practice", "knowledge_section", "实践执行", "## 行程准备\n已整理资料。", { summary: "长城实践与现场走访", child_section_refs: ["section:child"], artifact_refs: ["artifact:plan"] }),
      item("section:child", "knowledge_section", "偏关走访", "### 现场图像\n照片证据", { child_section_refs: ["section:grandchild"], artifact_refs: ["artifact:photo"], location: "偏关" }),
      item("section:grandchild", "knowledge_section", "活动记录", "## 复盘", { artifact_refs: ["artifact:notes"] }),
      item("section:finance", "knowledge_section", "经费管理", "## 预算", { artifact_refs: ["artifact:budget"] }),
      item("artifact:plan", "artifact", "行程"), item("artifact:photo", "artifact", "照片"), item("artifact:notes", "artifact", "记录"), item("artifact:budget", "artifact", "预算"), item("artifact:orphan", "artifact", "未关联证据"),
    ]);
    const plan = buildRetrievalPlan(data, { query: "有哪些长城实践资料", project_id: "project:p" });
    expect(plan.selected_sections.map(section => section.id)).toEqual(["section:practice", "section:child", "section:grandchild"]);
    expect(new Set(plan.planned_artifact_ids)).toEqual(new Set(["artifact:plan", "artifact:photo", "artifact:notes"]));
    expect(plan.unlinked_artifact_ids).toEqual(["artifact:orphan"]);
    expect(plan.evidence_modalities).toEqual(["text", "image"]);
    expect(plan.facets).toContainEqual({ section_id: "section:child", label: "偏关", source: "field", field: "location" });
    expect(plan.facets.map(facet => facet.label)).toContain("现场图像");
    expect(plan.facets.map(facet => facet.label)).not.toContain("预算");
  });

  test("semantic hints find synonym routes, cycle traversal terminates, and derived parent links work", () => {
    const data = corpus([
      item("a", "knowledge_section", "田野工作", "## 数据采集", { child_section_refs: ["b"] }),
      item("b", "knowledge_section", "协调", "", { child_section_refs: ["a"] }),
      item("c", "knowledge_section", "后续记录", "", { parent_ref: "b", artifact_refs: ["evidence"] }),
      item("evidence", "artifact", "原始记录"),
    ]);
    const plan = buildRetrievalPlan(data, { query: "怎样开展社会实践" }, ["a"]);
    expect(plan.selected_sections.map(section => section.id)).toEqual(["a", "b", "c"]);
    expect(plan.selected_sections[0]?.reasons).toContain("semantic_section_hit");
    expect(plan.warnings).toContain("cyclic_section_links_visited_once");
    expect(plan.planned_artifact_ids).toEqual(["evidence"]);
  });

  test("hidden and cross-project nodes neither expand nor leak in coverage metadata", () => {
    const data = corpus([
      item("section", "knowledge_section", "长城实践", "## 公开资料", { artifact_refs: ["visible", "hidden", "other-project"], child_section_refs: ["hidden-section", "other-section"] }),
      item("visible", "artifact", "可读原文"),
      item("hidden", "artifact", "隐藏附件", "", { confidentiality: "secret" }),
      item("hidden-section", "knowledge_section", "隐藏实践", "## 隐藏标题", { confidentiality: "restricted", artifact_refs: ["hidden"] }),
      item("other-project", "artifact", "异项目附件", "", { project_id: "project:q" }),
      item("other-section", "knowledge_section", "财务", "## 异项目", { project_id: "project:q" }),
    ]);
    const plan = buildRetrievalPlan(data, { query: "长城实践", project_id: "project:p" }, ["hidden-section"]);
    expect(plan.planned_artifact_ids).toEqual(["visible"]);
    expect(plan.selected_sections[0]?.child_section_ids).toEqual([]);
    expect(JSON.stringify(plan)).not.toMatch(/hidden|other-project|other-section|隐藏|异项目/);
  });

  test("facets come only from existing headings and fields, and unknown routes remain explicit", () => {
    const data = corpus([item("section", "knowledge_section", "检测方案", "## 检测仪器\n```md\n## 虚构代码标题\n```", { scope: "墙体外观", artifact_refs: [] })]);
    const found = buildRetrievalPlan(data, { query: "检测方案" });
    expect(found.facets.map(facet => facet.label).sort()).toEqual(["墙体外观", "检测仪器"].sort());
    const missing = buildRetrievalPlan(data, { query: "火星殖民" });
    expect(missing.selected_sections).toEqual([]);
    expect(missing.facets).toEqual([]);
    expect(missing.warnings).toContain("no_structural_route_global_rag_required");
  });
});
