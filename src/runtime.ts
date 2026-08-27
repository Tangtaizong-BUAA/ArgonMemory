/**
 * Argon Memory canonical project runtime.
 *
 * Phase 1 deliberately keeps project truth in Markdown + frontmatter and
 * derives no additional mandatory database. It is safe to run against an
 * empty project directory and never requires an external database as truth.
 */

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import { validateProjectRecords, type ValidationIssue } from "./validation.js";
import { buildProjectView, PROJECT_VIEW_KINDS, type ProjectViewKind } from "./views.js";
import { inventorySourceRoot, parseSourceRoots, sourceFilePath, type InventoryEntry, type SourceRoot } from "./ingestion.js";
import { CanonicalRevisionStore, type CanonicalDirectory } from "./revision-store.js";
import { MaintenanceQueue } from "./maintenance/queue.js";
import type { ChangePacket, MaintenancePlan } from "./maintenance/contracts.js";
import { excerptAroundSearchQuery, rankSearchDocuments } from "./search.js";

export type ProjectProfile = "upstream-full" | "project-read" | "project-contribute" | "project-resolve" | "project-ops" | "project-maintain" | "project-admin";
export type MemoryKind = "fact" | "decision" | "procedure" | "lesson" | "constraint" | "preference" | "open_question";
export type MemoryStatus = "candidate" | "validating" | "accepted" | "quarantined" | "rejected" | "disputed" | "superseded";
export type Confidentiality = "public" | "internal" | "restricted" | "secret";

export type ImageAssociation = {
  alt_text?: string;
  caption?: string;
  page?: number;
  slide?: number;
  section?: string;
  resource_uri: string;
};

export type KnowledgeRecord = {
  id: string;
  type: string;
  title: string;
  status: string;
  project_id: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  source_refs?: string[];
  confidentiality?: Confidentiality;
  schema_version?: number;
  [key: string]: unknown;
};

type RecordInput = {
  id: string;
  type: string;
  title: string;
  status: string;
  project_id: string;
  created_by: string;
  source_refs?: string[];
  confidentiality?: Confidentiality;
  schema_version?: number;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
};

export type MemorySubmission = {
  kind: MemoryKind;
  statement: string;
  scope: string;
  evidence_refs?: string[];
  confidence?: number;
};

export type PublishResourceInput = {
  work_id: string;
  title: string;
  filename: string;
  content_type: string;
  encoding: "utf8" | "base64";
  content: string;
  kind: "note" | "report" | "deliverable" | "dataset" | "code" | "image" | "document";
  actor: string;
  source_refs?: string[];
  confidentiality?: Exclude<Confidentiality, "secret">;
};

export type PublishResourceBytesInput = Omit<PublishResourceInput, "encoding" | "content"> & {
  bytes: Buffer;
};

export type PublishedResource = {
  artifact_id: string;
  work_id: string;
  status: string;
  sha256: string;
  size_bytes: number;
  resource_uri: string;
  raw_resource_uri: string;
  searchable: boolean;
  mineru_parse_supported: boolean;
};

export type CaptureContextResult = {
  checkpoint_hash: string;
  promoted_memory_ids: string[];
  quarantined_memory_ids: string[];
  rejected_memory_ids: string[];
  validation_event_ids: string[];
  audit_event_id: string;
};

export type KnowledgeGraphEdge = {
  from: string;
  to: string;
  relation: string;
  field: string;
};

export type KnowledgeGraphNode = {
  id: string;
  type: string;
  title: string;
  status: string;
  uri: string;
};

export type LinkedArtifact = KnowledgeGraphNode & {
  mime_type?: string;
  source_kind?: string;
  sha256?: string;
  created_by?: string;
  document_uri?: string;
  excerpt?: string;
  excerpt_truncated?: boolean;
  visual_context?: ImageAssociation[];
};

export type GraphContextResult = {
  focus: KnowledgeGraphNode & { content: string; content_truncated: boolean };
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  artifacts: LinkedArtifact[];
  external_refs: string[];
  depth: number;
};

export type UpdateProjectMainResult = {
  project_id: string;
  main_uri: string;
  revision_hash: string;
  previous_revision_hash: string;
  changed: boolean;
  audit_event_id?: string;
};

export type UpsertKnowledgeSectionResult = {
  section_id: string;
  section_uri: string;
  revision_hash: string;
  previous_revision_hash?: string;
  created: boolean;
  audit_event_id: string;
};

export type FinishWorkInput = {
  work_id: string;
  outcome: "completed" | "partial" | "failed" | "cancelled";
  summary: string;
  result_hash: string;
  actor: string;
  artifacts?: string[];
  claims?: Omit<MemorySubmission, "kind">[];
  decisions?: Omit<MemorySubmission, "kind">[];
  lessons?: Omit<MemorySubmission, "kind">[];
  knowledge_updates?: MemorySubmission[];
  unresolved?: string[];
  evidence_refs?: string[];
};

export type ValidationDecision = "accepted" | "quarantined" | "rejected" | "disputed" | "superseded";
export type ValidationEvent = KnowledgeRecord & {
  type: "validation_event";
  decision: ValidationDecision;
  reason_codes: string[];
  subject_ref: string;
  policy_id: string;
  policy_version: string;
  input_hash: string;
  trace_id: string;
};

export type FinishWorkResult = {
  work_status: string;
  accepted_updates: string[];
  promoted_memory_ids: string[];
  quarantined_memory_ids: string[];
  rejected_memory_ids: string[];
  remediation_work_ids: string[];
  validation_event_ids: string[];
  policy_trace_id: string;
  audit_event_id: string;
};

const POLICY_ID = "memory-policy";
const POLICY_VERSION = "0.2.0";
const SECRET_PATTERN = /(?:gh[ops]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/;
const MINERU_MIME_TYPES = new Set([
  "application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/jp2",
]);
const INLINE_TEXT_MIME_TYPES = new Set(["text/markdown", "text/plain", "text/csv", "application/json", "application/yaml", "text/yaml"]);
const PUBLISHABLE_MIME_TYPES = new Set([...INLINE_TEXT_MIME_TYPES, ...MINERU_MIME_TYPES]);
// The public single-call MCP schema remains intentionally small. Chunked uploads
// are assembled server-side before entering this common validation path.
const MAX_INLINE_RESOURCE_BYTES = 100 * 1024 * 1024;
const GRAPH_REFERENCE_FIELDS: Array<{ field: string; relation: string }> = [
  { field: "section_refs", relation: "has_section" },
  { field: "child_section_refs", relation: "has_subsection" },
  { field: "parent_ref", relation: "part_of" },
  { field: "related_refs", relation: "related_to" },
  { field: "source_refs", relation: "references" },
  { field: "artifact_refs", relation: "uses_artifact" },
  { field: "evidence_refs", relation: "supported_by" },
  { field: "artifacts", relation: "produced" },
  { field: "input_refs", relation: "uses_input" },
  { field: "artifact_id", relation: "describes_artifact" },
  { field: "source_work_id", relation: "produced_by" },
  { field: "last_modified_work_id", relation: "updated_by_work" },
  { field: "conflict_refs", relation: "has_conflict" },
  { field: "subject_ref", relation: "validates" },
  { field: "supersedes", relation: "supersedes" },
];

function now(): string { return new Date().toISOString(); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function digestBytes(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function safeName(id: string): string { return id.replace(/[^A-Za-z0-9._-]/g, "_"); }
function newId(type: string): string { return `${type}:argon:${randomUUID().replace(/-/g, "")}`; }
function uniqueStrings(values: Array<string | undefined>): string[] { return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))]; }
function asStrings(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}
function confidentialityAllowed(record: KnowledgeRecord, maximum: Confidentiality): boolean {
  const rank: Record<Confidentiality, number> = { public: 0, internal: 1, restricted: 2, secret: 3 };
  return rank[(record.confidentiality ?? "internal") as Confidentiality] <= rank[maximum];
}

function renderRecord(record: KnowledgeRecord, body = ""): string {
  const frontmatter = YAML.stringify(record).trimEnd();
  return `---\n${frontmatter}\n---\n\n${body || `# ${record.title}\n`}`;
}

function parseRecord(text: string): { record: KnowledgeRecord; body: string } {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) throw new Error("Project record is missing YAML frontmatter");
  const parsed = YAML.parse(match[1] ?? "") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Project record frontmatter must be an object");
  const record = parsed as KnowledgeRecord;
  for (const key of ["id", "type", "title", "status", "project_id", "created_at", "updated_at", "created_by"]) {
    if (typeof record[key] !== "string" || record[key] === "") throw new Error(`Project record missing ${key}`);
  }
  return { record, body: match[2] ?? "" };
}

