import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectRuntime } from "../src/project/runtime.js";
import type { RetrievalProvider } from "../src/project/retrieval/types.js";

const mineru = vi.hoisted(() => ({ extract: vi.fn(), credentials: vi.fn(() => ({ api_key: "fixture-mineru-key", api_url: "https://fixture.invalid" })) }));
vi.mock("../src/backends/python-utils.js", () => ({ extractPdfMineruCloud: mineru.extract }));
vi.mock("../src/doc-reading-config.js", () => ({ getMinerUCredentials: mineru.credentials }));

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllGlobals(); mineru.extract.mockReset(); mineru.credentials.mockClear(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "argon-memory-normalize-runtime-"));
  const cloud = vi.fn(async () => { throw new Error("No network is allowed in a local-normalization fixture"); });
  vi.stubGlobal("fetch", cloud);
  const embedded: string[] = [];
  const provider: RetrievalProvider = {
    fingerprint: "normalize-offline-v1", textModel: "synthetic", imageModel: "synthetic-image", dimension: 2,
    async embedText(texts) { embedded.push(...texts); return texts.map(() => [1, 0]); },
    async embedImages(images) { embedded.push(...images); return images.map(() => [0, 1]); },
    async embedImageQuery() { return [0, 1]; },
  };
  const runtime = new ProjectRuntime(root, { retrievalProvider: provider });
  cleanups.push(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.initialize();
  await mkdir(join(root, "agent-resources"), { recursive: true });
  const seed = async (id: string, body: string, extra: Record<string, unknown> = {}) => {
    const filename = `${id.replaceAll(":", "-")}.txt`;
    const source = `agent-resources/${filename}`;
    await writeFile(join(root, source), body);
    await runtime.upsertRecord({ id, type: "artifact", title: filename, status: "registered", project_id: "project:normalization", created_by: "fixture", confidentiality: "internal",
      mime_type: "text/plain", original_relative_path: filename, managed_upload: true, managed_relative_path: source, sha256: digest(body), ...extra });
    return source;
  };
  return { root, runtime, cloud, embedded, seed };
}

