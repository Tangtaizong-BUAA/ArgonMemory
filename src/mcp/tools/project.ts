/** Low-token MCP tools for the Changyi Jiuan project profile. */

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProjectRuntime, type ProjectProfile, type PublishedResource } from "../../project/runtime.js";
import { readRunnerImportCapability } from "../../project/runner-import.js";
import { PROJECT_VIEW_KINDS } from "../../project/views.js";
import { syncProjectSkill, type ProjectClientRelease } from "../../project/client-skill.js";
import { deliverClientNotice } from "../../project/client-notices.js";
import { outlineText, readTextSlice } from "../../project/retrieval/reading.js";
import { controlText } from "../project-client-guidance.js";

const recordFilters = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional();
const memoryKind = z.enum(["fact", "decision", "procedure", "lesson", "constraint", "preference", "open_question"]);
const memoryUpdate = z.object({
  kind: memoryKind, statement: z.string().min(8).max(4000), scope: z.string().min(1).max(240),
  evidence_refs: z.array(z.string()).max(50).optional(), confidence: z.number().min(0).max(1).optional(),
});
const generatedResource = z.object({
  title: z.string().min(1).max(240), filename: z.string().min(1).max(180),
  content_type: z.enum(["text/markdown", "text/plain", "text/csv", "application/json", "application/yaml", "text/yaml", "application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/jp2"]),
  encoding: z.enum(["utf8", "base64"]).optional().default("utf8"), content: z.string().min(1).max(11_300_000),
  kind: z.enum(["note", "report", "deliverable", "dataset", "code", "image", "document"]),
  source_refs: z.array(z.string()).max(50).optional(), confidentiality: z.enum(["public", "internal", "restricted"]).optional().default("internal"),
});
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKED_RESOURCE_BYTES = 100 * 1024 * 1024;
const UPLOAD_ROOT = join(tmpdir(), "argon-memory-mcp-uploads");
type ChunkUpload = {
  id: string; work_id: string; actor: string; title: string; filename: string; content_type: z.infer<typeof generatedResource>["content_type"];
  kind: z.infer<typeof generatedResource>["kind"]; source_refs?: string[]; confidentiality: "public" | "internal" | "restricted";
  expected_size: number; expected_sha256: string; received_size: number; path: string; expires_at: number;
};
const chunkUploads = new Map<string, ChunkUpload>();

async function cleanupChunkUploads(): Promise<void> {
  const now = Date.now();
  for (const [id, upload] of chunkUploads) {
    if (upload.expires_at > now) continue;
    chunkUploads.delete(id);
    await rm(upload.path, { force: true }).catch(() => undefined);
  }
}
const isOps = (profile: ProjectProfile) => profile === "project-ops" || profile === "project-admin";
const isLegacyWriter = (profile: ProjectProfile) => profile === "project-maintain" || profile === "project-admin";
const visibleTo = (record: { confidentiality?: unknown }, profile: ProjectProfile, personalOwner = false) => personalOwner || isOps(profile) || record.confidentiality === undefined || record.confidentiality === "public" || record.confidentiality === "internal";
const maximumConfidentiality = (profile: ProjectProfile, personalOwner = false) => personalOwner || isOps(profile) ? "secret" as const : "internal" as const;

function textResult(text: string, structuredContent?: Record<string, unknown>) {
  return structuredContent
    ? { content: [{ type: "text" as const, text }], structuredContent }
    : { content: [{ type: "text" as const, text }] };
}

function initialContextText(brief: Record<string, unknown>): string {
  const main = brief.main_file as { markdown?: string; revision_hash?: string } | null;
  const navigation = brief.navigation as { sections?: Array<{ id: string; title: string; summary?: string; artifact_count?: number }>; domain_records?: Array<{ id: string; title: string; type: string; artifact_count?: number }> } | undefined;
  const sections = navigation?.sections ?? [];
  const domain = navigation?.domain_records ?? [];
  const active = brief.active_work as Array<{ id: string; title: string; status: string }> | undefined ?? [];
  const memories = brief.accepted_memory as Array<{ id: string; kind: string; statement: string; scope: string }> | undefined ?? [];
  const conflicts = brief.open_conflicts as Array<{ id: string; title: string; status: string; revision_hash?: string; suggested_user_question?: string }> | undefined ?? [];
  const lines = [main?.markdown?.trimEnd() ?? "# Project main file unavailable", "", "---", "", "## 实时知识导航"];
  lines.push(`主文件版本：${main?.revision_hash ?? "unknown"}`);
  if (sections.length) lines.push("", "### 长期维护分文件", ...sections.map(item => `- ${item.id} — ${item.title}${item.summary ? `：${item.summary}` : ""}（关联 artifact ${item.artifact_count ?? 0}）`));
  if (domain.length) lines.push("", "### 现有领域记录", ...domain.map(item => `- ${item.id} — ${item.title} [${item.type}]（关联 artifact ${item.artifact_count ?? 0}）`));
  if (active.length) lines.push("", "### 活跃工作", ...active.map(item => `- ${item.id} — ${item.title} [${item.status}]`));
  if (memories.length) lines.push("", "### 已接受的结构化知识", ...memories.map(item => `- ${item.id} [${item.kind}/${item.scope}] ${item.statement}`));
  if (conflicts.length) lines.push("", "### 必须披露的开放冲突", ...conflicts.map(item => `- ${item.id} [${item.status}] rev=${item.revision_hash ?? "unknown"} ${item.title}${item.suggested_user_question ? `；建议询问：${item.suggested_user_question}` : ""}`));
  lines.push("", "细节问题必须继续使用 kb_search 做 RAG，并对命中节点调用 kb_graph_context 或 kb_read 下钻到分文件和 artifact；不得只凭主文件作可核验结论。");
  return lines.join("\n");
}