function extractImageAssociations(markdown: string, artifactId: string): ImageAssociation[] {
  const associations: ImageAssociation[] = [];
  const lines = markdown.split("\n");
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/;

  let currentSection = "";
  let currentPage: number | undefined;
  let currentSlide: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const headingMatch = line.match(/^#{1,6}\s+(.+)/);
    if (headingMatch) {
      currentSection = headingMatch[1]!;
      const pageMatch = currentSection.match(/^Page\s+(\d+)$/i);
      if (pageMatch) { currentPage = parseInt(pageMatch[1]!, 10); }
      const slideMatch = currentSection.match(/^Slide\s+(\d+)$/i);
      if (slideMatch) { currentSlide = parseInt(slideMatch[1]!, 10); }
      continue;
    }

    const imgMatch = imageRegex.exec(line);
    if (!imgMatch) continue;

    const altText = imgMatch[1]?.trim() || undefined;
    let caption: string | undefined;

    if (i > 0) {
      const prev = lines[i - 1]!.trim();
      if (prev && !/^[#>\-*`|]/.test(prev) && !imageRegex.test(prev)) {
        caption = prev;
      }
    }

    associations.push({
      alt_text: altText,
      caption,
      page: currentPage,
      slide: currentSlide,
      section: currentSection || undefined,
      resource_uri: `kb://artifact/${encodeURIComponent(artifactId)}/image/${associations.length}`,
    });
  }

  return associations;
}

export class ProjectRuntime {
  readonly root: string;
  readonly revisionStore: CanonicalRevisionStore;
  readonly maintenanceQueue: MaintenanceQueue;

  constructor(root: string) { this.root = root; this.revisionStore = new CanonicalRevisionStore(root); this.maintenanceQueue = new MaintenanceQueue(join(root, "maintenance", "jobs.sqlite")); }

  async initialize(): Promise<void> {
    await Promise.all(["registry", "memory", "events", "audit", "ingestion"].map(dir => mkdir(join(this.root, dir), { recursive: true })));
    await this.revisionStore.initialize();
    await this.maintenanceQueue.initialize();
  }

  private async enqueueMaintenance(input: {
    project_id: string; trigger: ChangePacket["trigger"]; idempotency_key: string; text_context: string;
    evidence_refs?: string[]; candidate_section_refs?: string[]; media?: ChangePacket["media"]; locked_user_resolution_ref?: string;
  }): Promise<string> {
    const pointer = await this.revisionStore.pointer();
    const items = await this.records();
    const records = items.map(item => item.record);
    const openConflicts = records.filter(record => record.project_id === input.project_id && record.type === "conflict" && ["open", "resolution_pending"].includes(record.status)).map(record => record.id).slice(0, 30);
    const evidenceRefs = uniqueStrings(input.evidence_refs ?? []).slice(0, 40);
    const evidenceParts: string[] = [];
    let evidenceChars = 0;
    for (const ref of evidenceRefs) {
      const item = items.find(candidate => candidate.record.id === ref);
      if (!item) continue;
      let content = item.body || (typeof item.record.statement === "string" ? item.record.statement : "");
      if (item.record.type === "artifact" && typeof item.record.normalized_markdown_path === "string") {
        content = await readFile(join(this.root, item.record.normalized_markdown_path), "utf8").catch(() => content);
      }
      if (!content.trim()) continue;
      const remaining = 3_000 - evidenceChars;
      if (remaining <= 0) break;
      const excerpt = content.slice(0, Math.min(remaining, 2_000));
      evidenceParts.push(`## Evidence ${ref}\nTitle: ${item.record.title}\nType: ${item.record.type}\n\n${excerpt}`);
      evidenceChars += excerpt.length;
    }
    const routingText = `${input.text_context}\n${evidenceParts.join("\n")}`.toLowerCase();
    const scoreSection = (record: KnowledgeRecord): number => {
      const seed = `${record.title} ${String(record.summary ?? "")} ${String(record.key ?? "")}`.toLowerCase();
      const terms = new Set(seed.split(/[^\p{L}\p{N}]+/u).filter(term => term.length >= 2));
      for (let index = 0; index + 1 < record.title.length; index += 1) terms.add(record.title.slice(index, index + 2).toLowerCase());
      return [...terms].reduce((score, term) => score + (routingText.includes(term) ? Math.min(term.length, 8) : 0), 0);
    };
    const inferredSections = records
      .filter(record => record.project_id === input.project_id && record.type === "knowledge_section")
      .map(record => ({ id: record.id, score: scoreSection(record), linked: asStrings(record.artifact_refs).some(ref => evidenceRefs.includes(ref)) }))
      .filter(candidate => candidate.linked || candidate.score > 0)
      .sort((a, b) => Number(b.linked) - Number(a.linked) || b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 2)
      .map(candidate => candidate.id);
    const candidateSectionRefs = uniqueStrings([...(input.candidate_section_refs ?? []), ...inferredSections]).slice(0, 6);
    const documentParts: string[] = [];
    const documentCandidates = items.filter(item => item.record.id === input.project_id || candidateSectionRefs.includes(item.record.id));
    const headingCandidates: Array<{ score: number; text: string }> = [];
    for (const item of documentCandidates) {
      const lines = item.body.split("\n");
      const headings = lines.map((line, index) => {
        const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        return match ? { index, level: match[1]!.length, title: match[2]! } : null;
      }).filter((value): value is { index: number; level: number; title: string } => value !== null);
      for (let index = 0; index < headings.length; index += 1) {
        const heading = headings[index]!;
        const next = headings.slice(index + 1).find(candidate => candidate.level <= heading.level);
        const content = lines.slice(heading.index + 1, next?.index ?? lines.length).join("\n").trim();
        if (!content || content.length > 2_500) continue;
        const title = heading.title.toLowerCase();
        let score = routingText.includes(title) ? 20 : 0;
        for (let offset = 0; offset + 1 < title.length; offset += 1) if (routingText.includes(title.slice(offset, offset + 2))) score += 2;
        if (score === 0) continue;
        const expectedRevision = item.record.id === input.project_id ? String(item.record.main_revision ?? digest(item.body)) : String(item.record.revision_hash ?? digest(item.body));
        headingCandidates.push({ score, text: `## Mutable document block\ntarget_ref: ${item.record.id}\nexpected_revision: ${expectedRevision}\nblock_key: heading:${heading.title}\nprevious_block_hash: ${digest(content)}\n\n${content}` });
      }
    }
    let documentChars = 0;
    for (const candidate of headingCandidates.sort((a, b) => b.score - a.score).slice(0, 4)) {
      if (documentChars + candidate.text.length > 3_000) continue;
      documentParts.push(candidate.text);
      documentChars += candidate.text.length;
    }
    const hydratedContext = [input.text_context.slice(0, 1_500), ...evidenceParts, ...documentParts].join("\n\n").slice(0, 6_000);
    const packetId = `packet:argon:${digest(input.idempotency_key).slice(0, 24)}`;
    const packet: ChangePacket = {
      schema: "argon-memory-change-packet/v1", packet_id: packetId, project_id: input.project_id, idempotency_key: input.idempotency_key,
      trigger: input.trigger,
      base_revisions: { knowledge_revision: pointer?.knowledge_revision ?? "legacy", topology_revision: pointer?.topology_revision ?? "legacy", index_revision: pointer?.index_revision ?? "unbuilt" },
      evidence_refs: evidenceRefs, candidate_section_refs: candidateSectionRefs,
      open_conflict_refs: openConflicts, text_context: hydratedContext, media: (input.media ?? []).slice(0, 12),
      budget: { max_tool_calls: 2, max_cumulative_input_tokens: 12000, max_context_tokens_per_step: 6000, max_cumulative_output_tokens: 3000, max_sections: 6, max_evidence_units: 40, max_multimodal_assets: 12, max_cost_usd: Number(process.env.ARGON_MEMORY_MAINTENANCE_MAX_COST_USD ?? "0.50") },
      egress_policy: {
        maximum_confidentiality: "internal",
        provider: process.env.ARGON_MEMORY_MAINTENANCE_PROVIDER ?? "local",
        region: process.env.ARGON_MEMORY_MAINTENANCE_REGION ?? "local",
      },
      ...(input.locked_user_resolution_ref ? { locked_user_resolution_ref: input.locked_user_resolution_ref } : {}),
    };
    await this.maintenanceQueue.enqueue(packet);
    return packetId;
  }

  private directoryFor(record: KnowledgeRecord): string {
    if (record.type === "memory") return "memory";
    if (record.type === "validation_event") return "events";
    return "registry";
  }

  private async writeRecord(record: KnowledgeRecord, body = ""): Promise<void> {
    await this.initialize();
    await this.revisionStore.publish([{ directory: this.directoryFor(record) as CanonicalDirectory, filename: `${safeName(record.id)}.md`, content: renderRecord(record, body) }]);
  }

  private async readDirectory(dir: string): Promise<Array<{ record: KnowledgeRecord; body: string }>> {
    await this.initialize();
    const folder = await this.revisionStore.activeDirectory(dir as CanonicalDirectory);
    const names = await readdir(folder);
    const records = await Promise.all(names.filter(name => name.endsWith(".md")).map(async name => {
      const text = await readFile(join(folder, name), "utf8");
      return parseRecord(text);
    }));
    return records;
  }

  async records(): Promise<Array<{ record: KnowledgeRecord; body: string }>> {
    const [registry, memory, events] = await Promise.all([this.readDirectory("registry"), this.readDirectory("memory"), this.readDirectory("events")]);
    return [...registry, ...memory, ...events];
  }

  async get(id: string): Promise<{ record: KnowledgeRecord; body: string } | null> {
    const found = (await this.records()).find(item => item.record.id === id);
    return found ?? null;
  }

  async upsertRecord(input: RecordInput, body = ""): Promise<KnowledgeRecord> {
    const existing = await this.get(input.id);
    const record: KnowledgeRecord = {
      ...input,
      created_at: existing?.record.created_at ?? input.created_at ?? now(),
      updated_at: now(),
      source_refs: input.source_refs ?? [],
      confidentiality: input.confidentiality ?? "internal",
      schema_version: input.schema_version ?? 1,
    };
    await this.writeRecord(record, body);
    return record;
  }

  async startWork(input: { project_id: string; objective: string; expected_outputs: string[]; acceptance_criteria: string[]; actor: string; input_refs?: string[] }): Promise<{ work_id: string; knowledge_version: string; brief_uri: string; main_uri: string; closeout_requirements: string[] }> {
    const project = await this.get(input.project_id);
    if (!project || project.record.type !== "project") throw new Error(`Unknown project: ${input.project_id}`);
    const workId = newId("work_item");
    const record = await this.upsertRecord({
      id: workId,
      type: "work_item",
      title: input.objective,
      status: "in_progress",
      project_id: input.project_id,
      created_by: input.actor,
      objective: input.objective,
      expected_outputs: input.expected_outputs,
      acceptance_criteria: input.acceptance_criteria,
      input_refs: input.input_refs ?? [],
    });
    return {
      work_id: record.id,
      knowledge_version: digest(JSON.stringify((await this.records()).map(item => [item.record.id, item.record.updated_at]))).slice(0, 16),
      brief_uri: `kb://project/${encodeURIComponent(input.project_id)}/brief`,
      main_uri: `kb://project/${encodeURIComponent(input.project_id)}/main`,
      closeout_requirements: ["refresh affected maintained sections", "refresh the main file only if project-wide cognition or routes changed", "publish durable resources", "capture distilled project context", "run detail RAG for factual claims", "summary", "result_hash", "outcome", "evidence_refs for factual memory"],
    };
  }

  private managedResourcePath(relativePath: string): string {
    if (isAbsolute(relativePath) || !relativePath.startsWith("agent-resources/")) throw new Error("Managed resources must stay inside agent-resources");
    const rootPath = resolve(this.root);
    const target = resolve(rootPath, relativePath);
    const fromRoot = relative(rootPath, target);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error("Managed resource path escapes the knowledge root");
    return target;
  }

  private decodePublishedContent(input: PublishResourceInput): Buffer {
    if (!PUBLISHABLE_MIME_TYPES.has(input.content_type)) throw new Error(`Unsupported published resource content_type: ${input.content_type}`);
    if (input.encoding === "utf8" && !INLINE_TEXT_MIME_TYPES.has(input.content_type)) throw new Error(`${input.content_type} resources must use base64 encoding`);
    let bytes: Buffer;
    if (input.encoding === "utf8") {
      if (SECRET_PATTERN.test(input.content)) throw new Error("Published text appears to contain a credential or private key");
      if (input.content_type === "application/json") JSON.parse(input.content);
      bytes = Buffer.from(input.content, "utf8");
    } else {
      const compact = input.content.replace(/\s+/g, "");
      if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new Error("Invalid base64 resource content");
      bytes = Buffer.from(compact, "base64");
      if (bytes.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) throw new Error("Invalid base64 resource content");
    }
    if (INLINE_TEXT_MIME_TYPES.has(input.content_type) && SECRET_PATTERN.test(bytes.toString("utf8"))) throw new Error("Published text appears to contain a credential or private key");
    if (bytes.length === 0) throw new Error("Published resource content cannot be empty");
    if (bytes.length > MAX_INLINE_RESOURCE_BYTES) throw new Error(`Published resource exceeds the ${MAX_INLINE_RESOURCE_BYTES}-byte managed resource limit`);
    return bytes;
  }

  private validatePublishedBytes(input: PublishResourceBytesInput): Buffer {
    if (!PUBLISHABLE_MIME_TYPES.has(input.content_type)) throw new Error(`Unsupported published resource content_type: ${input.content_type}`);
    const bytes = Buffer.from(input.bytes);
    if (INLINE_TEXT_MIME_TYPES.has(input.content_type)) {
      const text = bytes.toString("utf8");
      if (SECRET_PATTERN.test(text)) throw new Error("Published text appears to contain a credential or private key");
      if (input.content_type === "application/json") JSON.parse(text);
    }
    if (bytes.length === 0) throw new Error("Published resource content cannot be empty");
    if (bytes.length > MAX_INLINE_RESOURCE_BYTES) throw new Error(`Published resource exceeds the ${MAX_INLINE_RESOURCE_BYTES}-byte managed resource limit`);
    return bytes;
  }

  private async writeManagedResource(relativePath: string, bytes: Buffer): Promise<void> {
    const target = this.managedResourcePath(relativePath);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes);
    await rename(temp, target);
  }

  async publishResource(input: PublishResourceInput): Promise<PublishedResource> {
    const { encoding: _encoding, content: _content, ...metadata } = input;
    return this.publishResourceBytes({ ...metadata, bytes: this.decodePublishedContent(input) });
  }

  async publishResourceBytes(input: PublishResourceBytesInput): Promise<PublishedResource> {
    const workItem = await this.get(input.work_id);
    if (!workItem || workItem.record.type !== "work_item") throw new Error(`Unknown work item: ${input.work_id}`);
    const work = workItem.record;
    const bytes = this.validatePublishedBytes(input);
    const sha256 = digestBytes(bytes);
    const rawName = input.filename.split(/[\\/]/).pop()?.trim() ?? "";
    const filename = rawName.replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]/g, "-").replace(/-+/g, "-").slice(0, 160);
    if (!filename || filename === "." || filename === "..") throw new Error("filename must contain a safe file name");
    const artifactId = `artifact:argon:${digest(`${work.id}:${filename}:${sha256}`).slice(0, 24)}`;
    const existing = await this.get(artifactId);
    if (existing?.record.type === "artifact" && existing.record.sha256 === sha256 && existing.record.source_work_id === work.id) {
      return {
        artifact_id: artifactId, work_id: work.id, status: existing.record.status, sha256, size_bytes: bytes.length,
        resource_uri: `kb://artifact/${encodeURIComponent(artifactId)}/document`, searchable: typeof existing.record.normalized_markdown_path === "string",
        raw_resource_uri: `kb://artifact/${encodeURIComponent(artifactId)}/raw`,
        mineru_parse_supported: MINERU_MIME_TYPES.has(input.content_type),
      };
    }
    if (!['in_progress', 'blocked'].includes(work.status)) throw new Error(`Work item ${work.id} is already closed; start a follow-up work item`);

    const managedRelativePath = `agent-resources/${safeName(work.project_id)}/${safeName(work.id)}/${sha256.slice(0, 16)}-${filename}`;
    await this.writeManagedResource(managedRelativePath, bytes);
    let status = "registered";
    let normalizedMarkdownPath: string | undefined;
    let parseReportPath: string | undefined;
    let imageAssociations: ImageAssociation[] = [];
    if (INLINE_TEXT_MIME_TYPES.has(input.content_type)) {
      const text = bytes.toString("utf8");
      const normalized = input.content_type === "text/markdown" ? text : `# ${input.title}\n\n${text}`;
      normalizedMarkdownPath = `normalized/${safeName(artifactId)}/document.md`;
      parseReportPath = `normalized/${safeName(artifactId)}/parse-report.json`;
      const normalizedContent = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
      await this.writeDerived(normalizedMarkdownPath, normalizedContent);
      await this.writeDerived(parseReportPath, JSON.stringify({ artifact_id: artifactId, input_sha256: sha256, parser: "agent_inline_text", parser_mode: "local", egress: "none", normalized_markdown_path: normalizedMarkdownPath, completed_at: now() }, null, 2) + "\n");
      imageAssociations = extractImageAssociations(normalizedContent, artifactId);
      status = "parsed";
    }
    await this.upsertRecord({
      id: artifactId, type: "artifact", title: input.title, status, project_id: work.project_id, created_by: input.actor,
      mime_type: input.content_type, size_bytes: bytes.length, sha256, original_relative_path: managedRelativePath, managed_relative_path: managedRelativePath,
      managed_upload: true, acquired_at: now(), source_kind: "agent_generated", source_work_id: work.id, resource_kind: input.kind,
      source_refs: uniqueStrings([work.id, ...(input.source_refs ?? [])]), confidentiality: input.confidentiality ?? "internal",
      parser_status: status === "parsed" ? "completed" : "not_requested", parser_name: status === "parsed" ? "agent_inline_text" : undefined,
      parser_mode: status === "parsed" ? "local" : undefined, normalized_markdown_path: normalizedMarkdownPath, parse_report_path: parseReportPath,
      parsed_page_count: 0, image_associations: imageAssociations,
    }, `# ${input.title}\n\nAgent-generated resource captured from work item ${work.id}. It is persistent project material, not independently verified evidence.\n`);
    await this.appendAudit({ type: "agent_resource_published", artifact_id: artifactId, work_id: work.id, project_id: work.project_id, actor: input.actor, sha256, size_bytes: bytes.length, mime_type: input.content_type });
    const modality = input.content_type.startsWith("image/") ? "image" as const : input.content_type.startsWith("video/") ? "video" as const : undefined;
    await this.enqueueMaintenance({
      project_id: work.project_id, trigger: "resource_published", idempotency_key: `resource:${artifactId}:${sha256}`,
      text_context: `Agent resource published: ${input.title} (${input.kind}, ${input.content_type})`, evidence_refs: [artifactId],
      media: modality ? [{ evidence_id: `evidence:${artifactId}:raw`, artifact_id: artifactId, modality, mime_type: input.content_type, sha256, locator: {}, transport: "base64_data_uri", value: `data:${input.content_type};base64,${bytes.toString("base64")}`, native_video_required: modality === "video" }] : [],
    });
    return {
      artifact_id: artifactId, work_id: work.id, status, sha256, size_bytes: bytes.length,
      resource_uri: `kb://artifact/${encodeURIComponent(artifactId)}/document`, searchable: status === "parsed",
      raw_resource_uri: `kb://artifact/${encodeURIComponent(artifactId)}/raw`,
      mineru_parse_supported: MINERU_MIME_TYPES.has(input.content_type),
    };
  }

  private memoryFromSubmission(work: KnowledgeRecord, submission: MemorySubmission, actor: string, resultHash: string, ordinal: number): KnowledgeRecord {
    const id = `memory:argon:${digest(`${work.id}:${resultHash}:${ordinal}:${submission.kind}:${submission.statement}`).slice(0, 24)}`;
    const timestamp = now();
    return {
      id,
      type: "memory",
      title: submission.statement.slice(0, 120),
      status: "candidate",
      project_id: work.project_id,
      created_at: timestamp,
      updated_at: timestamp,
      created_by: actor,
      source_refs: submission.evidence_refs ?? [],
      confidentiality: "internal",
      schema_version: 1,
      kind: submission.kind,
      statement: submission.statement,
      scope: submission.scope,
      source_work_id: work.id,
      evidence_refs: submission.evidence_refs ?? [],
      confidence: submission.confidence ?? 0.5,
      policy_version: POLICY_VERSION,
    };
  }

  private async evaluateMemory(candidate: KnowledgeRecord, actor: string): Promise<{ decision: ValidationDecision; reasons: string[]; remediation?: string }> {
    const statement = String(candidate.statement ?? "");
    const kind = String(candidate.kind ?? "");
    const refs = Array.isArray(candidate.evidence_refs) ? candidate.evidence_refs.filter((ref): ref is string => typeof ref === "string") : [];
    if (SECRET_PATTERN.test(statement)) return { decision: "rejected", reasons: ["secret_pattern_detected"] };
    if (statement.trim().length < 8) return { decision: "rejected", reasons: ["statement_too_short"] };
    if (kind !== "open_question" && refs.length === 0) return { decision: "quarantined", reasons: ["missing_evidence"], remediation: "add_evidence" };
    if (kind === "lesson" && refs.length < 2) return { decision: "quarantined", reasons: ["lesson_requires_independent_evidence"], remediation: "add_independent_evidence" };
    if (["decision", "constraint", "preference"].includes(kind) && !refs.some(ref => ref.startsWith("user:") || ref.startsWith("adr:"))) {
      return { decision: "quarantined", reasons: ["missing_authoritative_directive"], remediation: "add_authoritative_source" };
    }
    const existing = (await this.records()).map(item => item.record).filter(record =>
      record.type === "memory" && record.status === "accepted" && record.id !== candidate.id &&
      record.kind === candidate.kind && record.scope === candidate.scope && record.statement !== candidate.statement,
    );
    if (existing.length > 0) {
      for (const record of existing) await this.upsertRecord({ ...record, status: "disputed", created_by: actor });
      return { decision: "quarantined", reasons: ["conflicts_with_accepted_memory"], remediation: "reconcile_conflict" };
    }
    return { decision: "accepted", reasons: ["policy_gates_passed"] };
  }

  private async appendAudit(event: Record<string, unknown>): Promise<string> {
    await this.initialize();
    const id = `audit:argon:${randomUUID().replace(/-/g, "")}`;
    const path = join(this.root, "audit", "events.jsonl");
    const line = JSON.stringify({ id, at: now(), ...event }) + "\n";
    // Appending is intentional: audit history is append-only.
    await writeFile(path, line, { encoding: "utf8", flag: "a" });
    return id;
  }

  private async validateAndStore(candidate: KnowledgeRecord, actor: string): Promise<{ status: ValidationDecision; eventId: string; remediation?: string }> {
    const verdict = await this.evaluateMemory(candidate, actor);
    const traceId = `trace:argon:${randomUUID().replace(/-/g, "")}`;
    const eventId = newId("validation_event");
    const event: ValidationEvent = {
      id: eventId,
      type: "validation_event",
      title: `Validation ${candidate.id}`,
      status: "completed",
      project_id: candidate.project_id,
      created_at: now(),
      updated_at: now(),
      created_by: actor,
      source_refs: candidate.source_refs ?? [],
      confidentiality: "internal",
      schema_version: 1,
      decision: verdict.decision,
      reason_codes: verdict.reasons,
      subject_ref: candidate.id,
      policy_id: POLICY_ID,
      policy_version: POLICY_VERSION,
      input_hash: digest(JSON.stringify(candidate)),
      trace_id: traceId,
    };
    await this.writeRecord(event, `# Validation event\n\n${verdict.reasons.join(", ")}`);
    await this.upsertRecord({ ...candidate, status: verdict.decision, validation_event_ref: eventId, validation_status: verdict.decision === "accepted" ? "verified" : verdict.decision === "rejected" ? "rejected" : "quarantined", created_by: candidate.created_by });
    return { status: verdict.decision, eventId, remediation: verdict.remediation };
  }

  private async persistMemorySubmissions(work: KnowledgeRecord, submissions: MemorySubmission[], actor: string, seed: string): Promise<{
    promoted: string[]; quarantined: string[]; rejected: string[]; validationEvents: string[]; remediation: string[];
  }> {
    const output = { promoted: [] as string[], quarantined: [] as string[], rejected: [] as string[], validationEvents: [] as string[], remediation: [] as string[] };
    for (const [ordinal, submission] of submissions.entries()) {
      const candidate = this.memoryFromSubmission(work, submission, actor, seed, ordinal);
      const existing = await this.get(candidate.id);
      if (existing?.record.validation_event_ref) {
        const status = existing.record.status as ValidationDecision;
        if (status === "accepted") output.promoted.push(candidate.id);
        else if (status === "rejected") output.rejected.push(candidate.id);
        else output.quarantined.push(candidate.id);
        continue;
      }
      await this.writeRecord(candidate, `# ${candidate.title}\n\n${submission.statement}`);
      const verdict = await this.validateAndStore(candidate, actor);
      output.validationEvents.push(verdict.eventId);
      if (verdict.status === "accepted") output.promoted.push(candidate.id);
      else if (verdict.status === "rejected") output.rejected.push(candidate.id);
      else output.quarantined.push(candidate.id);
      if (verdict.remediation) output.remediation.push(`remediation:${candidate.id}:${verdict.remediation}`);
    }
    return output;
  }

  async captureContext(input: { work_id: string; summary: string; updates: MemorySubmission[]; actor: string }): Promise<CaptureContextResult> {
    const current = await this.get(input.work_id);
    if (!current || current.record.type !== "work_item") throw new Error(`Unknown work item: ${input.work_id}`);
    if (input.summary.trim().length < 3) throw new Error("Context checkpoint summary is too short");
    if (input.updates.length === 0) throw new Error("Context checkpoint requires at least one structured update");
    if (SECRET_PATTERN.test(input.summary)) throw new Error("Context checkpoint summary appears to contain a credential or private key");
    const checkpointHash = digest(JSON.stringify({ work_id: input.work_id, summary: input.summary, updates: input.updates }));
    const checkpointId = `activity:argon:context-${checkpointHash.slice(0, 24)}`;
    const existingCheckpoint = await this.get(checkpointId);
    if (existingCheckpoint?.record.capture_result && typeof existingCheckpoint.record.capture_result === "object") return existingCheckpoint.record.capture_result as CaptureContextResult;
    if (!["in_progress", "blocked"].includes(current.record.status)) throw new Error(`Work item ${input.work_id} is already closed; start a follow-up work item`);
    const stored = await this.persistMemorySubmissions(current.record, input.updates, input.actor, `context:${checkpointHash}`);
    const auditEventId = await this.appendAudit({
      type: "agent_context_captured", work_id: current.record.id, project_id: current.record.project_id, actor: input.actor,
      checkpoint_hash: checkpointHash, promoted_memory_ids: stored.promoted, quarantined_memory_ids: stored.quarantined,
      rejected_memory_ids: stored.rejected, validation_event_ids: stored.validationEvents,
    });
    const result: CaptureContextResult = {
      checkpoint_hash: checkpointHash, promoted_memory_ids: stored.promoted, quarantined_memory_ids: stored.quarantined,
      rejected_memory_ids: stored.rejected, validation_event_ids: stored.validationEvents, audit_event_id: auditEventId,
    };
    await this.upsertRecord({
      id: checkpointId, type: "activity", title: input.summary.slice(0, 120), status: "completed", project_id: current.record.project_id,
      created_by: input.actor, kind: "context_checkpoint", occurred_at: now(), source_work_id: current.record.id,
      checkpoint_hash: checkpointHash, capture_result: result,
      source_refs: uniqueStrings([current.record.id, ...stored.promoted, ...stored.quarantined, ...stored.rejected]),
    }, `# Context checkpoint\n\n${input.summary}\n`);
    await this.enqueueMaintenance({ project_id: current.record.project_id, trigger: "context_captured", idempotency_key: `context:${checkpointHash}`, text_context: input.summary, evidence_refs: uniqueStrings([...stored.promoted, ...stored.quarantined, ...stored.rejected]) });
    return result;
  }

  async finishWork(input: FinishWorkInput): Promise<FinishWorkResult> {
    const current = await this.get(input.work_id);
    if (!current || current.record.type !== "work_item") throw new Error(`Unknown work item: ${input.work_id}`);
    const work = current.record;
    if (work.result_hash && work.result_hash !== input.result_hash) throw new Error("Work item already has a different result_hash; create a follow-up work item instead");
    if (work.result_hash === input.result_hash && work.closeout_result && typeof work.closeout_result === "object") return work.closeout_result as FinishWorkResult;

    const submissions: MemorySubmission[] = [
      ...(input.claims ?? []).map(item => ({ ...item, kind: "fact" as const })),
      ...(input.decisions ?? []).map(item => ({ ...item, kind: "decision" as const })),
      ...(input.lessons ?? []).map(item => ({ ...item, kind: "lesson" as const })),
      ...(input.knowledge_updates ?? []),
    ];
    const result: FinishWorkResult = {
      work_status: input.outcome === "completed" ? "completed" : input.outcome === "cancelled" ? "cancelled" : "blocked",
      accepted_updates: [], promoted_memory_ids: [], quarantined_memory_ids: [], rejected_memory_ids: [], remediation_work_ids: [], validation_event_ids: [],
      policy_trace_id: `trace:argon:${randomUUID().replace(/-/g, "")}`,
      audit_event_id: "",
    };
    const stored = await this.persistMemorySubmissions(work, submissions, input.actor, input.result_hash);
    result.promoted_memory_ids.push(...stored.promoted);
    result.quarantined_memory_ids.push(...stored.quarantined);
    result.rejected_memory_ids.push(...stored.rejected);
    result.validation_event_ids.push(...stored.validationEvents);
    result.remediation_work_ids.push(...stored.remediation);
    result.accepted_updates = result.promoted_memory_ids;
    const generatedArtifacts = (await this.lookup("artifact", { source_work_id: work.id }, 100)).map(record => record.id);
    const artifactRefs = uniqueStrings([...(input.artifacts ?? []), ...generatedArtifacts]);
    result.audit_event_id = await this.appendAudit({ type: "work_closeout", work_id: work.id, result_hash: input.result_hash, actor: input.actor, result });
    await this.upsertRecord({
      ...work,
      status: result.work_status,
      created_by: work.created_by,
      result_hash: input.result_hash,
      closeout_result: result,
      closeout_summary: input.summary,
      outcome: input.outcome,
      artifacts: artifactRefs,
      unresolved: input.unresolved ?? [],
      evidence_refs: input.evidence_refs ?? [],
    }, current.body);
    await this.enqueueMaintenance({ project_id: work.project_id, trigger: "work_finished", idempotency_key: `work:${work.id}:${input.result_hash}`, text_context: input.summary, evidence_refs: uniqueStrings([...(input.evidence_refs ?? []), ...artifactRefs, ...result.promoted_memory_ids, ...result.quarantined_memory_ids]) });
    return result;
  }

  async lookup(entityType: string, filters: Record<string, string | number | boolean | undefined> = {}, limit = 20): Promise<KnowledgeRecord[]> {
    const normalized = Object.entries(filters).filter(([, value]) => value !== undefined);
    return (await this.records()).map(item => item.record).filter(record => {
      if (record.type !== entityType) return false;
      return normalized.every(([key, value]) => String(record[key]) === String(value));
    }).slice(0, Math.min(limit, 100));
  }

  private graphNode(record: KnowledgeRecord): KnowledgeGraphNode {
    return { id: record.id, type: record.type, title: record.title, status: record.status, uri: `kb://record/${encodeURIComponent(record.id)}` };
  }

  private graphEdges(records: KnowledgeRecord[]): KnowledgeGraphEdge[] {
    const edges: KnowledgeGraphEdge[] = [];
    for (const record of records) {
      if (record.id !== record.project_id) edges.push({ from: record.id, to: record.project_id, relation: "part_of_project", field: "project_id" });
      for (const { field, relation } of GRAPH_REFERENCE_FIELDS) {
        for (const target of asStrings(record[field])) {
          if (target !== record.id) edges.push({ from: record.id, to: target, relation, field });
        }
      }
    }
    const seen = new Set<string>();
    return edges.filter(edge => {
      const key = `${edge.from}\u0000${edge.to}\u0000${edge.relation}\u0000${edge.field}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private excerptAroundQuery(text: string, query: string | undefined, maxChars: number): { text: string; truncated: boolean } {
    return excerptAroundSearchQuery(text, query, maxChars);
  }

  async graphContext(input: {
    node_id: string; depth?: number; query?: string; artifact_mode?: "metadata" | "excerpt" | "full";
    max_nodes?: number; max_artifacts?: number; max_tokens?: number; maximum_confidentiality?: Confidentiality;
  }): Promise<GraphContextResult> {
    const depth = Math.max(0, Math.min(input.depth ?? 1, 2));
    const maxNodes = Math.max(1, Math.min(input.max_nodes ?? 30, 80));
    const maxArtifacts = Math.max(0, Math.min(input.max_artifacts ?? 5, 12));
    const maxChars = Math.max(400, Math.min(input.max_tokens ?? 1800, 8000) * 4);
    const maximum = input.maximum_confidentiality ?? "internal";
    const items = (await this.records()).filter(item => confidentialityAllowed(item.record, maximum));
    const byId = new Map(items.map(item => [item.record.id, item]));
    const focusItem = byId.get(input.node_id);
    if (!focusItem) throw new Error(`Knowledge graph node not found or not visible: ${input.node_id}`);
    const allEdges = this.graphEdges(items.map(item => item.record));
    const selected = new Set<string>([input.node_id]);
    let frontier = new Set<string>([input.node_id]);
    for (let step = 0; step < depth && selected.size < maxNodes; step++) {
      const next = new Set<string>();
      for (const edge of allEdges) {
        const candidate = frontier.has(edge.from) ? edge.to : frontier.has(edge.to) ? edge.from : undefined;
        if (!candidate || !byId.has(candidate) || selected.has(candidate)) continue;
        selected.add(candidate);
        next.add(candidate);
        if (selected.size >= maxNodes) break;
      }
      frontier = next;
    }
    const edges = allEdges.filter(edge => selected.has(edge.from) && selected.has(edge.to));
    const nodes = [...selected].filter(id => id !== input.node_id).map(id => this.graphNode(byId.get(id)!.record));
    const directArtifactIds = new Set(edges.filter(edge => edge.from === input.node_id || edge.to === input.node_id).flatMap(edge => [edge.from, edge.to]).filter(id => byId.get(id)?.record.type === "artifact"));
    const artifactItems = [...selected]
      .filter(id => byId.get(id)?.record.type === "artifact")
      .sort((a, b) => Number(directArtifactIds.has(b)) - Number(directArtifactIds.has(a)))
      .slice(0, maxArtifacts)
      .map(id => byId.get(id)!);
    const focusRaw = focusItem.record.type === "artifact" && typeof focusItem.record.normalized_markdown_path === "string"
      ? await readFile(join(this.root, focusItem.record.normalized_markdown_path), "utf8").catch(() => focusItem.body)
      : focusItem.body || renderRecord(focusItem.record, focusItem.body);
    const focusBudget = artifactItems.length > 0 && input.artifact_mode !== "metadata" ? Math.max(800, Math.floor(maxChars * 0.55)) : maxChars;
    const focusExcerpt = this.excerptAroundQuery(focusRaw, input.query, focusBudget);
    let remainingChars = Math.max(0, maxChars - focusExcerpt.text.length);
    const artifacts: LinkedArtifact[] = [];
    for (const [index, item] of artifactItems.entries()) {
      const record = item.record;
      const normalizedPath = typeof record.normalized_markdown_path === "string" ? record.normalized_markdown_path : undefined;
      const artifact: LinkedArtifact = {
        ...this.graphNode(record), mime_type: typeof record.mime_type === "string" ? record.mime_type : undefined,
        source_kind: typeof record.source_kind === "string" ? record.source_kind : undefined,
        sha256: typeof record.sha256 === "string" ? record.sha256 : undefined,
        created_by: record.created_by,
        document_uri: normalizedPath ? `kb://artifact/${encodeURIComponent(record.id)}/document` : undefined,
        visual_context: Array.isArray(record.image_associations) ? record.image_associations as ImageAssociation[] : undefined,
      };
      if (input.artifact_mode !== "metadata" && normalizedPath && remainingChars > 0) {
        const remainingArtifacts = artifactItems.length - index;
        const budget = Math.max(200, Math.floor(remainingChars / remainingArtifacts));
        const full = await readFile(join(this.root, normalizedPath), "utf8").catch(() => "");
        const excerpt = this.excerptAroundQuery(full, input.artifact_mode === "full" ? undefined : input.query, budget);
        artifact.excerpt = excerpt.text;
        artifact.excerpt_truncated = excerpt.truncated;
        remainingChars = Math.max(0, remainingChars - excerpt.text.length);
      }
      artifacts.push(artifact);
    }
    const known = new Set(byId.keys());
    const externalRefs = uniqueStrings([...selected].flatMap(id => {
      const record = byId.get(id)!.record;
      return GRAPH_REFERENCE_FIELDS.flatMap(({ field }) => asStrings(record[field])).filter(ref => !known.has(ref));
    }));
    return {
      focus: { ...this.graphNode(focusItem.record), content: focusExcerpt.text, content_truncated: focusExcerpt.truncated },
      nodes, edges, artifacts, external_refs: externalRefs, depth,
    };
  }

  async linkedArtifacts(nodeId: string, limit = 5, maximumConfidentiality: Confidentiality = "internal"): Promise<LinkedArtifact[]> {
    return (await this.graphContext({ node_id: nodeId, depth: 1, artifact_mode: "metadata", max_nodes: 40, max_artifacts: limit, max_tokens: 100, maximum_confidentiality: maximumConfidentiality })).artifacts;
  }

  async search(query: string, limit = 5, includeUnverified = false, maximumConfidentiality: Confidentiality = "internal", projectId?: string): Promise<Array<{ record: KnowledgeRecord; score: number; snippet: string; visual_context?: ImageAssociation[]; linked_artifacts?: LinkedArtifact[] }>> {
    const indexed = await Promise.all((await this.records()).map(async (item) => {
      let normalized = "";
      if (item.record.type === "artifact" && typeof item.record.normalized_markdown_path === "string") {
        try { normalized = await readFile(join(this.root, item.record.normalized_markdown_path), "utf8"); } catch { /* stale derived text is excluded */ }
      }
      return { ...item, normalized, haystack: `${item.record.title}\n${item.body}\n${normalized}\n${JSON.stringify(item.record)}` };
    }));
    const visible = indexed
      .filter(item => confidentialityAllowed(item.record, maximumConfidentiality))
      .filter(item => !projectId || item.record.project_id === projectId || item.record.id === projectId)
      .filter(item => item.record.type !== "validation_event")
      .filter(item => includeUnverified || item.record.status === "accepted" || item.record.type !== "memory");
    const matches = rankSearchDocuments(
      query,
      visible.map(item => ({ item, key: item.record.id, title: item.record.title, text: item.haystack })),
      Math.min(limit, 20),
    ).map(match => {
        const item = match.item;
        const imageAssociations = item.record.type === "artifact" ? (item.record.image_associations as ImageAssociation[] | undefined) : undefined;
        const visualContext = imageAssociations?.length ? imageAssociations.slice(0, 5) : undefined;
        return { record: item.record, score: match.score, snippet: match.excerpt, visual_context: visualContext?.length ? visualContext : undefined };
      });
    return Promise.all(matches.map(async item => {
      const linkedArtifacts = item.record.type === "artifact" ? [] : await this.linkedArtifacts(item.record.id, 3, maximumConfidentiality).catch(() => []);
      return { ...item, linked_artifacts: linkedArtifacts.length ? linkedArtifacts : undefined };
    }));
  }

  async updateProjectMain(input: {
    project_id: string; work_id: string; markdown: string; expected_revision: string; change_summary: string;
    source_refs?: string[]; actor: string; maximum_confidentiality?: Confidentiality;
  }): Promise<UpdateProjectMainResult> {
    const current = await this.get(input.project_id);
    if (!current || current.record.type !== "project") throw new Error(`Unknown project: ${input.project_id}`);
    if (!confidentialityAllowed(current.record, input.maximum_confidentiality ?? "internal")) throw new Error("Project main file is outside this profile's confidentiality scope");
    const work = await this.get(input.work_id);
    if (!work || work.record.type !== "work_item" || work.record.project_id !== input.project_id) throw new Error("Project main updates require a work item in the same project");
    const markdown = input.markdown.trimEnd() + "\n";
    if (!markdown.startsWith("# ")) throw new Error("Project main file must start with a level-1 Markdown heading");
    if (markdown.length > 24_000) throw new Error("Project main file exceeds the 24,000-character limit; move details into knowledge sections");
    if (SECRET_PATTERN.test(`${input.change_summary}\n${markdown}`)) throw new Error("Project main update appears to contain a credential or private key");
    const previousRevision = typeof current.record.main_revision === "string" ? current.record.main_revision : digest(current.body);
    const revision = digest(markdown);
    if (revision === previousRevision) {
      return { project_id: input.project_id, main_uri: `kb://project/${encodeURIComponent(input.project_id)}/main`, revision_hash: revision, previous_revision_hash: previousRevision, changed: false };
    }
    if (!["in_progress", "blocked"].includes(work.record.status)) throw new Error("Project main updates require an active work item in the same project");
    if (input.expected_revision !== previousRevision) throw new Error(`Project main revision conflict: expected ${input.expected_revision}, current ${previousRevision}`);
    if (current.body) await this.writeDerived(`history/project-main/${safeName(input.project_id)}/${safeName(now())}-${previousRevision.slice(0, 12)}.md`, renderRecord(current.record, current.body));
    await this.upsertRecord({
      ...current.record, created_by: current.record.created_by, updated_by: input.actor,
      main_revision: revision, main_updated_at: now(), main_change_summary: input.change_summary,
      last_modified_work_id: input.work_id,
      source_refs: uniqueStrings([...(asStrings(current.record.source_refs)), input.work_id, ...(input.source_refs ?? [])]),
    }, markdown);
    const auditEventId = await this.appendAudit({ type: "project_main_updated", project_id: input.project_id, work_id: input.work_id, actor: input.actor, previous_revision_hash: previousRevision, revision_hash: revision, change_summary: input.change_summary });
    return { project_id: input.project_id, main_uri: `kb://project/${encodeURIComponent(input.project_id)}/main`, revision_hash: revision, previous_revision_hash: previousRevision, changed: true, audit_event_id: auditEventId };
  }

  private async updateSectionParentLinks(sectionId: string, previousParentId: string | undefined, nextParentId: string, actor: string): Promise<void> {
    const updateParent = async (parentId: string, add: boolean) => {
      const parent = await this.get(parentId);
      if (!parent || !["project", "knowledge_section"].includes(parent.record.type)) throw new Error(`Invalid knowledge section parent: ${parentId}`);
      const field = parent.record.type === "project" ? "section_refs" : "child_section_refs";
      const refs = asStrings(parent.record[field]);
      const next = add ? uniqueStrings([...refs, sectionId]) : refs.filter(ref => ref !== sectionId);
      await this.upsertRecord({ ...parent.record, created_by: parent.record.created_by, updated_by: actor, [field]: next }, parent.body);
    };
    if (previousParentId && previousParentId !== nextParentId) await updateParent(previousParentId, false);
    await updateParent(nextParentId, true);
  }

  async upsertKnowledgeSection(input: {
    project_id: string; work_id: string; key: string; title: string; summary: string; markdown: string; change_summary: string; actor: string;
    parent_ref?: string; artifact_refs?: string[]; related_refs?: string[]; source_refs?: string[]; expected_revision?: string;
    confidentiality?: Exclude<Confidentiality, "secret">; maximum_confidentiality?: Confidentiality;
  }): Promise<UpsertKnowledgeSectionResult> {
    const project = await this.get(input.project_id);
    if (!project || project.record.type !== "project") throw new Error(`Unknown project: ${input.project_id}`);
    const work = await this.get(input.work_id);
    if (!work || work.record.type !== "work_item" || work.record.project_id !== input.project_id) throw new Error("Knowledge section updates require a work item in the same project");
    const key = input.key.toLocaleLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(key)) throw new Error("Knowledge section key must be 2-80 lowercase ASCII letters, numbers, dots, underscores, or hyphens");
    const sectionId = `section:argon:${digest(input.project_id).slice(0, 8)}:${key}`;
    const existing = await this.get(sectionId);
    if (existing && existing.record.type !== "knowledge_section") throw new Error(`Section ID collision: ${sectionId}`);
    const maximum = input.maximum_confidentiality ?? "internal";
    if (existing && !confidentialityAllowed(existing.record, maximum)) throw new Error("Knowledge section is outside this profile's confidentiality scope");
    const parentRef = input.parent_ref ?? input.project_id;
    const parent = await this.get(parentRef);
    if (!parent || !["project", "knowledge_section"].includes(parent.record.type) || parent.record.project_id !== input.project_id) throw new Error("parent_ref must be this project or one of its knowledge sections");
    if (parentRef === sectionId) throw new Error("A knowledge section cannot be its own parent");
    const artifactRefs = uniqueStrings(input.artifact_refs ?? []).sort();
    for (const artifactId of artifactRefs) {
      const artifact = await this.get(artifactId);
      if (!artifact || artifact.record.type !== "artifact" || artifact.record.project_id !== input.project_id) throw new Error(`Unknown project artifact: ${artifactId}`);
    }
    const relatedRefs = uniqueStrings(input.related_refs ?? []).filter(ref => ref !== sectionId).sort();
    for (const relatedId of relatedRefs) {
      const related = await this.get(relatedId);
      if (!related || related.record.project_id !== input.project_id) throw new Error(`Unknown related project record: ${relatedId}`);
    }
    const markdown = input.markdown.trimEnd() + "\n";
    if (!markdown.startsWith("# ")) throw new Error("Knowledge section must start with a level-1 Markdown heading");
    if (markdown.length > 80_000) throw new Error("Knowledge section exceeds the 80,000-character limit; split it into child sections");
    if (SECRET_PATTERN.test(`${input.title}\n${input.summary}\n${input.change_summary}\n${markdown}`)) throw new Error("Knowledge section appears to contain a credential or private key");
    const confidentiality = input.confidentiality ?? existing?.record.confidentiality as Exclude<Confidentiality, "secret"> | undefined ?? "internal";
    if (!confidentialityAllowed({ id: sectionId, type: "knowledge_section", title: input.title, status: "active", project_id: input.project_id, created_at: "", updated_at: "", created_by: input.actor, confidentiality }, maximum)) throw new Error("Requested section confidentiality is outside this profile's scope");
    const semanticSourceRefs = uniqueStrings([...asStrings(existing?.record.source_refs).filter(ref => !ref.startsWith("work_item:")), ...(input.source_refs ?? [])]).sort();
    const revision = digest(JSON.stringify({ key, title: input.title, summary: input.summary, markdown, parent_ref: parentRef, artifact_refs: artifactRefs, related_refs: relatedRefs, source_refs: semanticSourceRefs, confidentiality }));
    const previousRevision = existing && typeof existing.record.revision_hash === "string" ? existing.record.revision_hash : undefined;
    if (existing && previousRevision === revision) {
      return { section_id: sectionId, section_uri: `kb://record/${encodeURIComponent(sectionId)}`, revision_hash: revision, previous_revision_hash: previousRevision, created: false, audit_event_id: String(existing.record.last_section_audit_id ?? "") };
    }
    if (!["in_progress", "blocked"].includes(work.record.status)) throw new Error("Knowledge section updates require an active work item in the same project");
    if (existing && input.expected_revision !== previousRevision) throw new Error(`Knowledge section revision conflict: expected ${input.expected_revision ?? "<missing>"}, current ${previousRevision}`);
    if (!existing && input.expected_revision) throw new Error("expected_revision must be omitted when creating a knowledge section");
    if (existing) await this.writeDerived(`history/knowledge-sections/${safeName(sectionId)}/${safeName(now())}-${previousRevision?.slice(0, 12) ?? "unknown"}.md`, renderRecord(existing.record, existing.body));
    await this.upsertRecord({
      id: sectionId, type: "knowledge_section", title: input.title, status: "active", project_id: input.project_id,
      created_by: existing?.record.created_by ?? input.actor, updated_by: input.actor, key, summary: input.summary, parent_ref: parentRef,
      artifact_refs: artifactRefs, related_refs: relatedRefs, child_section_refs: asStrings(existing?.record.child_section_refs),
      last_modified_work_id: input.work_id,
      source_refs: uniqueStrings([...asStrings(existing?.record.source_refs), input.work_id, ...semanticSourceRefs]),
      confidentiality,
      revision_hash: revision, section_change_summary: input.change_summary, section_updated_at: now(),
    }, markdown);
    await this.updateSectionParentLinks(sectionId, typeof existing?.record.parent_ref === "string" ? existing.record.parent_ref : undefined, parentRef, input.actor);
    const auditEventId = await this.appendAudit({ type: "knowledge_section_upserted", section_id: sectionId, project_id: input.project_id, work_id: input.work_id, actor: input.actor, created: !existing, previous_revision_hash: previousRevision, revision_hash: revision, artifact_refs: artifactRefs, change_summary: input.change_summary });
    const written = await this.get(sectionId);
    if (written) await this.upsertRecord({ ...written.record, created_by: written.record.created_by, last_section_audit_id: auditEventId }, written.body);
    return { section_id: sectionId, section_uri: `kb://record/${encodeURIComponent(sectionId)}`, revision_hash: revision, previous_revision_hash: previousRevision, created: !existing, audit_event_id: auditEventId };
  }

  async brief(projectId: string, maximumConfidentiality: Confidentiality = "internal"): Promise<Record<string, unknown>> {
    const items = (await this.records()).filter(item => confidentialityAllowed(item.record, maximumConfidentiality));
    const records = items.map(item => item.record);
    const projectItem = items.find(item => item.record.type === "project" && item.record.id === projectId) ?? null;
    const project = projectItem?.record ?? null;
    const activeWork = records.filter(record => record.type === "work_item" && record.project_id === projectId && ["in_progress", "awaiting_closeout", "blocked"].includes(record.status));
    const memories = records.filter(record => record.type === "memory" && record.project_id === projectId && record.status === "accepted").sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 20);
    const sections = records.filter(record => record.type === "knowledge_section" && record.project_id === projectId && record.status === "active");
    const openConflictItems = items.filter(item => item.record.type === "conflict" && item.record.project_id === projectId && ["open", "resolution_pending"].includes(item.record.status));
    const legacyEntries = records.filter(record => record.project_id === projectId && ["workstream", "deliverable"].includes(record.type));
    const edges = this.graphEdges(records.filter(record => record.project_id === projectId || record.id === projectId));
    const mainMarkdown = projectItem?.body ?? "";
    const mainRevision = project && typeof project.main_revision === "string" ? project.main_revision : digest(mainMarkdown);
    return {
      project_id: projectId,
      project: project ? { id: project.id, title: project.title, status: project.status, mission: project.mission } : null,
      main_file: project ? { uri: `kb://project/${encodeURIComponent(projectId)}/main`, title: project.title, markdown: mainMarkdown, revision_hash: mainRevision, updated_at: project.updated_at } : null,
      navigation: {
        sections: sections.map(record => ({ ...this.graphNode(record), key: record.key, summary: record.summary, revision_hash: record.revision_hash, artifact_count: asStrings(record.artifact_refs).length, child_section_refs: asStrings(record.child_section_refs) })),
        domain_records: legacyEntries.map(record => ({ ...this.graphNode(record), artifact_count: uniqueStrings([...asStrings(record.artifact_refs), ...asStrings(record.source_refs).filter(ref => ref.startsWith("artifact:"))]).length })),
      },
      graph: { node_count: records.filter(record => record.project_id === projectId || record.id === projectId).length, edge_count: edges.length },
      active_work: activeWork.map(record => ({ id: record.id, title: record.title, status: record.status })),
      accepted_memory: memories.map(record => ({ id: record.id, kind: record.kind, statement: record.statement, scope: record.scope })),
      open_conflicts: openConflictItems.map(({ record, body }) => ({ id: record.id, title: record.title, status: record.status, topic: record.topic, severity: record.severity, suggested_user_question: record.suggested_user_question, revision_hash: digest(renderRecord(record, body)), uri: `kb://record/${encodeURIComponent(record.id)}` })),
      generated_at: now(),
    };
  }

  async submitUserConflictResolution(input: {
    conflict_id: string; expected_conflict_revision: string; resolution_statement: string; source_turn_ref: string;
    user_statement_hash: string; idempotency_key: string; actor_principal: string;
  }): Promise<Record<string, unknown>> {
    const found = await this.get(input.conflict_id);
    if (!found || found.record.type !== "conflict") throw new Error(`Unknown conflict: ${input.conflict_id}`);
    if (found.record.status !== "open") throw new Error(`Conflict is ${found.record.status}, expected open`);
    const currentRevision = digest(renderRecord(found.record, found.body));
    if (currentRevision !== input.expected_conflict_revision) throw new Error(`Conflict revision conflict: expected ${input.expected_conflict_revision}, current ${currentRevision}`);
    if (digest(input.resolution_statement) !== input.user_statement_hash) throw new Error("user_statement_hash does not match resolution_statement");
    const existing = (await this.lookup("user_conflict_resolution", { idempotency_key: input.idempotency_key }, 2))[0];
    if (existing) return { conflict_id: input.conflict_id, status: "resolution_pending", resolution_id: existing.id, current_conflict_revision: currentRevision, actor_principal: input.actor_principal, attestation_mode: "verified_principal", idempotent_replay: true };
    const resolutionId = newId("user_conflict_resolution");
    const queueIdempotencyKey = `resolution:${input.idempotency_key}`;
    const packetId = `packet:argon:${digest(queueIdempotencyKey).slice(0, 24)}`;
    const createdAt = now();
    const common = { project_id: found.record.project_id, created_at: createdAt, updated_at: createdAt, confidentiality: found.record.confidentiality ?? "internal", schema_version: 1 };
    const resolution: KnowledgeRecord = {
      ...common, id: resolutionId, type: "user_conflict_resolution", title: `Resolution for ${input.conflict_id}`, status: "locked",
      created_by: input.actor_principal, conflict_id: input.conflict_id, expected_conflict_revision: input.expected_conflict_revision,
      resolution_statement: input.resolution_statement, source_turn_ref: input.source_turn_ref, user_statement_hash: input.user_statement_hash,
      idempotency_key: input.idempotency_key, submitted_by_principal: input.actor_principal, attestation_mode: "verified_principal", change_packet_id: packetId,
    };
    const conflict: KnowledgeRecord = { ...found.record, status: "resolution_pending", resolution_ref: resolutionId, resolution_locked_at: createdAt, updated_at: createdAt };
    const packet: KnowledgeRecord = {
      ...common, id: packetId, type: "maintenance_change_packet", title: `Apply resolution ${resolutionId}`, status: "queued",
      created_by: "conflict-service", trigger: "user_resolution_locked", idempotency_key: input.idempotency_key,
      locked_user_resolution_ref: resolutionId, conflict_refs: [input.conflict_id],
    };
    await this.revisionStore.publish([
      { directory: "registry", filename: `${safeName(resolution.id)}.md`, content: renderRecord(resolution, "# Locked user conflict resolution\n\nThis record is immutable input to the maintenance harness.\n") },
      { directory: this.directoryFor(conflict) as CanonicalDirectory, filename: `${safeName(conflict.id)}.md`, content: renderRecord(conflict, found.body) },
      { directory: "registry", filename: `${safeName(packet.id)}.md`, content: renderRecord(packet) },
    ]);
    await this.enqueueMaintenance({ project_id: found.record.project_id, trigger: "user_resolution_locked", idempotency_key: queueIdempotencyKey, text_context: input.resolution_statement, evidence_refs: [input.conflict_id, resolutionId], locked_user_resolution_ref: resolutionId });
    await this.appendAudit({ type: "user_conflict_resolution_locked", project_id: found.record.project_id, conflict_id: input.conflict_id, resolution_id: resolutionId, change_packet_id: packetId, actor: input.actor_principal });
    const updated = await this.get(input.conflict_id);
    return { conflict_id: input.conflict_id, status: "resolution_pending", resolution_id: resolutionId, change_packet_id: packetId, current_conflict_revision: updated ? digest(renderRecord(updated.record, updated.body)) : currentRevision, actor_principal: input.actor_principal, attestation_mode: "verified_principal" };
  }

  async enqueueLegacyProposal(input: { project_id: string; kind: string; payload: Record<string, unknown>; actor: string }): Promise<Record<string, unknown>> {
    const packetId = newId("change_packet");
    const idempotencyKey = digest(JSON.stringify({ project_id: input.project_id, kind: input.kind, payload: input.payload }));
    const existing = (await this.lookup("maintenance_change_packet", { idempotency_key: idempotencyKey }, 2))[0];
    if (existing) return { status: "queued", change_packet_id: existing.id, migration_required: true, idempotent_replay: true };
    const pointer = await this.revisionStore.pointer();
    await this.upsertRecord({
      id: packetId, type: "maintenance_change_packet", title: `Legacy proposal: ${input.kind}`, status: "queued",
      project_id: input.project_id, created_by: input.actor, trigger: "legacy_proposal", idempotency_key: idempotencyKey,
      proposal_kind: input.kind, proposal_payload: input.payload, base_knowledge_revision: pointer?.knowledge_revision ?? "legacy",
    });
    return { status: "queued", change_packet_id: packetId, current_revision: pointer?.knowledge_revision ?? "legacy", migration_required: true, deprecation: "0.5 canonical maintenance is asynchronous; this legacy call created a proposal only" };
  }

  async refreshMaintenancePacket(packet: ChangePacket): Promise<ChangePacket> {
    const pointer = await this.revisionStore.pointer();
    const items = await this.records();
    const mutableMarker = "\n\n## Mutable document block\ntarget_ref:";
    const markerIndex = packet.text_context.indexOf(mutableMarker);
    const stableContext = (markerIndex >= 0 ? packet.text_context.slice(0, markerIndex) : packet.text_context).trim();
    const routingText = stableContext.toLowerCase();
    const documentParts: string[] = [];
    const headingCandidates: Array<{ score: number; text: string }> = [];
    const documentCandidates = items.filter(item => item.record.id === packet.project_id || packet.candidate_section_refs.includes(item.record.id));
    for (const item of documentCandidates) {
      const lines = item.body.split("\n");
      const headings = lines.map((line, index) => {
        const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        return match ? { index, level: match[1]!.length, title: match[2]! } : null;
      }).filter((value): value is { index: number; level: number; title: string } => value !== null);
      for (let index = 0; index < headings.length; index += 1) {
        const heading = headings[index]!;
        const next = headings.slice(index + 1).find(candidate => candidate.level <= heading.level);
        const content = lines.slice(heading.index + 1, next?.index ?? lines.length).join("\n").trim();
        if (!content || content.length > 2_500) continue;
        const title = heading.title.toLowerCase();
        let score = routingText.includes(title) ? 20 : 0;
        for (let offset = 0; offset + 1 < title.length; offset += 1) if (routingText.includes(title.slice(offset, offset + 2))) score += 2;
        if (score === 0) continue;
        const expectedRevision = item.record.id === packet.project_id
          ? String(item.record.main_revision ?? digest(item.body))
          : String(item.record.revision_hash ?? digest(item.body));
        headingCandidates.push({ score, text: `## Mutable document block\ntarget_ref: ${item.record.id}\nexpected_revision: ${expectedRevision}\nblock_key: heading:${heading.title}\nprevious_block_hash: ${digest(content)}\n\n${content}` });
      }
    }
    let documentChars = 0;
    for (const candidate of headingCandidates.sort((a, b) => b.score - a.score).slice(0, 4)) {
      if (documentChars + candidate.text.length > 3_000) continue;
      documentParts.push(candidate.text);
      documentChars += candidate.text.length;
    }
    const openConflictRefs = items
      .filter(item => item.record.project_id === packet.project_id && (item.record.type === "conflict" || item.record.type === "conflict_record") && (item.record.status === "open" || item.record.status === "resolution_pending"))
      .map(item => item.record.id)
      .slice(0, 30);
    return {
      ...packet,
      base_revisions: {
        knowledge_revision: pointer?.knowledge_revision ?? "legacy",
        topology_revision: pointer?.topology_revision ?? "legacy",
        index_revision: pointer?.index_revision ?? "unbuilt",
      },
      open_conflict_refs: openConflictRefs,
      text_context: [stableContext, ...documentParts].filter(Boolean).join("\n\n").slice(0, 6_000),
    };
  }

  async applyMaintenancePlan(packet: ChangePacket, plan: MaintenancePlan, actor = "maintenance-harness"): Promise<{ knowledge_revision: string; changed_records: string[] }> {
    const pointer = await this.revisionStore.pointer();
    if ((pointer?.knowledge_revision ?? "legacy") !== plan.base_knowledge_revision) throw new Error("Maintenance plan base revision is stale");
    const items = await this.records();
    const working = new Map(items.map(item => [item.record.id, { record: { ...item.record }, body: item.body }]));
    const changed = new Set<string>();
    const requireRecord = (id: string) => { const item = working.get(id); if (!item) throw new Error(`Maintenance target not found: ${id}`); return item; };
    const patchBody = (body: string, blockKey: string, replacement: string): string => {
      if (blockKey === "document") return replacement.trimEnd() + "\n";
      if (blockKey.startsWith("heading:")) {
        const title = blockKey.slice("heading:".length);
        const lines = body.split("\n");
        const headingIndex = lines.findIndex(line => /^(#{1,6})\s+(.+?)\s*$/.exec(line)?.[2] === title);
        if (headingIndex < 0) throw new Error(`Stable heading block not found: ${blockKey}`);
        const level = /^(#{1,6})/.exec(lines[headingIndex]!)![1]!.length;
        let end = lines.length;
        for (let index = headingIndex + 1; index < lines.length; index += 1) {
          const match = /^(#{1,6})\s+/.exec(lines[index]!);
          if (match && match[1]!.length <= level) { end = index; break; }
        }
        return [...lines.slice(0, headingIndex + 1), "", replacement.trim(), "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
      }
      const start = `<!-- kb:block ${blockKey} -->`;
      const end = `<!-- /kb:block ${blockKey} -->`;
      const from = body.indexOf(start); const to = body.indexOf(end);
      if (from < 0 || to < from) throw new Error(`Stable block not found: ${blockKey}`);
      return `${body.slice(0, from + start.length)}\n${replacement.trim()}\n${body.slice(to)}`;
    };
    const blockHash = (body: string, blockKey: string): string => {
      if (blockKey === "document") return digest(body);
      if (blockKey.startsWith("heading:")) {
        const title = blockKey.slice("heading:".length);
        const lines = body.split("\n");
        const headingIndex = lines.findIndex(line => /^(#{1,6})\s+(.+?)\s*$/.exec(line)?.[2] === title);
        if (headingIndex < 0) throw new Error(`Stable heading block not found: ${blockKey}`);
        const level = /^(#{1,6})/.exec(lines[headingIndex]!)![1]!.length;
        let end = lines.length;
        for (let index = headingIndex + 1; index < lines.length; index += 1) {
          const match = /^(#{1,6})\s+/.exec(lines[index]!);
          if (match && match[1]!.length <= level) { end = index; break; }
        }
        return digest(lines.slice(headingIndex + 1, end).join("\n").trim());
      }
      const start = `<!-- kb:block ${blockKey} -->`; const end = `<!-- /kb:block ${blockKey} -->`;
      const from = body.indexOf(start); const to = body.indexOf(end);
      if (from < 0 || to < from) throw new Error(`Stable block not found: ${blockKey}`);
      return digest(body.slice(from + start.length, to).trim());
    };
    for (const operation of plan.operations) {
      if (operation.op === "no_change") continue;
      if (operation.op === "patch_main" || operation.op === "patch_section") {
        const item = requireRecord(operation.patch.target_ref);
        const currentRevision = operation.op === "patch_main" ? String(item.record.main_revision ?? digest(item.body)) : String(item.record.revision_hash ?? digest(item.body));
        if (currentRevision !== operation.patch.expected_revision || blockHash(item.body, operation.patch.block_key) !== operation.patch.previous_block_hash) throw new Error(`Maintenance document revision conflict: ${item.record.id}`);
        item.body = patchBody(item.body, operation.patch.block_key, operation.patch.replacement_markdown);
        const revision = digest(item.body);
        if (operation.op === "patch_main") item.record.main_revision = revision; else item.record.revision_hash = revision;
        item.record.updated_at = now(); item.record.updated_by = actor; item.record.source_refs = uniqueStrings([...asStrings(item.record.source_refs), ...operation.patch.evidence_refs]);
        changed.add(item.record.id);
      } else if (operation.op === "create_section") {
        const id = `section:argon:${digest(packet.project_id).slice(0, 8)}:${operation.proposal.key}`;
        if (working.has(id)) throw new Error(`Maintenance section already exists: ${id}`);
        const timestamp = now();
        working.set(id, { record: { id, type: "knowledge_section", title: operation.proposal.title, status: "active", project_id: packet.project_id, created_at: timestamp, updated_at: timestamp, created_by: actor, confidentiality: "internal", schema_version: 1, key: operation.proposal.key, summary: operation.proposal.summary, parent_ref: packet.project_id, artifact_refs: operation.proposal.evidence_refs.filter(ref => ref.startsWith("artifact:")), source_refs: operation.proposal.evidence_refs, child_section_refs: [], related_refs: [], conflict_refs: [], revision_hash: digest(operation.proposal.markdown.trimEnd() + "\n") }, body: operation.proposal.markdown.trimEnd() + "\n" });
        const project = requireRecord(packet.project_id); project.record.section_refs = uniqueStrings([...asStrings(project.record.section_refs), id]); project.record.updated_at = timestamp;
        changed.add(id); changed.add(project.record.id);
      } else if (operation.op === "update_topology") {
        const item = requireRecord(operation.patch.target_ref); item.record.related_refs = uniqueStrings([...asStrings(item.record.related_refs), ...operation.patch.add_refs]); item.record.updated_at = now(); changed.add(item.record.id);
      } else if (operation.op === "register_conflict") {
        const id = `conflict:argon:${digest(`${packet.packet_id}:${operation.conflict.topic}`).slice(0, 24)}`;
        if (!working.has(id)) {
          const timestamp = now();
          working.set(id, { record: { id, type: "conflict", title: operation.conflict.topic, topic: operation.conflict.topic, status: "open", project_id: packet.project_id, created_at: timestamp, updated_at: timestamp, created_by: actor, confidentiality: "internal", schema_version: 1, claim_variants: operation.conflict.claim_variants, artifact_refs: operation.conflict.evidence_refs.filter(ref => ref.startsWith("artifact:")), evidence_refs: operation.conflict.evidence_refs, severity: "medium", impact: "requires_user_resolution", suggested_user_question: operation.conflict.suggested_user_question, created_revision: plan.base_knowledge_revision, last_seen_revision: plan.base_knowledge_revision }, body: `# ${operation.conflict.topic}\n` });
          const project = requireRecord(packet.project_id); project.record.conflict_refs = uniqueStrings([...asStrings(project.record.conflict_refs), id]); project.record.updated_at = timestamp;
          changed.add(id); changed.add(project.record.id);
        }
      } else if (operation.op === "observe_conflict") {
        const item = requireRecord(operation.observation.conflict_id);
        if (item.record.type !== "conflict" || item.record.status === "resolved") throw new Error("Resolved conflict counterevidence requires a new open conflict");
        const observations = Array.isArray(item.record.evidence_observations) ? item.record.evidence_observations : [];
        item.record.evidence_observations = [...observations, { target_claim_variant_refs: operation.observation.target_claim_variant_refs, evidence_refs: operation.observation.evidence_refs, observed_at: now(), packet_id: packet.packet_id }];
        item.record.last_seen_revision = plan.base_knowledge_revision; item.record.updated_at = now(); changed.add(item.record.id);
      }
    }
    if (plan.typed_resolution) {
      const conflict = requireRecord(plan.typed_resolution.conflict_id);
      if (conflict.record.status !== "resolution_pending" || conflict.record.resolution_ref !== plan.typed_resolution.locked_user_resolution_ref) throw new Error("Conflict is not locked by this resolution");
      conflict.record.status = plan.typed_resolution.outcome === "remain_open" ? "open" : "resolved";
      conflict.record.resolution = { ...plan.typed_resolution, applied_at: now(), packet_id: packet.packet_id };
      conflict.record.updated_at = now(); changed.add(conflict.record.id);
      const resolution = requireRecord(plan.typed_resolution.locked_user_resolution_ref); resolution.record.status = "applied"; resolution.record.updated_at = now(); changed.add(resolution.record.id);
    }
    if (changed.size === 0) return { knowledge_revision: pointer?.knowledge_revision ?? "legacy", changed_records: [] };
    const planRecordId = `maintenance_plan:argon:${digest(packet.packet_id).slice(0, 24)}`;
    const timestamp = now();
    working.set(planRecordId, { record: { id: planRecordId, type: "maintenance_plan", title: `Maintenance plan ${packet.packet_id}`, status: "committed", project_id: packet.project_id, created_at: timestamp, updated_at: timestamp, created_by: actor, confidentiality: "internal", schema_version: 1, packet_id: packet.packet_id, prompt_version: plan.prompt_version, tool_schema_version: plan.tool_schema_version, operations: plan.operations, typed_resolution: plan.typed_resolution }, body: "# Committed maintenance plan\n" });
    changed.add(planRecordId);
    const mutations = [...changed].map(id => { const item = requireRecord(id); return { directory: this.directoryFor(item.record) as CanonicalDirectory, filename: `${safeName(id)}.md`, content: renderRecord(item.record, item.body) }; });
    const published = await this.revisionStore.publish(mutations);
    await this.appendAudit({ type: "maintenance_plan_committed", project_id: packet.project_id, packet_id: packet.packet_id, actor, knowledge_revision: published.knowledge_revision, changed_records: [...changed] });
    return { knowledge_revision: published.knowledge_revision, changed_records: [...changed] };
  }

  async view(projectId: string, kind: ProjectViewKind): Promise<Record<string, unknown>> {
    if (!PROJECT_VIEW_KINDS.includes(kind)) throw new Error(`Unsupported project view: ${kind}`);
    return buildProjectView((await this.records()).map(item => item.record), projectId, kind);
  }

  async lint(projectId?: string): Promise<ValidationIssue[]> {
    const records = (await this.records()).map(item => item.record);
    const scoped = projectId ? records.filter(record => record.project_id === projectId || record.id === projectId) : records;
    return validateProjectRecords(scoped);
  }

  async bootstrapProject(input: { project_id: string; title: string; mission: string; actor: string }): Promise<{ project_id: string; created: boolean; brief_uri: string; main_uri: string }> {
    if (!input.project_id.startsWith("project:")) throw new Error("project_id must use the stable project: prefix");
    const existing = await this.get(input.project_id);
    if (existing) {
      if (existing.record.type !== "project") throw new Error(`ID already belongs to ${existing.record.type}: ${input.project_id}`);
      return { project_id: existing.record.id, created: false, brief_uri: `kb://project/${encodeURIComponent(existing.record.id)}/brief`, main_uri: `kb://project/${encodeURIComponent(existing.record.id)}/main` };
    }
    const mainBody = `# ${input.title}\n\n${input.mission}\n`;
    await this.upsertRecord({
      id: input.project_id, type: "project", title: input.title, status: "active", project_id: input.project_id, created_by: input.actor,
      mission: input.mission, owners: [input.actor], current_phase: "knowledge-system-bootstrap", derivation: "agent", validation_status: "verified",
      main_revision: digest(mainBody), section_refs: [],
    }, mainBody);
    await this.appendAudit({ type: "project_bootstrap", project_id: input.project_id, actor: input.actor });
    return { project_id: input.project_id, created: true, brief_uri: `kb://project/${encodeURIComponent(input.project_id)}/brief`, main_uri: `kb://project/${encodeURIComponent(input.project_id)}/main` };
  }

  private async sourceRoots(): Promise<SourceRoot[]> {
    try {
      return parseSourceRoots(await readFile(join(this.root, "ingestion", "source-roots.yaml"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("No configured source roots. Add ingestion/source-roots.yaml under ARGON_MEMORY_KB_ROOT first.");
      throw error;
    }
  }

  async configureSourceRoot(input: { id: string; project_id: string; relative_path: string; actor: string }): Promise<SourceRoot> {
    if (input.relative_path === "." || input.relative_path === "") throw new Error("A source root must be a dedicated subdirectory, not ARGON_MEMORY_KB_ROOT itself");
    const project = await this.get(input.project_id);
    if (!project || project.record.type !== "project") throw new Error(`Unknown project for source root: ${input.project_id}`);
    const root: SourceRoot = { id: input.id, project_id: input.project_id, relative_path: input.relative_path, enabled: true };
    // sourceFilePath validates both relative-path and project-root containment.
    const directory = dirname(sourceFilePath(this.root, root, ".source-root-marker"));
    await mkdir(directory, { recursive: true });
    let roots: SourceRoot[] = [];
    try { roots = await this.sourceRoots(); } catch (error) { if ((error as Error).message.includes("No configured source roots")) roots = []; else throw error; }
    const next = [...roots.filter(candidate => candidate.id !== root.id), root].sort((a, b) => a.id.localeCompare(b.id));
    await this.writeDerived("ingestion/source-roots.yaml", YAML.stringify({ source_roots: next }));
    await this.appendAudit({ type: "source_root_configured", source_root_id: root.id, project_id: root.project_id, actor: input.actor });
    return root;
  }

  private async sourceRootForArtifact(record: KnowledgeRecord): Promise<SourceRoot> {
    const sourceRootId = record.source_root_id;
    if (typeof sourceRootId !== "string") throw new Error(`Artifact ${record.id} has no source_root_id`);
    const sourceRoot = (await this.sourceRoots()).find(root => root.id === sourceRootId && root.enabled);
    if (!sourceRoot) throw new Error(`Artifact ${record.id} references an unknown or disabled source root`);
    return sourceRoot;
  }

  private async writeDerived(relativePath: string, text: string): Promise<void> {
    const target = join(this.root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, text, "utf8");
    await rename(temp, target);
  }

  private async staleArtifactAndDependents(artifact: KnowledgeRecord, actor: string): Promise<void> {
    const records = (await this.records()).map(item => item.record);
    await this.upsertRecord({ ...artifact, status: "stale", created_by: actor, stale_reason: "source_content_changed", stale_at: now() });
    const evidence = records.filter(record => record.type === "evidence" && record.artifact_id === artifact.id && record.status !== "stale");
    for (const record of evidence) await this.upsertRecord({ ...record, status: "stale", created_by: actor, stale_reason: "artifact_stale", stale_at: now() });
    const staleRefs = new Set([artifact.id, ...evidence.map(record => record.id)]);
    for (const record of records.filter(record => (record.type === "memory" && record.status === "accepted") || (record.type === "claim" && record.status === "supported"))) {
      const refs = [...(Array.isArray(record.source_refs) ? record.source_refs : []), ...(Array.isArray(record.evidence_refs) ? record.evidence_refs : [])];
      if (refs.some(ref => typeof ref === "string" && staleRefs.has(ref))) {
        await this.upsertRecord({ ...record, status: "disputed", created_by: actor, stale_reason: "dependent_evidence_stale", stale_at: now() });
      }
    }
  }

  async inventory(sourceRootId: string): Promise<{ source_root_id: string; project_id: string; files: InventoryEntry[] }> {
    const sourceRoot = (await this.sourceRoots()).find(root => root.id === sourceRootId && root.enabled);
    if (!sourceRoot) throw new Error(`Unknown or disabled source root: ${sourceRootId}`);
    return { source_root_id: sourceRoot.id, project_id: sourceRoot.project_id, files: await inventorySourceRoot(this.root, sourceRoot) };
  }

  async ingestInventory(sourceRootId: string, actor: string): Promise<{ job_id: string; source_root_id: string; registered_artifact_ids: string[]; unchanged_artifact_ids: string[]; stale_artifact_ids: string[] }> {
    const inventory = await this.inventory(sourceRootId);
    const sourceRoot = (await this.sourceRoots()).find(root => root.id === sourceRootId && root.enabled);
    if (!sourceRoot) throw new Error(`Unknown or disabled source root: ${sourceRootId}`);
    const registered: string[] = [];
    const unchanged: string[] = [];
    const stale: string[] = [];
    const jobId = newId("ingestion_job");
    await this.upsertRecord({ id: jobId, type: "ingestion_job", title: `Ingest ${sourceRootId}`, status: "running", project_id: inventory.project_id, created_by: actor, operation: "ingest", request_hash: digest(`${sourceRootId}:${inventory.files.map(file => file.sha256).join(",")}`) });
    const current = (await this.records()).map(item => item.record);
    for (const file of inventory.files) {
      const id = `artifact:argon:${file.sha256.slice(0, 24)}`;
      const existing = await this.get(id);
      if (existing?.record.sha256 === file.sha256 && existing.record.status !== "stale") { unchanged.push(id); continue; }
      for (const prior of current.filter(record => record.type === "artifact" && record.source_root_id === sourceRootId && record.original_relative_path === file.relative_path && record.sha256 !== file.sha256 && record.status !== "stale")) {
        await this.staleArtifactAndDependents(prior, actor);
        stale.push(prior.id);
      }
      let status = "registered";
      let parserStatus = "not_requested";
      let parserFields: Record<string, unknown> = {};
      let body = `# ${file.relative_path}\n\nInventory-only registration. No MinerU parsing has been requested.\n`;
      if (file.mime_type === "text/markdown") {
        const markdown = await readFile(sourceFilePath(this.root, sourceRoot, file.relative_path), "utf8");
        const folder = `normalized/${safeName(id)}`;
        const normalizedPath = `${folder}/document.md`;
        const reportPath = `${folder}/parse-report.json`;
        const normalizedContent = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
        await this.writeDerived(normalizedPath, normalizedContent);
        await this.writeDerived(reportPath, JSON.stringify({ artifact_id: id, input_sha256: file.sha256, parser: "source_markdown", parser_mode: "local", egress: "none", normalized_markdown_path: normalizedPath, completed_at: now() }, null, 2) + "\n");
        const imageAssociations = extractImageAssociations(normalizedContent, id);
        status = "parsed";
        parserStatus = "completed";
        parserFields = { parser_name: "source_markdown", parser_mode: "local", parser_completed_at: now(), normalized_markdown_path: normalizedPath, parse_report_path: reportPath, parsed_page_count: 0, image_associations: imageAssociations };
        body = `# ${file.relative_path}\n\nImported canonical Markdown. Original source is preserved in its configured source root.\n`;
      }
      await this.upsertRecord({
        id, type: "artifact", title: file.relative_path, status, project_id: inventory.project_id, created_by: actor,
        mime_type: file.mime_type, size_bytes: file.size_bytes, sha256: file.sha256, original_relative_path: file.relative_path,
        acquired_at: file.modified_at, source_root_id: sourceRootId, parser_status: parserStatus, source_refs: [], ...parserFields,
      }, body);
      registered.push(id);
    }
    await this.upsertRecord({ id: jobId, type: "ingestion_job", title: `Ingest ${sourceRootId}`, status: "completed", project_id: inventory.project_id, created_by: actor, operation: "ingest", request_hash: digest(`${sourceRootId}:${inventory.files.map(file => file.sha256).join(",")}`), registered_artifact_ids: registered, unchanged_artifact_ids: unchanged, stale_artifact_ids: stale });
    await this.appendAudit({ type: "inventory_ingest", job_id: jobId, source_root_id: sourceRootId, actor, registered_artifact_ids: registered, unchanged_artifact_ids: unchanged, stale_artifact_ids: stale });
    return { job_id: jobId, source_root_id: sourceRootId, registered_artifact_ids: registered, unchanged_artifact_ids: unchanged, stale_artifact_ids: stale };
  }

  async parseArtifactWithMinerU(artifactId: string, actor: string): Promise<{ artifact_id: string; status: "parsed" | "failed"; normalized_markdown_path?: string; page_count?: number; error_code?: string }> {
    const existing = await this.get(artifactId);
    if (!existing || existing.record.type !== "artifact") throw new Error(`Unknown artifact: ${artifactId}`);
    const artifact = existing.record;
    if (typeof artifact.mime_type !== "string" || !MINERU_MIME_TYPES.has(artifact.mime_type)) throw new Error("MinerU API parsing supports registered PDF, image, Office, and spreadsheet artifacts only");
    if (typeof artifact.original_relative_path !== "string") throw new Error(`Artifact ${artifactId} has no original_relative_path`);
    if (artifact.status === "parsed" && typeof artifact.normalized_markdown_path === "string") {
      try {
        await readFile(join(this.root, artifact.normalized_markdown_path), "utf8");
        return { artifact_id: artifact.id, status: "parsed", normalized_markdown_path: artifact.normalized_markdown_path, page_count: Number(artifact.parsed_page_count ?? 0) };
      } catch { /* derived content was deleted; rebuild below */ }
    }
    const sourcePath = artifact.managed_upload === true && typeof artifact.managed_relative_path === "string"
      ? this.managedResourcePath(artifact.managed_relative_path)
      : sourceFilePath(this.root, await this.sourceRootForArtifact(artifact), artifact.original_relative_path);
    const sourceStat = await lstat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`Artifact ${artifactId} source is not a regular file`);

    const { getMinerUCredentials } = await import("./normalization/config.js");
    const credentials = getMinerUCredentials();
    if (!credentials) throw new Error("MinerU normalization requires MINERU_API_KEY or Argon Memory normalization credentials");

    await this.upsertRecord({ ...artifact, status: "parsing", created_by: actor, parser_name: "mineru_cloud", parser_mode: "api", parser_started_at: now() }, existing.body);
    try {
      const { extractPdfMineruCloud } = await import("./normalization/python-utils.js");
      const result = await extractPdfMineruCloud(sourcePath, credentials.api_key);
      const pages = result.pages ?? [];
      const markdown = result.markdown?.trim() || pages.map(page => `## Page ${page.page_idx + 1}\n\n${page.text}`).join("\n\n").trim();
      if (result.error || !markdown) throw new Error(result.error || "MinerU returned no Markdown or page text");

      const folder = `normalized/${safeName(artifact.id)}`;
      const normalizedPath = `${folder}/document.md`;
      const reportPath = `${folder}/parse-report.json`;
      const normalizedMarkdown = markdown + "\n";
      await this.writeDerived(normalizedPath, normalizedMarkdown);
      await this.writeDerived(reportPath, JSON.stringify({
        artifact_id: artifact.id, input_sha256: artifact.sha256, parser: "mineru_cloud", parser_mode: "api", egress: "mineru_api",
        page_count: pages.length, normalized_markdown_path: normalizedPath, completed_at: now(),
      }, null, 2) + "\n");
      const imageAssociations = extractImageAssociations(normalizedMarkdown, artifact.id);
      await this.upsertRecord({
        ...artifact, status: "parsed", created_by: actor, parser_name: "mineru_cloud", parser_mode: "api", parser_completed_at: now(),
        normalized_markdown_path: normalizedPath, parse_report_path: reportPath, parsed_page_count: pages.length,
        image_associations: imageAssociations,
      }, existing.body);
      await this.appendAudit({ type: "mineru_api_parse", artifact_id: artifact.id, actor, egress: "mineru_api", outcome: "parsed", page_count: pages.length });
      return { artifact_id: artifact.id, status: "parsed", normalized_markdown_path: normalizedPath, page_count: pages.length };
    } catch (error) {
      await this.upsertRecord({ ...artifact, status: "failed", created_by: actor, parser_name: "mineru_cloud", parser_mode: "api", parser_failed_at: now(), parser_error_code: "mineru_api_parse_failed" }, existing.body);
      await this.appendAudit({ type: "mineru_api_parse", artifact_id: artifact.id, actor, egress: "mineru_api", outcome: "failed", error_code: "mineru_api_parse_failed" });
      return { artifact_id: artifact.id, status: "failed", error_code: "mineru_api_parse_failed" };
    }
  }

  async retryFailedParses(actor: string, limit = 20): Promise<{ attempted: string[]; parsed: string[]; failed: string[] }> {
    const failedArtifacts = (await this.records()).map(item => item.record)
      .filter(record => record.type === "artifact" && record.status === "failed" && typeof record.mime_type === "string" && MINERU_MIME_TYPES.has(record.mime_type))
      .slice(0, Math.min(limit, 20));
    const result = { attempted: [] as string[], parsed: [] as string[], failed: [] as string[] };
    for (const artifact of failedArtifacts) {
      result.attempted.push(artifact.id);
      const parsed = await this.parseArtifactWithMinerU(artifact.id, actor);
      (parsed.status === "parsed" ? result.parsed : result.failed).push(artifact.id);
    }
    await this.appendAudit({ type: "retry_failed_parses", actor, ...result });
    return result;
  }

  async reconcileMemory(input: { memory_id: string; action: "add_evidence" | "narrow_scope" | "propose_supersession" | "revalidate"; rationale: string; evidence_refs?: string[]; narrowed_scope?: string; proposed_supersedes?: string; actor: string }): Promise<{ memory_id: string; status: ValidationDecision; validation_event_id: string; remediation?: string }> {
    const current = await this.get(input.memory_id);
    if (!current || current.record.type !== "memory") throw new Error(`Unknown memory: ${input.memory_id}`);
    const memory = current.record;
    const next: KnowledgeRecord = { ...memory, created_by: memory.created_by };
    if (input.action === "add_evidence") next.evidence_refs = [...new Set([...(Array.isArray(memory.evidence_refs) ? memory.evidence_refs.filter((ref): ref is string => typeof ref === "string") : []), ...(input.evidence_refs ?? [])])];
    if (input.action === "narrow_scope") {
      if (!input.narrowed_scope) throw new Error("narrow_scope requires narrowed_scope");
      next.scope = input.narrowed_scope;
    }
    if (input.action === "propose_supersession") {
      if (!input.proposed_supersedes) throw new Error("propose_supersession requires proposed_supersedes");
      const target = await this.get(input.proposed_supersedes);
      if (!target || target.record.type !== "memory") throw new Error("proposed_supersedes must reference an existing memory");
      next.supersedes = target.record.id;
      next.status = "candidate";
    }
    await this.upsertRecord({ ...next, reconciliation_action: input.action, reconciliation_rationale: input.rationale, reconciled_at: now() }, current.body);
    const verdict = await this.validateAndStore({ ...next, status: "candidate" }, input.actor);
    await this.appendAudit({ type: "memory_reconcile", memory_id: memory.id, action: input.action, actor: input.actor, validation_event_id: verdict.eventId });
    return { memory_id: memory.id, status: verdict.status, validation_event_id: verdict.eventId, remediation: verdict.remediation };
  }

  async readResource(uriOrId: string, maximumConfidentiality: Confidentiality = "internal"): Promise<{ uri: string; title: string; text: string }> {
    if (uriOrId.startsWith("kb://project/")) {
      const projectParts = uriOrId.split("/");
      const id = decodeURIComponent(projectParts[3] ?? "");
      if (projectParts[4] === "main") {
        const project = await this.get(id);
        if (!project || project.record.type !== "project") throw new Error(`Project main file not found: ${id}`);
        if (!confidentialityAllowed(project.record, maximumConfidentiality)) throw new Error("Resource is outside this profile's confidentiality scope");
        return { uri: uriOrId, title: project.record.title, text: project.body };
      }
      const brief = await this.brief(id, maximumConfidentiality);
      return { uri: uriOrId, title: `Project brief ${id}`, text: YAML.stringify(brief) };
    }
    const parts = uriOrId.startsWith("kb://") ? uriOrId.split("/") : [];
    if (parts.length >= 4 && parts[2] === "artifact") {
      const artifactId = decodeURIComponent(parts[3] ?? "");
      const artifact = await this.get(artifactId);
      if (!artifact || artifact.record.type !== "artifact") throw new Error(`Artifact resource not found: ${uriOrId}`);
      if (!confidentialityAllowed(artifact.record, maximumConfidentiality)) throw new Error("Resource is outside this profile's confidentiality scope");
      if (parts[4] === "document" || parts[4] === "page") {
        const normalized = artifact.record.normalized_markdown_path;
        if (typeof normalized !== "string") throw new Error(`Artifact has no normalized Markdown: ${artifactId}`);
        const fullText = await readFile(join(this.root, normalized), "utf8");
        if (parts[4] !== "page") return { uri: uriOrId, title: artifact.record.title, text: fullText };
        const page = Number(parts[5]);
        if (!Number.isInteger(page) || page < 1) throw new Error("Artifact page must be a positive integer");
        const matches = [...fullText.matchAll(/^## Page (\d+)\s*$/gm)];
        const start = matches.findIndex(match => Number(match[1]) === page);
        if (start < 0) throw new Error(`Page ${page} is not addressable in this normalized artifact`);
        const offset = matches[start]!.index ?? 0;
        const end = matches[start + 1]?.index ?? fullText.length;
        return { uri: uriOrId, title: `${artifact.record.title} — page ${page}`, text: fullText.slice(offset, end).trim() };
      }
      if (parts[4] === "image") {
        const imageIdx = Number(parts[5]);
        const imageAssociations = artifact.record.image_associations as ImageAssociation[] | undefined;
        if (!imageAssociations || imageAssociations.length === 0) throw new Error(`Artifact has no image associations: ${artifactId}`);
        if (!Number.isInteger(imageIdx) || imageIdx < 0 || imageIdx >= imageAssociations.length) throw new Error(`Image index ${imageIdx} is not addressable in this artifact (0–${imageAssociations.length - 1})`);
        const ia = imageAssociations[imageIdx]!;
        return { uri: uriOrId, title: `${artifact.record.title} — image ${imageIdx}`, text: YAML.stringify({ resource_uri: ia.resource_uri, alt_text: ia.alt_text, caption: ia.caption, page: ia.page, slide: ia.slide, section: ia.section }) };
      }
      return { uri: uriOrId, title: artifact.record.title, text: renderRecord(artifact.record, artifact.body) };
    }
    const id = parts.length >= 4 ? decodeURIComponent(parts.slice(3).join("/")) : uriOrId;
    const item = await this.get(id);
    if (!item) throw new Error(`Knowledge resource not found: ${uriOrId}`);
    if (!confidentialityAllowed(item.record, maximumConfidentiality)) throw new Error("Resource is outside this profile's confidentiality scope");
    return { uri: uriOrId.startsWith("kb://") ? uriOrId : `kb://record/${encodeURIComponent(item.record.id)}`, title: item.record.title, text: renderRecord(item.record, item.body) };
  }

  async readRawArtifactResource(uri: string, maximumConfidentiality: Confidentiality = "internal"): Promise<{ uri: string; title: string; mimeType: string; blob: string }> {
    const parts = uri.startsWith("kb://") ? uri.split("/") : [];
    if (parts.length < 5 || parts[2] !== "artifact" || parts[4] !== "raw") throw new Error(`Raw artifact resource not found: ${uri}`);
    const artifactId = decodeURIComponent(parts[3] ?? "");
    const artifact = await this.get(artifactId);
    if (!artifact || artifact.record.type !== "artifact") throw new Error(`Artifact resource not found: ${uri}`);
    if (!confidentialityAllowed(artifact.record, maximumConfidentiality)) throw new Error("Resource is outside this profile's confidentiality scope");
    const managedPath = artifact.record.managed_relative_path;
    if (typeof managedPath !== "string") throw new Error(`Artifact has no managed original file: ${artifactId}`);
    const bytes = await readFile(this.managedResourcePath(managedPath));
    if (artifact.record.sha256 && digestBytes(bytes) !== artifact.record.sha256) throw new Error(`Artifact original file failed integrity verification: ${artifactId}`);
    return {
      uri,
      title: artifact.record.title,
      mimeType: typeof artifact.record.mime_type === "string" ? artifact.record.mime_type : "application/octet-stream",
      blob: bytes.toString("base64"),
    };
  }

  async health(): Promise<Record<string, unknown>> {
    const records = (await this.records()).map(item => item.record);
    return {
      status: "ok", records: records.length, parsed_artifacts: records.filter(record => record.type === "artifact" && record.status === "parsed").length,
      failed_artifacts: records.filter(record => record.type === "artifact" && record.status === "failed").length,
      stale_artifacts: records.filter(record => record.type === "artifact" && record.status === "stale").length,
      maintained_sections: records.filter(record => record.type === "knowledge_section" && record.status === "active").length,
      agent_generated_artifacts: records.filter(record => record.type === "artifact" && record.source_kind === "agent_generated").length,
      context_checkpoints: records.filter(record => record.type === "activity" && record.kind === "context_checkpoint").length,
      quarantined: records.filter(record => record.status === "quarantined").length,
      disputed: records.filter(record => record.status === "disputed").length,
      ingestion_jobs: records.filter(record => record.type === "ingestion_job").length, policy_version: POLICY_VERSION,
    };
  }
}

export function resolveProjectProfile(value: string | undefined): ProjectProfile {
  if (value === "project-read" || value === "project-contribute" || value === "project-resolve" || value === "project-ops" || value === "project-maintain" || value === "project-admin" || value === "upstream-full") return value;
  return "upstream-full";
}

export function resolveProjectRoot(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}