describe("ProjectRuntime local normalization integration", () => {
  test("checks registered source hash and writes a separate UTF-8 derivative without changing originals or calling cloud APIs", async () => {
    const f = await fixture();
    const text = "  现场原件：末端备注仍然保留。\r\n# literal $(do-not-execute)\n";
    const source = await f.seed("artifact:plain", text);
    const original = await readFile(join(f.root, source));
    const result = await f.runtime.normalizeArtifactLocal("artifact:plain", "fixture");
    expect(result.parser).toBe("project-inline-utf8-local/v1");
    expect(result.preserved_existing_text).toBe(false);
    expect(result.markdown_path).toBe("normalized/artifact_plain/local-v1/document.md");
    expect(await readFile(join(f.root, String(result.markdown_path)))).toEqual(original);
    expect(await readFile(join(f.root, source))).toEqual(original);
    const record = (await f.runtime.get("artifact:plain"))!.record;
    expect(record).toMatchObject({ status: "parsed", parser_mode: "local", normalized_markdown_path: result.markdown_path, sha256: digest(original),
      local_normalization: { source_sha256: digest(original), parser: "project-inline-utf8-local/v1" } });
    const report = JSON.parse(await readFile(join(f.root, dirname(String(result.markdown_path)), "parse-report.json"), "utf8"));
    expect(report).toMatchObject({ artifact_id: "artifact:plain", source_sha256: digest(original), egress: "none", parser_mode: "local", ocr_performed: false });
    expect(f.cloud).not.toHaveBeenCalled();
    expect(f.embedded).toEqual([]);
  });

  test("rejects a source changed since registration before replacing existing derivatives or canonical records", async () => {
    const f = await fixture();
    const source = await f.seed("artifact:changed", "registered source");
    await mkdir(join(f.root, "normalized", "prior"), { recursive: true });
    await writeFile(join(f.root, "normalized/prior/document.md"), "PREVIOUS_MINERU_BODY");
    const record = (await f.runtime.get("artifact:changed"))!.record;
    await f.runtime.upsertRecord({ ...record, status: "parsed", normalized_markdown_path: "normalized/prior/document.md", parser_name: "mineru", parser_mode: "cloud" });
    const before = await f.runtime.get("artifact:changed");
    await writeFile(join(f.root, source), "changed source bytes");
    await expect(f.runtime.normalizeArtifactLocal("artifact:changed", "fixture")).rejects.toThrow("changed since registration");
    expect(await f.runtime.get("artifact:changed")).toEqual(before);
    expect(await readFile(join(f.root, "normalized/prior/document.md"), "utf8")).toBe("PREVIOUS_MINERU_BODY");
    expect(await readFile(join(f.root, source), "utf8")).toBe("changed source bytes");
    expect(await readdir(join(f.root, "normalized"))).toEqual(["prior"]);
    expect(await f.runtime.maintenanceQueue.lease("fixture-check")).toBeNull();
    expect(f.cloud).not.toHaveBeenCalled();
  });

  test("preserves existing MinerU text and provenance while attaching a separate local image-source Markdown path", async () => {
    const f = await fixture();
    const source = await f.seed("artifact:mineru", "LOCAL_SOURCE_TEXT\n");
    const priorPath = "normalized/mineru/document.md";
    const prior = "# 保留的 MinerU 正文\n\nRICH_MINERU_TEXT，包括此前提取的说明与表格。\n";
    await mkdir(join(f.root, dirname(priorPath)), { recursive: true });
    await writeFile(join(f.root, priorPath), prior);
    const record = (await f.runtime.get("artifact:mineru"))!.record;
    await f.runtime.upsertRecord({ ...record, status: "parsed", normalized_markdown_path: priorPath, parser_name: "mineru-existing", parser_mode: "cloud", parse_report_path: "normalized/mineru/old-report.json", parsed_page_count: 7 });
    const originalHash = digest(await readFile(join(f.root, source)));
    const result = await f.runtime.normalizeArtifactLocal("artifact:mineru", "fixture");
    expect(result.preserved_existing_text).toBe(true);
    const saved = (await f.runtime.get("artifact:mineru"))!.record;
    expect(saved).toMatchObject({ normalized_markdown_path: priorPath, image_source_markdown_path: result.markdown_path,
      parser_name: "mineru-existing", parser_mode: "cloud", parse_report_path: "normalized/mineru/old-report.json", parsed_page_count: 7 });
    expect(await readFile(join(f.root, priorPath), "utf8")).toBe(prior);
    expect(digest(await readFile(join(f.root, source)))).toBe(originalHash);
    expect(await readFile(join(f.root, String(result.markdown_path)), "utf8")).toBe("LOCAL_SOURCE_TEXT\n");
    const corpus = await f.runtime.evidenceCorpus();
    const sourceText = corpus.units.filter(unit => unit.record_id === "artifact:mineru" && unit.kind === "text").map(unit => unit.text).join("\n");
    expect(sourceText).toContain("RICH_MINERU_TEXT");
    expect(sourceText).not.toContain("LOCAL_SOURCE_TEXT");
    expect(f.cloud).not.toHaveBeenCalled();
  });

  test.each(["internal", "secret"] as const)("%s local normalization never places secret source or linked-section bodies in cloud maintenance context", async confidentiality => {
    const f = await fixture();
    const sourceText = confidentiality === "secret" ? "SECRET_SOURCE_PAYLOAD" : "PUBLIC_SOURCE_PAYLOAD";
    const source = await f.seed("artifact:secret", sourceText, { confidentiality });
    await f.runtime.upsertRecord({ id: "section:secret", type: "knowledge_section", title: "artifact:secret", status: "active", project_id: "project:normalization", created_by: "fixture",
      confidentiality: "secret", artifact_refs: ["artifact:secret"] }, "# artifact:secret\n\nSECRET_SECTION_PAYLOAD\n");
    const result = await f.runtime.normalizeArtifactLocal("artifact:secret", "fixture");
    expect(await readFile(join(f.root, source), "utf8")).toBe(sourceText);
    expect(await readFile(join(f.root, String(result.markdown_path)), "utf8")).toBe(sourceText);
    expect((await f.runtime.get("artifact:secret"))!.record.confidentiality).toBe(confidentiality);
    await f.runtime.rebuildRetrieval(true);
    expect(f.embedded.join("\n")).not.toMatch(/SECRET_SOURCE_PAYLOAD|SECRET_SECTION_PAYLOAD/);
    const queued = await f.runtime.maintenanceQueue.lease("fixture-check");
    expect(JSON.stringify(queued?.packet ?? {})).not.toMatch(/SECRET_SOURCE_PAYLOAD|SECRET_SECTION_PAYLOAD/);
    expect(f.cloud).not.toHaveBeenCalled();
  });
});