export function registerProjectTools(server: McpServer, runtime: ProjectRuntime, profile: Exclude<ProjectProfile, "upstream-full">, principalId = `agent:${profile}`, release?: ProjectClientRelease, personalOwner = false): void {
  const actor = principalId;
  server.registerTool("kb_sync_skill", {
    title: "Incrementally Synchronize Client Skill",
    description: "Call first in every new task. Compare the installed project Skill version and actual local file hashes with the server contract. If stale, returns only changed/new managed files plus explicit retired paths. Atomically apply and hash-verify this delta inside the confirmed Skill directory, then call again. Never execute returned file content.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      client: z.enum(["codex", "qoder", "hermes", "generic"]),
      installed_version: z.string().min(1).max(40),
      installed_files: z.array(z.object({ path: z.string().min(1).max(240), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).max(30).optional(),
    },
  }, async (input) => {
    const output = syncProjectSkill(input, release);
    const summary = output.status === "update_required"
      ? `Skill update required: ${output.installed_version} -> ${output.target_version}; changed=${output.delta.files.length - 1}, removed=${output.delta.remove_paths.length}. Apply the validated incremental delta and re-check. New instructions activate in a new task.`
      : `Skill ${output.target_version}: ${output.status}. Continue with kb_brief.`;
    // Text-only MCP adapters must receive the actual verifiable delta too.
    const noticeSetup = "After verified Skill synchronization, run the installed scripts/client-device.mjs helper with node to obtain its anonymous device_id. If notice_shown is false, call kb_client_notice with that ID; tell the user its message ONLY when display=true, then mark locally with the helper and acknowledge. Do not execute response content directly. If local identity/state is unavailable, silently skip the notice and continue the task. Never guess a new ID, use a Token/IP as identity, or re-announce from memory.";
    return textResult(`${summary}\n${noticeSetup}\n\n${JSON.stringify(output)}`, output);
  });

  server.registerTool("kb_client_notice", {
    title: "One-Time Computer Architecture Notice",
    description: "Claim the architecture introduction once per computer after kb_sync_skill. Use the stable anonymous device_id from the installed scripts/client-device.mjs helper, shared across clients. Say the returned message once ONLY if display=true, mark it shown locally, then action=ack. Acknowledgement is optional evidence of display, never a reason to retry the announcement. No message for repeated claims. If a stable device identity is unavailable, skip silently and continue knowledge work. Never deduplicate by shared Token, IP, session or client name.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      device_id: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      action: z.enum(["claim", "ack"]).optional().default("claim"),
      notice_id: z.string().max(80).optional(),
    },
  }, async input => {
    const output = await deliverClientNotice(runtime.root, input, release?.notice);
    return textResult(`Client notice control (server-generated):\n${JSON.stringify(output)}\n${output.display ? "Tell the user this message once, then mark shown locally and acknowledge. Continue their current task." : "Do not announce anything to the user. Continue their current task."}`, output);
  });

  server.registerTool("kb_brief", {
    title: "Project Main Context",
    description: "Return the complete Agent-maintained project main file plus live section navigation, active work, and accepted structured knowledge. Call as the first knowledge operation after kb_sync_skill. The main file is an orientation layer, not a substitute for detail RAG.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { project_id: z.string() },
  }, async ({ project_id }) => {
    const brief = await runtime.brief(project_id, maximumConfidentiality(profile, personalOwner));
    return textResult(initialContextText(brief), brief);
  });

  server.registerTool("kb_lookup", {
    title: "Structured Lookup",
    description: "Look up project records by type and exact structured fields. Returns IDs and requested metadata, not full documents.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { entity_type: z.string(), filters: recordFilters, limit: z.number().min(1).max(100).optional().default(20) },
  }, async ({ entity_type, filters, limit }) => {
    const records = (await runtime.lookup(entity_type, filters ?? {}, limit)).filter(record => visibleTo(record, profile, personalOwner));
    const rows = records.map(record => ({ id: record.id, type: record.type, title: record.title, status: record.status, project_id: record.project_id, uri: `kb://record/${encodeURIComponent(record.id)}` }));
    return textResult(rows.length ? rows.map(row => `${row.id} — ${row.title} (${row.status})`).join("\n") : "No matching records.", { records: rows });
  });

  server.registerTool("kb_search", {
    title: "Qwen Evidence and Image Search",
    description: "Structure-guided global Qwen semantic and lexical retrieval across indexed sources and images, independent of graph depth. Use intent=collect and follow next_cursor for dispersed evidence. Check retrieval_plan and coverage; use source_ids to investigate planned sources absent from the result page. modality=image retrieves photo pixels (including group photos). Results carry exact evidence URIs, locations, coverage and warnings. Use kb_read to verify evidence; incomplete indexing never proves absence.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      query: z.string().min(1).max(4000), top_k: z.number().int().min(1).max(100).optional().default(10),
      project_id: z.string().optional(), intent: z.enum(["answer", "collect"]).optional().default("answer"),
      source_ids: z.array(z.string()).min(1).max(100).optional(),
      modality: z.enum(["all", "text", "image"]).optional(), mode: z.enum(["hybrid", "lexical", "semantic"]).optional().default("hybrid"),
      cursor: z.string().max(4000).optional(), max_per_source: z.number().int().min(1).max(20).optional().default(2),
      rerank: z.boolean().optional().default(true), include_images: z.boolean().optional(),
      include_history: z.boolean().optional().default(false), include_unverified: z.boolean().optional().default(false),
    },
  }, async ({ include_images, source_ids, ...input }) => {
    if (input.include_unverified && !isOps(profile)) return { content: [{ type: "text", text: "include_unverified requires project-ops." }], isError: true };
    try {
      // Older clients may only send a query. Explicit visual requests must
      // reach the pixel index without knowing a new modality parameter.
      const visualRequest = /合照|合影|集体照|照片|图片|截图|group photo|photograph|\b(?:picture|image)s?\b/i.test(input.query);
      const modality = input.modality ?? (visualRequest ? "image" : "all");
      const output = await runtime.queryEvidence({ ...input, modality, record_ids: source_ids, maximum_confidentiality: maximumConfidentiality(profile, personalOwner) });
      const rows = output.results.map(({ unit, score, channels }) => ({ id: unit.record_id, evidence_id: unit.id, artifact_id: unit.artifact_id,
        title: unit.title, type: unit.record_type, modality: unit.kind, status: unit.status, score, channels,
        evidence_role: unit.text.includes("[Metadata only: document body is unavailable;") ? "metadata_only" : unit.record_type === "artifact" ? "source" : ["memory", "knowledge_section", "project"].includes(unit.record_type) ? "synthesis" : "administrative",
        snippet: unit.text, uri: `kb://evidence/${encodeURIComponent(unit.id)}`, evidence_uri: `kb://evidence/${encodeURIComponent(unit.id)}`, source_uri: unit.uri, image_uri: unit.image_uri, locator: unit.locator, source_revision: unit.source_revision, content_hash: unit.content_hash }));
      const coverage = output.coverage;
      const count = (key: string) => Array.isArray(coverage[key]) ? coverage[key].length : Number(coverage[key] ?? 0);
      const nextCall = output.next_cursor ? { tool: "kb_search", arguments: { ...input, modality,
        ...(source_ids ? { source_ids } : {}), ...(include_images !== undefined ? { include_images } : {}), cursor: output.next_cursor } } : null;
      const control = controlText("search", {
        revision: output.revision, resolved_modality: modality, has_more: Boolean(output.next_cursor), next_call: nextCall,
        coverage: { scope: "registered_visible_sources_only", fact_completeness: coverage.fact_completeness ?? "not_proven",
          matched_units: coverage.matched_units, returned_units: coverage.returned_units,
          text_embedding_complete: coverage.text_embedding_complete, image_embedding_complete: coverage.image_embedding_complete,
          missing_documents: count("missing_documents"), unparsed_artifacts: count("unparsed_artifacts"),
          unavailable_image_references: count("unavailable_images"), planned_sources_without_content: count("planned_sources_without_content"),
          planned_sources_not_on_this_page: count("planned_sources_not_on_this_page") },
        warnings: output.warnings, related_conflicts: output.related_conflicts,
        next_action: coverage.next_action, evidence_read_tool: "kb_read",
      });
      const evidenceText = rows.length ? rows.map(row => `${row.evidence_id} [${row.modality}; ${row.evidence_role}; ${row.channels.join(",")}] ${row.title}\n${row.snippet}\nRead: ${row.uri}`).join("\n\n") : "No matching evidence in the current visible index. Inspect coverage and warnings before concluding that the source does not exist.";
      const content: any[] = [{ type: "text", text: `${control}\n\n${evidenceText}` }];
      let imageBytes = 0, images = 0;
      let previewBudgetExhausted = false;
      const showImages = include_images ?? (modality === "image" || visualRequest);
      for (const row of rows.filter(row => row.modality === "image")) {
        const uri = row.evidence_uri;
        content.push({ type: "resource_link", uri, name: row.title, description: "Retrievable original image evidence; call kb_read to display pixels." });
        if (!showImages || images >= 3 || previewBudgetExhausted) continue;
        try {
          const image = await runtime.readEvidenceImagePreview(uri, maximumConfidentiality(profile, personalOwner));
          const bytes = Buffer.byteLength(image.data, "base64");
          if (imageBytes + bytes > 768 * 1024) { previewBudgetExhausted = true; continue; }
          content.push({ type: "text", text: `图片预览：${row.title}。原图：kb_read(${uri})` });
          content.push({ type: "image", data: image.data, mimeType: image.mimeType });
          images++; imageBytes += bytes;
        } catch { /* Unavailable pixels remain explicit resource handles; kb_read reports the error. */ }
      }
      return { content, structuredContent: { ...output, results: rows, resolved_modality: modality, returned_images: images, preview_bytes: imageBytes, preview_budget_exhausted: previewBudgetExhausted, originals_via: "kb_read" } };
    } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
  });

  server.registerTool("kb_coverage", {
    title: "Knowledge Retrieval Coverage",
    description: "Inspect the authorized source inventory, text/image evidence counts and unparsed or missing documents. Coverage concerns registered visible sources, never unknown or inaccessible files.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { project_id: z.string().optional() },
  }, async ({ project_id }) => {
    const output = await runtime.retrievalCoverage(project_id, maximumConfidentiality(profile, personalOwner));
    return textResult(JSON.stringify(output), output);
  });

  server.registerTool("kb_outline", {
    title: "Project Resource Outline",
    description: "Return the smallest available outline for a kb:// project resource.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { resource_id: z.string() },
  }, async ({ resource_id }) => {
    try {
      const resource = await runtime.readResource(resource_id, maximumConfidentiality(profile, personalOwner));
      const outline = outlineText(resource.text);
      return textResult(outline.headings.length ? outline.headings.map(h => `${h.start_line}-${h.end_line}: ${h.title}`).join("\n") : resource.title, { resource_id, title: resource.title, ...outline });
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  server.registerTool("kb_view", {
    title: "Project Structured View",
    description: "Rebuild a compact structured view from canonical Markdown records. This is read-only and never creates a second source of truth.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { project_id: z.string(), view: z.enum(PROJECT_VIEW_KINDS) },
  }, async ({ project_id, view }) => {
    const output = await runtime.view(project_id, view, maximumConfidentiality(profile, personalOwner));
    return textResult(YAMLish(output, 800), output);
  });

  server.registerTool("kb_read", {
    title: "Read Located Evidence or Image",
    description: "Read exact evidence URIs or original image pixels. Text supports outline line ranges and revision-bound next_cursor continuation, including arbitrarily deep document sections. Follow next_cursor until truncated=false to finish a range.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { resource_id: z.string(), max_tokens: z.number().int().min(100).max(4000).optional().default(800),
      start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional(), cursor: z.string().max(4000).optional() },
  }, async ({ resource_id, ...input }) => {
    try {
      if (/\/image\/\d+$/.test(resource_id)) {
        const image = await runtime.readEvidenceImage(resource_id, maximumConfidentiality(profile, personalOwner));
        return { content: [{ type: "text", text: `${image.title}\n${image.uri}` }, { type: "image", data: image.data, mimeType: image.mimeType }] };
      }
      if (resource_id.startsWith("kb://evidence/")) {
        try {
          const image = await runtime.readEvidenceImage(resource_id, maximumConfidentiality(profile, personalOwner));
          return { content: [{ type: "text", text: `${image.title}\n${image.uri}` }, { type: "image", data: image.data, mimeType: image.mimeType }] };
        } catch { /* Text evidence uses the same namespace. */ }
      }
      const resource = await runtime.readResource(resource_id, maximumConfidentiality(profile, personalOwner));
      const output = readTextSlice(resource, input);
      const continuation = controlText("read", { resource_id, revision: output.revision, start_line: output.start_line, end_line: output.end_line,
        truncated: output.truncated, next_call: output.next_cursor ? { tool: "kb_read", arguments: { resource_id, max_tokens: input.max_tokens, cursor: output.next_cursor } } : null });
      return { content: [
        { type: "resource", resource: { uri: resource.uri, name: resource.title, title: resource.title, mimeType: "text/markdown", text: output.text } },
        { type: "text", text: `${continuation}\n\n${output.text}` },
      ], structuredContent: output };
    } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
  });

  server.registerTool("kb_graph_context", {
    title: "Read Section with Linked Artifacts",
    description: "Read one maintained section or domain record, expand its canonical graph links, and synchronously return linked artifact metadata or evidence excerpts. Use after selecting a section from kb_brief or a node from kb_search. For detail questions, pass the original query so artifact excerpts center on relevant text.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      node_id: z.string(), query: z.string().optional(), depth: z.number().int().min(0).max(2).optional().default(1),
      artifact_mode: z.enum(["metadata", "excerpt", "full"]).optional().default("excerpt"),
      max_nodes: z.number().int().min(1).max(80).optional().default(30), max_artifacts: z.number().int().min(0).max(12).optional().default(5),
      max_tokens: z.number().int().min(100).max(8000).optional().default(1800),
    },
  }, async ({ node_id, query, depth, artifact_mode, max_nodes, max_artifacts, max_tokens }) => {
    try {
      const output = await runtime.graphContext({ node_id, query, depth, artifact_mode, max_nodes, max_artifacts, max_tokens, maximum_confidentiality: maximumConfidentiality(profile, personalOwner) });
      const content: Array<{ type: "text"; text: string } | { type: "resource"; resource: { uri: string; name: string; title: string; mimeType: string; text: string } }> = [
        { type: "text", text: `${output.focus.content}\n\n[graph: ${output.nodes.length} linked nodes, ${output.artifacts.length} linked artifacts]` },
      ];
      for (const artifact of output.artifacts) {
        if (!artifact.excerpt) continue;
        content.push({ type: "resource", resource: { uri: artifact.document_uri ?? artifact.uri, name: artifact.title, title: artifact.title, mimeType: "text/markdown", text: artifact.excerpt } });
      }
      return { content, structuredContent: output };
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  if (profile === "project-read") return;

  server.registerTool("kb_start_work", {
    title: "Start Project Work",
    description: "Create a durable Agent work item. Call this before project-related work so generated resources and distilled conversation knowledge can be persisted automatically.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: { project_id: z.string(), objective: z.string().min(3), expected_outputs: z.array(z.string()).min(1), acceptance_criteria: z.array(z.string()).min(1), input_refs: z.array(z.string()).optional() },
  }, async ({ project_id, objective, expected_outputs, acceptance_criteria, input_refs }) => {
    const result = await runtime.startWork({ project_id, objective, expected_outputs, acceptance_criteria, input_refs, actor });
    return textResult(`Started ${result.work_id}`, result);
  });

  if (isLegacyWriter(profile)) server.registerTool("kb_update_main", {
    title: "Update Project Main File",
    description: "Legacy 0.4 compatibility shim. Queue a noncanonical main-file proposal for the 0.5 maintenance harness. This call never means the main file was already changed.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      project_id: z.string(), work_id: z.string(), markdown: z.string().min(8).max(24_000), expected_revision: z.string().length(64),
      change_summary: z.string().min(3).max(500), source_refs: z.array(z.string()).max(50).optional(),
    },
  }, async (input) => {
    try {
      const output = await runtime.enqueueLegacyProposal({ project_id: input.project_id, kind: "update_main", payload: input, actor });
      return textResult(`Legacy main update queued as ${output.change_packet_id}; canonical knowledge is unchanged until harness commit.`, output);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  if (isLegacyWriter(profile)) server.registerTool("kb_upsert_section", {
    title: "Create or Update Maintained Knowledge Section",
    description: "Legacy 0.4 compatibility shim. Queue a noncanonical section proposal for the 0.5 maintenance harness. This call never means the section was already changed.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      project_id: z.string(), work_id: z.string(), key: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/), title: z.string().min(2).max(240),
      summary: z.string().min(8).max(1000), markdown: z.string().min(8).max(80_000), change_summary: z.string().min(3).max(500),
      parent_ref: z.string().optional(), artifact_refs: z.array(z.string()).max(50).optional(), related_refs: z.array(z.string()).max(50).optional(),
      source_refs: z.array(z.string()).max(50).optional(), expected_revision: z.string().length(64).optional(), confidentiality: z.enum(["public", "internal", "restricted"]).optional(),
    },
  }, async (input) => {
    try {
      if (/conflicts?|conflict[_-]refs?/i.test(input.key)) throw new Error("Legacy section proposals cannot target conflict-protected sections");
      const output = await runtime.enqueueLegacyProposal({ project_id: input.project_id, kind: "upsert_section", payload: input, actor });
      return textResult(`Legacy section update queued as ${output.change_packet_id}; canonical knowledge is unchanged until harness commit.`, output);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  server.registerTool("kb_publish_resource", {
    title: "Publish Agent Resource",
    description: "Persist a project-related resource produced by the Agent, bind it to a work item, register provenance, and make inline text searchable immediately. Call whenever a durable report, plan, note, dataset, code file, image, or document is created. Inline uploads are capped; use source ingestion for large files.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: { work_id: z.string(), resource: generatedResource },
  }, async ({ work_id, resource }) => {
    try {
      const output = await runtime.publishResource({ ...resource, work_id, actor });
      return textResult(`Published ${output.artifact_id}; searchable=${output.searchable}.`, output);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  if (process.env.ARGON_MEMORY_RUNNER_EXPORT_ROOT && process.env.ARGON_MEMORY_RUNNER_IMPORT_SECRET) server.registerTool("kb_import_runner_output", {
    title: "Import Authorized Runner Output",
    description: "Internal same-host bridge for importing one explicitly authorized isolated-workspace outbox file. The signed capability binds the work item, path, size and SHA-256; file bytes never enter the Agent context.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      work_id: z.string(), capability: z.string().min(80).max(4096),
      title: z.string().min(1).max(240).optional(), content_type: generatedResource.shape.content_type,
      kind: generatedResource.shape.kind, reason: z.string().min(12).max(500),
      confidentiality: z.enum(["public", "internal", "restricted"]).optional().default("internal"),
    },
  }, async (input) => {
    try {
      const { capability, bytes } = await readRunnerImportCapability(input.capability, input.work_id);
      const filename = basename(capability.logical_path);
      const output = await runtime.publishResourceBytes({
        work_id: input.work_id, actor, title: input.title || filename, filename,
        content_type: input.content_type, bytes, kind: input.kind,
        source_refs: [`runner-output:${capability.task_id}:${capability.output_id}:${capability.sha256}`, `promotion-reason:${input.reason}`],
        confidentiality: input.confidentiality,
      });
      return textResult(`Imported ${output.artifact_id} directly from the isolated workspace; searchable=${output.searchable}.`, output);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  server.registerTool("kb_begin_resource_upload", {
    title: "Begin Chunked Resource Upload",
    description: "Begin a resumable server-side upload for a durable project resource that is too large for kb_publish_resource. This only allocates temporary upload state; commit is required to create an Artifact.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      work_id: z.string(), title: z.string().min(1).max(240), filename: z.string().min(1).max(180),
      content_type: generatedResource.shape.content_type, kind: generatedResource.shape.kind,
      expected_size: z.number().int().min(1).max(MAX_CHUNKED_RESOURCE_BYTES), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      source_refs: z.array(z.string()).max(50).optional(), confidentiality: z.enum(["public", "internal", "restricted"]).optional().default("internal"),
    },
  }, async (input) => {
    try {
      await cleanupChunkUploads();
      const workItem = await runtime.get(input.work_id);
      if (!workItem?.record || workItem.record.type !== "work_item") throw new Error(`Unknown work item: ${input.work_id}`);
      await mkdir(UPLOAD_ROOT, { recursive: true });
      const id = `resource_upload:argon:${randomUUID().replace(/-/g, "")}`;
      const path = join(UPLOAD_ROOT, `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.bin`);
      await writeFile(path, Buffer.alloc(0), { mode: 0o600 });
      chunkUploads.set(id, { id, ...input, actor, received_size: 0, path, expires_at: Date.now() + 30 * 60 * 1000 });
      return textResult(`Chunked upload ${id} ready; chunk_bytes=${CHUNK_BYTES}.`, { upload_id: id, chunk_bytes: CHUNK_BYTES, expected_size: input.expected_size, expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  server.registerTool("kb_append_resource_chunk", {
    title: "Append Resource Upload Chunk",
    description: "Append one ordered base64 chunk to a temporary chunked resource upload. Offset must exactly match the acknowledged received byte count.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: { upload_id: z.string(), offset: z.number().int().min(0), content_base64: z.string().min(4).max(5_700_000) },
  }, async ({ upload_id, offset, content_base64 }) => {
    try {
      await cleanupChunkUploads();
      const upload = chunkUploads.get(upload_id);
      if (!upload || upload.actor !== actor) throw new Error("Unknown or expired chunked upload");
      if (offset !== upload.received_size) throw new Error(`Chunk offset mismatch: expected ${upload.received_size}, received ${offset}`);
      const compact = content_base64.replace(/\s+/g, "");
      if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new Error("Invalid base64 upload chunk");
      const bytes = Buffer.from(compact, "base64");
      if (!bytes.length || bytes.length > CHUNK_BYTES) throw new Error(`Chunk must contain 1-${CHUNK_BYTES} decoded bytes`);
      if (upload.received_size + bytes.length > upload.expected_size) throw new Error("Chunk exceeds declared resource size");
      await appendFile(upload.path, bytes);
      upload.received_size += bytes.length;
      upload.expires_at = Date.now() + 30 * 60 * 1000;
      return textResult(`Chunk accepted; received=${upload.received_size}/${upload.expected_size}.`, { upload_id, received_size: upload.received_size, expected_size: upload.expected_size, complete: upload.received_size === upload.expected_size });
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  server.registerTool("kb_commit_resource_upload", {
    title: "Commit Chunked Resource Upload",
    description: "Verify size and SHA-256, atomically publish the completed temporary upload as a durable Artifact, then remove temporary upload state.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: { upload_id: z.string() },
  }, async ({ upload_id }) => {
    try {
      await cleanupChunkUploads();
      const upload = chunkUploads.get(upload_id);
      if (!upload || upload.actor !== actor) throw new Error("Unknown or expired chunked upload");
      if (upload.received_size !== upload.expected_size) throw new Error(`Upload incomplete: ${upload.received_size}/${upload.expected_size} bytes`);
      const bytes = await readFile(upload.path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== upload.expected_sha256) throw new Error("Upload SHA-256 mismatch");
      const output = await runtime.publishResource({
        work_id: upload.work_id, actor: upload.actor, title: upload.title, filename: upload.filename,
        content_type: upload.content_type, encoding: "base64", content: bytes.toString("base64"), kind: upload.kind,
        source_refs: upload.source_refs, confidentiality: upload.confidentiality,
      });
      chunkUploads.delete(upload_id);
      await rm(upload.path, { force: true });
      return textResult(`Committed ${output.artifact_id}; searchable=${output.searchable}.`, output);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  server.registerTool("kb_capture_context", {
    title: "Capture Distilled Project Context",
    description: "Checkpoint durable project knowledge distilled from the ongoing conversation: facts, user decisions, procedures, lessons, constraints, preferences, and open questions. Submit concise statements and evidence references, never a raw transcript. Server policy promotes, quarantines, or rejects each update; when accepted context changes a topic synthesis, refresh its maintained section before closeout.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: { work_id: z.string(), summary: z.string().min(3).max(1000), updates: z.array(memoryUpdate).min(1).max(30) },
  }, async ({ work_id, summary, updates }) => {
    try {
      const output = await runtime.captureContext({ work_id, summary, updates, actor });
      return textResult(`Context checkpoint ${output.checkpoint_hash.slice(0, 12)}; promoted=${output.promoted_memory_ids.length}, quarantined=${output.quarantined_memory_ids.length}, rejected=${output.rejected_memory_ids.length}.`, output);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  server.registerTool("kb_finish_work", {
    title: "Finish Project Work",
    description: "Submit an idempotent closeout after refreshing every affected maintained section and, only when top-level cognition changed, the main file. Include any not-yet-published generated_resources and distilled knowledge_updates; resources are persisted before closeout and memory is governed by server policy.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      work_id: z.string(), outcome: z.enum(["completed", "partial", "failed", "cancelled"]), summary: z.string().min(1), result_hash: z.string().min(8),
      artifacts: z.array(z.string()).optional(), evidence_refs: z.array(z.string()).optional(), unresolved: z.array(z.string()).optional(),
      claims: z.array(z.object({ statement: z.string(), scope: z.string(), evidence_refs: z.array(z.string()).optional(), confidence: z.number().min(0).max(1).optional() })).optional(),
      decisions: z.array(z.object({ statement: z.string(), scope: z.string(), evidence_refs: z.array(z.string()).optional(), confidence: z.number().min(0).max(1).optional() })).optional(),
      lessons: z.array(z.object({ statement: z.string(), scope: z.string(), evidence_refs: z.array(z.string()).optional(), confidence: z.number().min(0).max(1).optional() })).optional(),
      knowledge_updates: z.array(memoryUpdate).max(30).optional(),
      generated_resources: z.array(generatedResource).max(10).optional(),
    },
  }, async (input) => {
    try {
      const published: PublishedResource[] = [];
      for (const resource of input.generated_resources ?? []) published.push(await runtime.publishResource({ ...resource, work_id: input.work_id, actor }));
      const result = await runtime.finishWork({ ...input, artifacts: [...(input.artifacts ?? []), ...published.map(resource => resource.artifact_id)], actor });
      const output = { ...result, published_resources: published };
      return textResult(`Closeout ${result.work_status}; resources=${published.length}, promoted=${result.promoted_memory_ids.length}, quarantined=${result.quarantined_memory_ids.length}, rejected=${result.rejected_memory_ids.length}`, output);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  if (profile === "project-resolve") server.registerTool("kb_submit_user_resolution", {
    title: "Submit Authorized User Conflict Resolution",
    description: "Persist the exact answer of the project owner or a designated resolver for an existing open conflict. This tool only locks the answer and queues maintenance; it never resolves the conflict inline. Non-resolver Agents must not persist a user's ad-hoc reply through any other tool.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      conflict_id: z.string(), expected_conflict_revision: z.string().length(64), resolution_statement: z.string().min(1).max(4000),
      source_turn_ref: z.string().min(1).max(500), user_statement_hash: z.string().regex(/^[a-f0-9]{64}$/), idempotency_key: z.string().min(8).max(200),
    },
  }, async input => {
    try {
      const output = await runtime.submitUserConflictResolution({ ...input, actor_principal: actor });
      return textResult(`Conflict ${input.conflict_id} is resolution_pending; canonical knowledge is not yet changed.`, output);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  if (!isOps(profile)) return;

  server.registerTool("kb_bootstrap_project", {
    title: "Bootstrap Project Knowledge Root",
    description: "Create the canonical project record and durable project directories once. Repeated calls with the same project ID are idempotent.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: { project_id: z.string().min(6), title: z.string().min(2), mission: z.string().min(8) },
  }, async (input) => {
    try {
      const output = await runtime.bootstrapProject({ ...input, actor });
      return textResult(`Project ${output.project_id} ${output.created ? "created" : "already exists"}.`, output);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  server.registerTool("kb_configure_source_root", {
    title: "Configure a Safe Project Source Root",
    description: "Configure a dedicated source directory relative to ARGON_MEMORY_KB_ROOT. Absolute paths and the project root itself are forbidden.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: { id: z.string().min(3), project_id: z.string().min(6), relative_path: z.string().min(1) },
  }, async (input) => {
    try {
      const output = await runtime.configureSourceRoot({ ...input, actor });
      return textResult(`Configured source root ${output.id}.`, output);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  server.registerTool("kb_ingest", {
    title: "Inventory or Register Project Sources",
    description: "Perform local inventory or idempotent artifact registration from a preconfigured source root. Paths are never accepted from callers.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: { source_root_id: z.string(), mode: z.enum(["inventory", "ingest"]) },
  }, async ({ source_root_id, mode }) => {
    try {
      if (mode === "inventory") {
        const inventory = await runtime.inventory(source_root_id);
        const output = { source_root_id, project_id: inventory.project_id, file_count: inventory.files.length, files: inventory.files };
        return textResult(YAMLish(output, 1000), output);
      }
      const output = await runtime.ingestInventory(source_root_id, actor);
      return textResult(`Registered ${output.registered_artifact_ids.length} artifact(s); ${output.unchanged_artifact_ids.length} unchanged.`, output);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  server.registerTool("kb_parse_artifact", {
    title: "Parse Registered Document with MinerU API",
    description: "Send one registered PDF, image, Office, or spreadsheet artifact to MinerU API, write normalized Markdown and a parse report, and append an egress audit event. Requires configured MinerU credentials.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: { artifact_id: z.string() },
  }, async ({ artifact_id }) => {
    try {
      const output = await runtime.parseArtifactWithMinerU(artifact_id, actor);
      return textResult(`Artifact ${output.artifact_id}: ${output.status}`, output);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  if (profile === "project-admin") server.registerTool("kb_reconcile_memory", {
    title: "Reconcile Quarantined or Disputed Memory",
    description: "Legacy 0.4 compatibility shim. Queue an evidence/reconciliation proposal; it cannot accept, reject, supersede, or close a semantic conflict inline.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      memory_id: z.string(), action: z.enum(["add_evidence", "narrow_scope", "propose_supersession", "revalidate"]), rationale: z.string().min(3),
      evidence_refs: z.array(z.string()).optional(), narrowed_scope: z.string().optional(), proposed_supersedes: z.string().optional(),
    },
  }, async (input) => {
    try {
      const memory = await runtime.get(input.memory_id);
      if (!memory || memory.record.type !== "memory") throw new Error(`Unknown memory: ${input.memory_id}`);
      const output = await runtime.enqueueLegacyProposal({ project_id: memory.record.project_id, kind: "reconcile_memory", payload: input, actor });
      return textResult(`Legacy reconciliation queued as ${output.change_packet_id}; memory status is unchanged.`, { ...output, current_memory_status: memory.record.status });
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  server.registerTool("kb_maintain", {
    title: "Project Maintenance",
    description: "Run health, lint, dry-run retry planning, or execute retry of failed MinerU parses. Original files and accepted audit history are never deleted.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: { action: z.enum(["health", "lint", "retry_failed_parses", "rebuild_retrieval"]), dry_run: z.boolean().optional().default(true), limit: z.number().min(1).max(20).optional().default(20) },
  }, async ({ action, dry_run, limit }) => {
    if (action === "rebuild_retrieval") {
      if (dry_run) return textResult("Would rebuild lexical and Qwen semantic/image indexes for authorized internal sources.", await runtime.retrievalCoverage());
      const output = await runtime.rebuildRetrieval(true);
      return textResult(JSON.stringify(output), output);
    }
    if (action === "health") {
      const output = await runtime.health();
      return textResult(YAMLish(output, 500), output);
    }
    if (action === "lint") {
      const issues = await runtime.lint();
      return textResult(YAMLish({ issue_count: issues.length, issues }, 800), { issue_count: issues.length, issues });
    }
    const pending = (await runtime.lookup("artifact", { status: "failed" }, limit)).map(record => record.id);
    if (dry_run) return textResult(`Would retry ${pending.length} failed MinerU parse(s).`, { dry_run: true, artifact_ids: pending });
    const output = await runtime.retryFailedParses(actor, limit);
    return textResult(`Retried ${output.attempted.length} parse(s); parsed=${output.parsed.length}, failed=${output.failed.length}.`, output);
  });
}

function YAMLish(value: unknown, maxChars: number): string {
  const text = JSON.stringify(value, null, 2);
  return text.length > maxChars * 4 ? `${text.slice(0, maxChars * 4)}\n[TRUNCATED]` : text;
}