describe("ProjectRuntime forced MinerU parsing preserves existing evidence", () => {
  async function parsedFixture(extra: Record<string, unknown> = {}) {
    const f = await fixture();
    const artifactId = "artifact:ocr";
    const source = await f.seed(artifactId, "%PDF-1.4\nSYNTHETIC_SOURCE_BYTES\n%%EOF", { mime_type: "application/pdf", original_relative_path: "source.pdf" });
    const priorPath = "normalized/artifact_ocr/local-v1/document.md";
    const priorReport = "normalized/artifact_ocr/local-v1/parse-report.json";
    const priorText = "# 本地扫描件提取\n\n![保留的图片](images/page-1.png)\n";
    await mkdir(join(f.root, dirname(priorPath)), { recursive: true });
    await writeFile(join(f.root, priorPath), priorText);
    await writeFile(join(f.root, priorReport), "{\"local_evidence\":true}\n");
    const record = (await f.runtime.get(artifactId))!.record;
    await f.runtime.upsertRecord({ ...record, status: "parsed", normalized_markdown_path: priorPath, parse_report_path: priorReport,
      parser_name: "project-pdf-local/v1", parser_mode: "local", parser_status: "completed", parsed_page_count: 2,
      local_normalization: { markdown_path: priorPath, source_sha256: record.sha256, warnings: ["fewer than 30 text characters"] }, ...extra }, "# 原始 artifact 说明\n\nCANONICAL_BODY_MUST_SURVIVE\n");
    return { ...f, artifactId, source, priorPath, priorReport, priorText };
  }

  test("default mode skips existing parsed Markdown without obtaining credentials or running the extractor", async () => {
    const f = await parsedFixture();
    const before = await f.runtime.get(f.artifactId);
    const result = await f.runtime.parseArtifactWithMinerU(f.artifactId, "fixture");
    expect(result).toEqual({ artifact_id: f.artifactId, status: "parsed", normalized_markdown_path: f.priorPath, page_count: 2 });
    expect(await f.runtime.get(f.artifactId)).toEqual(before);
    expect(mineru.credentials).not.toHaveBeenCalled();
    expect(mineru.extract).not.toHaveBeenCalled();
    expect(f.cloud).not.toHaveBeenCalled();
    expect(await f.runtime.maintenanceQueue.lease("fixture-check")).toBeNull();
  });

  test("force saves cloud OCR separately, retains local image evidence and originals, and can disable maintenance scheduling", async () => {
    const f = await parsedFixture();
    const original = await readFile(join(f.root, f.source));
    const before = (await f.runtime.get(f.artifactId))!;
    mineru.extract.mockResolvedValue({ markdown: "# 补充识别正文\n\nSCANNED_TEXT_RECOVERED", pages: [{ page_idx: 0, text: "SCANNED_TEXT_RECOVERED" }] });
    const result = await f.runtime.parseArtifactWithMinerU(f.artifactId, "fixture", { force: true, queueMaintenance: false });
    expect(result.status).toBe("parsed");
    expect(result.normalized_markdown_path).not.toBe(f.priorPath);
    expect(result.normalized_markdown_path).toMatch(/^normalized\/artifact_ocr\/mineru-v1\//);
    const saved = (await f.runtime.get(f.artifactId))!;
    expect(saved.record).toMatchObject({ status: "parsed", parser_name: "mineru_cloud", parser_mode: "api", normalized_markdown_path: result.normalized_markdown_path,
      image_source_markdown_path: f.priorPath, parsed_page_count: 1, local_normalization: before.record.local_normalization });
    expect(saved.body).toBe(before.body);
    expect(await readFile(join(f.root, f.priorPath), "utf8")).toBe(f.priorText);
    expect(await readFile(join(f.root, f.priorReport), "utf8")).toBe("{\"local_evidence\":true}\n");
    expect(await readFile(join(f.root, f.source))).toEqual(original);
    expect(await readFile(join(f.root, String(result.normalized_markdown_path)), "utf8")).toBe("# 补充识别正文\n\nSCANNED_TEXT_RECOVERED\n");
    const report = JSON.parse(await readFile(join(f.root, String(saved.record.parse_report_path)), "utf8"));
    expect(report).toMatchObject({ input_sha256: digest(original), egress: "mineru_api", page_count: 1 });
    expect(mineru.extract).toHaveBeenCalledOnce();
    expect(mineru.extract).toHaveBeenCalledWith(join(f.root, f.source), "fixture-mineru-key", expect.stringContaining("normalized/.mineru-stage-"));
    expect(await f.runtime.maintenanceQueue.lease("fixture-check")).toBeNull();
    expect(f.cloud).not.toHaveBeenCalled();
    expect(f.embedded).toEqual([]);
  });

  test("force preserves an explicitly registered image-source path when no local normalization report exists", async () => {
    const f = await parsedFixture({ local_normalization: undefined, image_source_markdown_path: "normalized/images-only/document.md" });
    mineru.extract.mockResolvedValue({ markdown: "OCR replacement", pages: [] });
    expect((await f.runtime.parseArtifactWithMinerU(f.artifactId, "fixture", { force: true, queueMaintenance: false })).status).toBe("parsed");
    expect((await f.runtime.get(f.artifactId))!.record.image_source_markdown_path).toBe("normalized/images-only/document.md");
    expect(await readFile(join(f.root, f.priorPath), "utf8")).toBe(f.priorText);
    expect(f.cloud).not.toHaveBeenCalled();
  });

  test("commits MinerU image pixels and task provenance beside Markdown, then retrieves their immutable evidence URI", async () => {
    const f = await parsedFixture();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0uoAAAAASUVORK5CYII=", "base64");
    const asset = { path: `images/${digest(png)}.png`, sha256: digest(png), size_bytes: png.length, mime_type: "image/png" };
    let staging = "";
    mineru.extract.mockImplementationOnce(async (_path: string, _key: string, output: string) => {
      staging = output;
      await mkdir(join(output, "images"), { recursive: true });
      await writeFile(join(output, asset.path), png);
      return { markdown: `# 实践照片\n\n![现场](${asset.path})`, pages: [], assets: [asset], mineru_batch_id: "fixture-batch", mineru_task_id: "fixture-task", asset_warnings: [] };
    });
    const result = await f.runtime.parseArtifactWithMinerU(f.artifactId, "fixture", { force: true, queueMaintenance: false });
    expect(result.status).toBe("parsed");
    const finalDir = dirname(join(f.root, result.normalized_markdown_path!));
    expect(await readFile(join(finalDir, asset.path))).toEqual(png);
    expect(JSON.parse(await readFile(join(finalDir, "parse-report.json"), "utf8"))).toMatchObject({ assets: [asset], mineru_batch_id: "fixture-batch", mineru_task_id: "fixture-task" });
    await expect(readdir(staging)).rejects.toMatchObject({ code: "ENOENT" });
    const image = (await f.runtime.evidenceCorpus()).units.find(unit => unit.image_sha256 === digest(png))!;
    expect(Buffer.from((await f.runtime.readEvidenceImage(`kb://evidence/${encodeURIComponent(image.id)}`)).data, "base64")).toEqual(png);
    expect(await readFile(join(f.root, f.priorPath), "utf8")).toBe(f.priorText);
  });

  test("rejects an unsafe cloud asset manifest and removes staging without changing previous evidence", async () => {
    const f = await parsedFixture();
    let staging = "";
    mineru.extract.mockImplementationOnce(async (_path: string, _key: string, output: string) => {
      staging = output;
      await mkdir(output, { recursive: true });
      await writeFile(join(output, "partial"), "partial bytes");
      return { markdown: "UNTRUSTED_ASSET", assets: [{ path: "../escape.png", sha256: "a".repeat(64), size_bytes: 1, mime_type: "image/png" }] };
    });
    expect((await f.runtime.parseArtifactWithMinerU(f.artifactId, "fixture", { force: true, queueMaintenance: false })).status).toBe("failed");
    expect((await f.runtime.get(f.artifactId))!.record.normalized_markdown_path).toBe(f.priorPath);
    expect(await readFile(join(f.root, f.priorPath), "utf8")).toBe(f.priorText);
    await expect(readdir(staging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps only opaque MinerU recovery IDs after a failed download while preserving old parsed evidence", async () => {
    const f = await parsedFixture();
    mineru.extract.mockImplementationOnce(async (_path: string, _key: string, output: string) => {
      await writeFile(join(output, "mineru-request.json"), JSON.stringify({ mineru_batch_id: "batch-fixture", mineru_task_id: "task-fixture", zip_url: "https://fixture.invalid/result?secret=PRIVATE_SIGNED_VALUE", api_key: "PRIVATE_KEY_VALUE" }));
      throw new Error("simulated result download failure");
    });
    expect((await f.runtime.parseArtifactWithMinerU(f.artifactId, "fixture", { force: true, queueMaintenance: false })).status).toBe("failed");
    const reportDir = join(f.root, "normalized/artifact_ocr/mineru-failed");
    const files = await readdir(reportDir);
    expect(files).toHaveLength(1);
    const report = await readFile(join(reportDir, files[0]!), "utf8");
    expect(JSON.parse(report)).toMatchObject({ mineru_batch_id: "batch-fixture", mineru_task_id: "task-fixture", artifact_id: f.artifactId });
    expect(report).not.toContain("PRIVATE");
    expect((await f.runtime.get(f.artifactId))!.record.normalized_markdown_path).toBe(f.priorPath);
  });

  test("repeated force writes immutable result directories and a later extractor failure keeps the last successful result", async () => {
    const f = await parsedFixture();
    mineru.extract.mockResolvedValueOnce({ markdown: "FIRST_OCR_EVIDENCE", pages: [] });
    const first = await f.runtime.parseArtifactWithMinerU(f.artifactId, "fixture", { force: true, queueMaintenance: false });
    const firstReport = String((await f.runtime.get(f.artifactId))!.record.parse_report_path);
    const firstReportBytes = await readFile(join(f.root, firstReport));
    mineru.extract.mockResolvedValueOnce({ markdown: "SECOND_OCR_EVIDENCE", pages: [] });
    const second = await f.runtime.parseArtifactWithMinerU(f.artifactId, "fixture", { force: true, queueMaintenance: false });
    expect(first.status).toBe("parsed");
    expect(second.status).toBe("parsed");
    expect(second.normalized_markdown_path).not.toBe(first.normalized_markdown_path);
    expect(await readFile(join(f.root, String(first.normalized_markdown_path)), "utf8")).toBe("FIRST_OCR_EVIDENCE\n");
    expect(await readFile(join(f.root, firstReport))).toEqual(firstReportBytes);
    expect(await readFile(join(f.root, String(second.normalized_markdown_path)), "utf8")).toBe("SECOND_OCR_EVIDENCE\n");
    mineru.extract.mockRejectedValueOnce(new Error("simulated extraction failure"));
    expect((await f.runtime.parseArtifactWithMinerU(f.artifactId, "fixture", { force: true, queueMaintenance: false })).status).toBe("failed");
    expect((await f.runtime.get(f.artifactId))!.record).toMatchObject({ status: "parsed", normalized_markdown_path: second.normalized_markdown_path, image_source_markdown_path: f.priorPath });
    expect(await readFile(join(f.root, String(second.normalized_markdown_path)), "utf8")).toBe("SECOND_OCR_EVIDENCE\n");
    expect(await readFile(join(f.root, f.priorPath), "utf8")).toBe(f.priorText);
    expect(await f.runtime.maintenanceQueue.lease("fixture-check")).toBeNull();
    expect(f.cloud).not.toHaveBeenCalled();
  });

  test("cloud parsing rejects source drift before obtaining credentials or invoking an extractor", async () => {
    const f = await parsedFixture();
    const before = await f.runtime.get(f.artifactId);
    await writeFile(join(f.root, f.source), "%PDF-1.4\nCHANGED_AFTER_REGISTRATION\n%%EOF");
    await expect(f.runtime.parseArtifactWithMinerU(f.artifactId, "fixture", { force: true, queueMaintenance: false })).rejects.toThrow("changed since registration");
    expect(await f.runtime.get(f.artifactId)).toEqual(before);
    expect(await readFile(join(f.root, f.priorPath), "utf8")).toBe(f.priorText);
    expect(mineru.credentials).not.toHaveBeenCalled();
    expect(mineru.extract).not.toHaveBeenCalled();
    expect(f.cloud).not.toHaveBeenCalled();
  });

  test("a source changed during extraction prevents publication and preserves the previous parsed evidence", async () => {
    const f = await parsedFixture();
    mineru.extract.mockImplementationOnce(async (path: string) => {
      await writeFile(path, "%PDF-1.4\nCHANGED_WHILE_EXTRACTING\n%%EOF");
      return { markdown: "UNTRUSTWORTHY_NEW_TEXT", pages: [] };
    });
    expect((await f.runtime.parseArtifactWithMinerU(f.artifactId, "fixture", { force: true, queueMaintenance: false })).status).toBe("failed");
    const saved = (await f.runtime.get(f.artifactId))!;
    expect(saved.record).toMatchObject({ status: "parsed", normalized_markdown_path: f.priorPath, parser_name: "project-pdf-local/v1", parser_mode: "local" });
    expect(await readFile(join(f.root, f.priorPath), "utf8")).toBe(f.priorText);
    expect(await readdir(join(f.root, "normalized/artifact_ocr"))).toEqual(["local-v1"]);
    expect(await f.runtime.maintenanceQueue.lease("fixture-check")).toBeNull();
    expect(f.cloud).not.toHaveBeenCalled();
  });

  test.each(["error-result", "throw", "empty-result"])("failed force (%s) restores old parsed evidence and provenance instead of leaving metadata-only content", async failure => {
    const f = await parsedFixture({ image_source_markdown_path: "normalized/existing-images/document.md" });
    const before = (await f.runtime.get(f.artifactId))!;
    if (failure === "throw") mineru.extract.mockRejectedValue(new Error("PRIVATE_UPSTREAM_ERROR fixture-mineru-key"));
    else mineru.extract.mockResolvedValue(failure === "error-result" ? { error: "PRIVATE_UPSTREAM_ERROR fixture-mineru-key", pages: [] } : { markdown: "   ", pages: [] });
    const result = await f.runtime.parseArtifactWithMinerU(f.artifactId, "fixture", { force: true, queueMaintenance: false });
    expect(result).toEqual({ artifact_id: f.artifactId, status: "failed", error_code: "mineru_api_parse_failed" });
    const after = (await f.runtime.get(f.artifactId))!;
    expect(after.record).toMatchObject({ status: "parsed", normalized_markdown_path: before.record.normalized_markdown_path, parse_report_path: before.record.parse_report_path,
      parser_name: before.record.parser_name, parser_mode: before.record.parser_mode, parsed_page_count: before.record.parsed_page_count,
      local_normalization: before.record.local_normalization, image_source_markdown_path: before.record.image_source_markdown_path, parser_error_code: "mineru_api_parse_failed" });
    expect(after.body).toBe(before.body);
    expect(JSON.stringify(after)).not.toContain("PRIVATE_UPSTREAM_ERROR");
    expect(JSON.stringify(after)).not.toContain("fixture-mineru-key");
    expect(await readFile(join(f.root, f.priorPath), "utf8")).toBe(f.priorText);
    const corpus = await f.runtime.evidenceCorpus();
    const units = corpus.units.filter(unit => unit.record_id === f.artifactId && unit.kind === "text");
    expect(units.map(unit => unit.text).join("\n")).toContain("本地扫描件提取");
    expect(await f.runtime.maintenanceQueue.lease("fixture-check")).toBeNull();
    expect(f.cloud).not.toHaveBeenCalled();
  });
});
