import { describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { buildEvidenceCorpus, loadEvidenceImage, safeReadImagePath } from "../src/project/retrieval/evidence.js";
import type { KnowledgeRecord } from "../src/project/runtime.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const record = (overrides: Partial<KnowledgeRecord> = {}): KnowledgeRecord => ({ id: "artifact:fixture", type: "artifact", title: "Field survey", project_id: "project:fixture", status: "parsed", created_at: "2026-01-01", updated_at: "2026-01-01", created_by: "fixture", ...overrides });
async function fixture(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "argon-memory-evidence-test-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function file(root: string, path: string, value: Buffer | string): Promise<void> { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); }

describe("source evidence corpus", () => {
  test("indexes an 8 MiB inline image under a bounded heap without shifting evidence or modifying its source", async () => fixture(async root => {
    const payload = "A".repeat(4 * 1024 * 1024);
    const text = `# Source\r\n![scan](data:image/png;base64,${payload}\r\n${payload})\r\n## Final\r\nFINAL_INLINE_EVIDENCE\n`;
    const path = "normalized/inline/document.md";
    await file(root, path, text);
    const items = [{ record: record({ normalized_markdown_path: path }), body: "" }];
    const worker = `
      import { buildEvidenceCorpus } from ${JSON.stringify(new URL("../src/project/retrieval/evidence.ts", import.meta.url).href)};
      const corpus = await buildEvidenceCorpus(${JSON.stringify(root)}, ${JSON.stringify(items)}, "inline-revision");
      const hit = corpus.units.find(unit => unit.kind === "text" && unit.text.includes("FINAL_INLINE_EVIDENCE"));
      console.log(JSON.stringify({
        fact_offset: hit ? hit.locator.start_char + hit.text.indexOf("FINAL_INLINE_EVIDENCE") : null,
        fact_line: hit ? hit.locator.start_line + hit.text.slice(0, hit.text.indexOf("FINAL_INLINE_EVIDENCE")).split("\\n").length - 1 : null,
        payload_exposed: corpus.units.some(unit => unit.text.includes("A".repeat(128)))
      }));
    `;
    const child = spawnSync(process.execPath, ["--max-old-space-size=192", "--import", "tsx", "--input-type=module", "-e", worker], {
      encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_OPTIONS: "" },
    });
    expect(child.status, child.error?.message ?? child.stderr.slice(-2000)).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ fact_offset: text.indexOf("FINAL_INLINE_EVIDENCE"), fact_line: 5, payload_exposed: false });
    expect(sha(await readFile(join(root, path)))).toBe(sha(text));
  }), 40_000);

  test("covers the entire long document including its last fact, with stable source locators", async () => fixture(async root => {
    const text = `# Survey\n## Page 1\n${"墙体采样测量记录。\n".repeat(430)}## Page 2\n### 最后结论\nFINAL_UNIQUE_FACT_仅在文尾\n`;
    await file(root, "normalized/deep/document.md", text);
    const items = [{ record: record({ normalized_markdown_path: "normalized/deep/document.md" }), body: "registration placeholder" }];
    const corpus = await buildEvidenceCorpus(root, items, "revision-1");
    const units = corpus.units.filter(unit => unit.kind === "text");
    expect(units.length).toBeGreaterThan(3);
    expect(units.some(unit => unit.text.includes("FINAL_UNIQUE_FACT_仅在文尾"))).toBe(true);
    const covered = new Uint8Array(text.length);
    for (const unit of units) {
      expect(unit.text).toBe(text.slice(unit.locator.start_char, unit.locator.end_char));
      covered.fill(1, unit.locator.start_char, unit.locator.end_char);
      expect(unit.locator.start_line).toBeGreaterThan(0);
      expect(unit.content_hash).toBe(sha(text));
    }
    expect(covered.every(Boolean)).toBe(true);
    expect(units[0]!.locator.section_path).toEqual(["Survey"]);
    expect(corpus.coverage.text_artifacts).toBe(1);
    const second = await buildEvidenceCorpus(root, items, "revision-2");
    expect(second.units.map(unit => unit.id)).toEqual(corpus.units.map(unit => unit.id));
    expect(second.units[0]!.source_revision).toBe("revision-2");
  }));

  test("unparsed and missing documents expose searchable metadata with explicit coverage", async () => fixture(async root => {
    const corpus = await buildEvidenceCorpus(root, [
      { record: record({ id: "artifact:registered", status: "registered", title: "采访纪要", mime_type: "application/pdf" }), body: "This placeholder must not become the original contents" },
      { record: record({ id: "artifact:missing", normalized_markdown_path: "normalized/missing.md" }), body: "unreliable fallback contents" },
    ], "revision");
    expect(corpus.coverage.unparsed_artifacts).toEqual(["artifact:registered", "artifact:missing"]);
    expect(corpus.coverage.missing_documents).toEqual(["artifact:missing"]);
    expect(corpus.units.every(unit => unit.text.includes("Metadata only"))).toBe(true);
    expect(corpus.units.some(unit => unit.text.includes("unreliable fallback"))).toBe(false);
    expect(corpus.units[0]!.uri).toMatch(/^kb:\/\/record\//);
  }));

  test("indexes multiple deep-path images, numbered names and nearby context, and returns original bytes", async () => fixture(async root => {
    const markdown = "# 堡墙勘察\n## Page 3\n### 裂缝测量\n北墙出现竖向裂缝，以下照片对应两个测点。\n![](images/deeper/0001.png)\n![测点二](<images/deeper/0002.png> \"裂缝宽度\")\n";
    await file(root, "normalized/survey/document.md", markdown);
    await file(root, "normalized/survey/images/deeper/0001.png", PNG);
    await file(root, "normalized/survey/images/deeper/0002.png", PNG);
    const corpus = await buildEvidenceCorpus(root, [{ record: record({ normalized_markdown_path: "normalized/survey/document.md", source_refs: ["work:survey"], confidentiality: "restricted" }), body: "" }], "revision");
    const images = corpus.units.filter(unit => unit.kind === "image");
    expect(images).toHaveLength(2);
    expect(images[0]!.image_uri).toBe("kb://artifact/artifact%3Afixture/image/0");
    expect(images[1]!.image_uri).toBe("kb://artifact/artifact%3Afixture/image/1");
    expect(images[0]!.text).toContain("北墙出现竖向裂缝");
    expect(images[0]!.locator.section_path).toEqual(["堡墙勘察", "Page 3", "裂缝测量"]);
    expect(images[0]!.locator.page).toBe(3);
    expect(images[0]!.confidentiality).toBe("restricted");
    expect(images[0]!.source_refs).toContain("work:survey");
    expect(images[0]!.image_sha256).toBe(sha(PNG));
    const loaded = await loadEvidenceImage(root, images[0]!);
    expect(loaded.mimeType).toBe("image/png");
    expect(Buffer.from(loaded.data, "base64")).toEqual(PNG);
    expect(corpus.coverage.unavailable_images).toEqual([]);
  }));

  test("reads uploaded originals and configured source-root originals even without text or descriptive names", async () => fixture(async root => {
    await file(root, "agent-resources/upload/001.png", PNG);
    await file(root, "sources/site/images/002.png", PNG);
    await file(root, "ingestion/source-roots.yaml", "source_roots:\n  - id: source-fixture\n    project_id: project:fixture\n    relative_path: sources/site\n");
    const corpus = await buildEvidenceCorpus(root, [
      { record: record({ id: "artifact:uploaded", status: "registered", mime_type: "image/png", managed_relative_path: "agent-resources/upload/001.png", original_relative_path: "001.png", sha256: sha(PNG) }), body: "" },
      { record: record({ id: "artifact:source", status: "registered", mime_type: "image/png", source_root_id: "source-fixture", original_relative_path: "images/002.png", sha256: sha(PNG) }), body: "" },
    ], "revision");
    expect(corpus.units.filter(unit => unit.kind === "image")).toHaveLength(2);
    expect(corpus.coverage.image_units).toBe(2);
    expect(corpus.coverage.unparsed_artifacts).toHaveLength(0);
    expect(corpus.coverage.text_unavailable_artifacts).toEqual(["artifact:uploaded", "artifact:source"]);
    expect(corpus.coverage.warnings.filter(value => value.includes("text/OCR content is unavailable"))).toHaveLength(2);
    expect(corpus.coverage.unavailable_images).toEqual([]);
  }));

  test("allows normalized parent segments inside the knowledge root while rejecting unsafe URLs, symlinks and invalid image bytes", async () => fixture(async root => {
    await file(root, "normalized/doc/images/good.png", PNG);
    await file(root, "normalized/doc/images/fake.png", "not an image");
    await file(root, "normalized/doc/images/huge.png", Buffer.alloc(10 * 1024 * 1024 + 1));
    await symlink(join(root, "normalized/doc/images"), join(root, "normalized/doc/linked"));
    const markdown = ["# Source", "![](../doc/images/good.png)", "![](https://example.invalid/private.png)", `![](data:image/png;base64,${PNG.toString("base64")})`, "![](linked/good.png)", "![](images/fake.png)", "![](images/huge.png)", "![](images/good.png)"].join("\n");
    await file(root, "normalized/doc/document.md", markdown);
    const corpus = await buildEvidenceCorpus(root, [{ record: record({ normalized_markdown_path: "normalized/doc/document.md" }), body: "" }], "revision");
    expect(corpus.coverage.unavailable_images).toHaveLength(5);
    expect(corpus.units.filter(unit => unit.kind === "image").map(unit => unit.image_uri)).toEqual(["kb://artifact/artifact%3Afixture/image/0", "kb://artifact/artifact%3Afixture/image/6"]);
    expect(corpus.units.some(unit => unit.text.includes(PNG.toString("base64")))).toBe(false);
    await expect(safeReadImagePath(root, "/etc/passwd")).rejects.toThrow();
    await expect(safeReadImagePath(root, "normalized/doc/../doc/images/good.png")).rejects.toThrow();
  }));

  test.each(["configured", "managed"])("recovers legacy copied Markdown images from the %s original directory without changing source text or image indices", async mode => fixture(async root => {
    const markdown = "# 现场资料\n\n![墙体](images/001.png)\n";
    const originalPath = mode === "configured" ? "sources/site/report.md" : "agent-resources/upload/report.md";
    await file(root, "normalized/legacy/document.md", markdown);
    await file(root, originalPath, markdown);
    await file(root, join(dirname(originalPath), "images/001.png"), PNG);
    await file(root, "ingestion/source-roots.yaml", "source_roots:\n  - id: source-fixture\n    project_id: project:fixture\n    relative_path: sources/site\n");
    const base = record({ normalized_markdown_path: "normalized/legacy/document.md", mime_type: "text/markdown", original_relative_path: "report.md",
      ...(mode === "configured" ? { source_root_id: "source-fixture" } : { managed_upload: true, managed_relative_path: originalPath }) });
    const corpus = await buildEvidenceCorpus(root, [{ record: base, body: "registration metadata" }], "revision");
    const images = corpus.units.filter(unit => unit.kind === "image");
    expect(images).toHaveLength(1);
    expect(images[0]!.image_path).toContain(join(dirname(originalPath), "images/001.png"));
    expect(images[0]!.image_uri).toBe("kb://artifact/artifact%3Afixture/image/0");
    expect(images[0]!.image_sha256).toBe(sha(PNG));
    expect(images[0]!.locator.start_line).toBe(3);
    expect(Buffer.from((await loadEvidenceImage(root, images[0]!)).data, "base64")).toEqual(PNG);
    expect(corpus.units.filter(unit => unit.kind === "text").map(unit => unit.text).join("")).toBe(markdown);
    expect(corpus.coverage.unavailable_images).toEqual([]);
    expect(await readFile(join(root, "normalized/legacy/document.md"), "utf8")).toBe(markdown);
    expect(await readFile(join(root, originalPath), "utf8")).toBe(markdown);
  }));

  test("resolves original Markdown parent-relative images anywhere inside the knowledge root and prefers valid normalized pixels", async () => fixture(async root => {
    const markdown = "# Survey\n![](../images/parent.png)\n![](../../shared/shared.png)\n![](images/primary.png)\n";
    await file(root, "normalized/legacy/document.md", markdown);
    await file(root, "sources/site/notes/report.md", markdown);
    await file(root, "sources/site/images/parent.png", PNG);
    await file(root, "sources/shared/shared.png", PNG);
    const primaryBytes = Buffer.concat([PNG, Buffer.from("PRIMARY_VERSION")]);
    await file(root, "normalized/legacy/images/primary.png", primaryBytes);
    await file(root, "sources/site/notes/images/primary.png", PNG);
    await file(root, "ingestion/source-roots.yaml", "source_roots:\n  - id: source-fixture\n    project_id: project:fixture\n    relative_path: sources/site\n");
    const corpus = await buildEvidenceCorpus(root, [{ record: record({ normalized_markdown_path: "normalized/legacy/document.md", original_relative_path: "notes/report.md", source_root_id: "source-fixture" }), body: "" }], "revision");
    const images = corpus.units.filter(unit => unit.kind === "image");
    expect(images).toHaveLength(3);
    expect(images[0]!.image_path).toContain("sources/site/images/parent.png");
    expect(images[1]!.image_path).toContain("sources/shared/shared.png");
    expect(images[2]!.image_path).toContain("normalized/legacy/images/primary.png");
    expect(images[2]!.image_sha256).toBe(sha(primaryBytes));
    expect(corpus.coverage.unavailable_images).toEqual([]);
  }));

  test("legacy fallback rejects outside-root targets, protocols, symlink images and symlink directories without any fetch", async () => fixture(async root => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const outside = await mkdtemp(join(tmpdir(), "argon-memory-outside-image-"));
    try {
      await file(outside, "outside.png", PNG);
      const escape = relative(join(root, "normalized/doc"), join(outside, "outside.png"));
      const markdown = ["# Safety", `![](${escape})`, `![](${escape.replaceAll("..", "%2e%2e")})`,
        "![](https://example.invalid/private.png)", "![](//example.invalid/private.png)", "![](file:///etc/private.png)",
        `![](data:image/png;base64,${PNG.toString("base64")})`, "![](images/alias.png)", "![](linked/good.png)"].join("\n");
      await file(root, "normalized/doc/document.md", markdown);
      await file(root, "sources/site/report.md", markdown);
      await file(root, "sources/site/images/good.png", PNG);
      await symlink(join(root, "sources/site/images/good.png"), join(root, "sources/site/images/alias.png"));
      await symlink(join(root, "sources/site/images"), join(root, "sources/site/linked"));
      const corpus = await buildEvidenceCorpus(root, [{ record: record({ normalized_markdown_path: "normalized/doc/document.md", original_relative_path: "report.md", managed_relative_path: "sources/site/report.md" }), body: "" }], "revision");
      expect(corpus.units.filter(unit => unit.kind === "image")).toHaveLength(0);
      expect(corpus.coverage.unavailable_images).toHaveLength(8);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); await rm(outside, { recursive: true, force: true }); }
  }));

  test.each(["non-markdown", "missing-original", "original-symlink", "directory-symlink", "disabled-root", "wrong-project"])("does not recover images through an untrusted %s original source", async scenario => fixture(async root => {
    const markdown = "# Source\n![](images/good.png)\n";
    await file(root, "normalized/doc/document.md", markdown);
    await file(root, "sources/site/images/good.png", PNG);
    await file(root, "sources/site/actual.md", markdown);
    let original = "report.md";
    if (scenario === "non-markdown") { original = "report.pdf"; await file(root, "sources/site/report.pdf", markdown); }
    else if (scenario === "original-symlink") await symlink(join(root, "sources/site/actual.md"), join(root, "sources/site/report.md"));
    else if (scenario !== "missing-original") await file(root, "sources/site/report.md", markdown);
    if (scenario === "directory-symlink") await symlink(join(root, "sources/site"), join(root, "sources/linked"));
    await file(root, "ingestion/source-roots.yaml", `source_roots:\n  - id: source-fixture\n    project_id: ${scenario === "wrong-project" ? "project:other" : "project:fixture"}\n    relative_path: ${scenario === "directory-symlink" ? "sources/linked" : "sources/site"}\n    enabled: ${scenario !== "disabled-root"}\n`);
    const corpus = await buildEvidenceCorpus(root, [{ record: record({ normalized_markdown_path: "normalized/doc/document.md", original_relative_path: original, source_root_id: "source-fixture" }), body: "" }], "revision");
    expect(corpus.units.filter(unit => unit.kind === "image")).toHaveLength(0);
    expect(corpus.coverage.unavailable_images).toEqual(["artifact:fixture#image-0"]);
  }));

  test("revalidates image content and symlinks at actual read time", async () => fixture(async root => {
    await file(root, "agent-resources/one.png", PNG);
    const corpus = await buildEvidenceCorpus(root, [{ record: record({ mime_type: "image/png", managed_relative_path: "agent-resources/one.png" }), body: "" }], "revision");
    const unit = corpus.units.find(value => value.kind === "image")!;
    await writeFile(join(root, "agent-resources/one.png"), Buffer.concat([PNG, Buffer.from("changed")]));
    await expect(loadEvidenceImage(root, unit)).rejects.toThrow("changed");
    await rm(join(root, "agent-resources/one.png"));
    await file(root, "agent-resources/another.png", PNG);
    await symlink(join(root, "agent-resources/another.png"), join(root, "agent-resources/one.png"));
    await expect(loadEvidenceImage(root, unit)).rejects.toThrow("symlink");
  }));

  test("does not read an unsafe document path or accept an original image with a mismatched hash", async () => fixture(async root => {
    await file(root, "normalized/actual/document.md", "DO_NOT_READ_THROUGH_SYMLINK");
    await symlink(join(root, "normalized/actual"), join(root, "normalized/alias"));
    await file(root, "agent-resources/one.png", PNG);
    const corpus = await buildEvidenceCorpus(root, [
      { record: record({ id: "artifact:unsafe-doc", normalized_markdown_path: "normalized/alias/document.md" }), body: "" },
      { record: record({ id: "artifact:bad-hash", mime_type: "image/png", managed_relative_path: "agent-resources/one.png", sha256: "0".repeat(64) }), body: "" },
    ], "revision");
    expect(corpus.coverage.missing_documents).toContain("artifact:unsafe-doc");
    expect(corpus.coverage.unavailable_images).toContain("artifact:bad-hash#image-0");
    expect(corpus.units.some(unit => unit.text.includes("DO_NOT_READ_THROUGH_SYMLINK"))).toBe(false);
    expect(corpus.units.some(unit => unit.kind === "image")).toBe(false);
  }));

  test("supports reference and HTML images while keeping non-artifact structured facts searchable", async () => fixture(async root => {
    await file(root, "pictures/numbered.png", PNG);
    const corpus = await buildEvidenceCorpus(root, [{ record: record({ id: "section:fixture", type: "knowledge_section", status: "active", statement: "结构化字段中的独有事实", confidentiality: "secret" }), body: "# 图片索引\n![现场][photo]\n[photo]: pictures/numbered.png\n<img src=\"pictures/numbered.png\" alt=\"另一处墙体\">" }], "revision");
    expect(corpus.units.filter(unit => unit.kind === "image")).toHaveLength(2);
    expect(corpus.units.some(unit => unit.text.includes("结构化字段中的独有事实"))).toBe(true);
    expect(corpus.units.every(unit => unit.confidentiality === "secret")).toBe(true);
  }));

  test("supplements missing image pixels without duplicating the primary text or shifting existing image indices", async () => fixture(async root => {
    await file(root, "normalized/old/document.md", "# Primary text\nORIGINAL_TEXT_EVIDENCE\n![](lost.png)\n![Existing](images/one.png)\n");
    await file(root, "normalized/old/images/one.png", PNG);
    await file(root, "normalized/old/local-v1/document.md", "# Local image source\n## Page 7\nSUPPLEMENT_ONLY_CONTEXT\n![Recovered](images/two.png)\n");
    await file(root, "normalized/old/local-v1/images/two.png", PNG);
    const baseRecord = record({ normalized_markdown_path: "normalized/old/document.md" });
    const before = await buildEvidenceCorpus(root, [{ record: baseRecord, body: "" }], "r1");
    const after = await buildEvidenceCorpus(root, [{ record: { ...baseRecord, image_source_markdown_path: "normalized/old/local-v1/document.md" }, body: "" }], "r2");
    expect(after.units.filter(unit => unit.kind === "text").map(unit => [unit.id, unit.text])).toEqual(before.units.filter(unit => unit.kind === "text").map(unit => [unit.id, unit.text]));
    const images = after.units.filter(unit => unit.kind === "image");
    expect(images).toHaveLength(2);
    expect(images[0]!.id).toBe(before.units.find(unit => unit.kind === "image")!.id);
    expect(images[0]!.image_uri).toBe("kb://artifact/artifact%3Afixture/image/1");
    expect(images[1]!.image_uri).toBe("kb://artifact/artifact%3Afixture/image/2");
    expect(images[1]!.locator.page).toBe(7);
    expect(images[1]!.text).toContain("SUPPLEMENT_ONLY_CONTEXT");
    expect(after.units.filter(unit => unit.kind === "text").some(unit => unit.text.includes("SUPPLEMENT_ONLY_CONTEXT"))).toBe(false);
  }));

  test("reuses unchanged records without rereading documents or image bytes and refreshes changed records", async () => fixture(async root => {
    await file(root, "normalized/doc/document.md", "# Main\nPrimary evidence text\n![image](images/one.png)");
    await file(root, "normalized/doc/images/one.png", PNG);
    const items = [{ record: record({ normalized_markdown_path: "normalized/doc/document.md" }), body: "metadata" }];
    const first = await buildEvidenceCorpus(root, items, "revision-1");
    const imageOpens = vi.mocked(open).mock.calls.length, documentReads = vi.mocked(readFile).mock.calls.length;
    const reordered = [{ record: Object.fromEntries(Object.entries(items[0]!.record).reverse()) as KnowledgeRecord, body: "metadata" }];
    const second = await buildEvidenceCorpus(root, reordered, "revision-2", first);
    expect(vi.mocked(open).mock.calls.length).toBe(imageOpens);
    expect(vi.mocked(readFile).mock.calls.length).toBe(documentReads);
    expect(second.units.map(unit => [unit.id, unit.content_hash, unit.image_sha256])).toEqual(first.units.map(unit => [unit.id, unit.content_hash, unit.image_sha256]));
    expect(second.units.every(unit => unit.source_revision === "revision-2")).toBe(true);
    expect(first.units.every(unit => unit.source_revision === "revision-1")).toBe(true);
    expect(second.coverage).toEqual(first.coverage);
    const changedBytes = Buffer.concat([PNG, Buffer.from("new-source-content")]);
    await file(root, "normalized/doc/images/one.png", changedBytes);
    const third = await buildEvidenceCorpus(root, [{ record: { ...items[0]!.record, updated_at: "2026-10-05" }, body: "metadata" }], "revision-3", second);
    expect(vi.mocked(open).mock.calls.length).toBe(imageOpens + 1);
    expect(vi.mocked(readFile).mock.calls.length).toBe(documentReads + 1);
    expect(third.units.find(unit => unit.kind === "image")!.image_sha256).toBe(sha(changedBytes));
    expect(third.units.find(unit => unit.kind === "image")!.id).not.toBe(first.units.find(unit => unit.kind === "image")!.id);
  }));

  test("keeps missing-image coverage scoped to each reused record and removes deleted records", async () => fixture(async root => {
    await file(root, "normalized/a/document.md", "# A\n![](absent.png)");
    await file(root, "normalized/b/document.md", "# B\n![](absent.png)");
    const a = { record: record({ id: "artifact:a", normalized_markdown_path: "normalized/a/document.md" }), body: "A" };
    const b = { record: record({ id: "artifact:b", normalized_markdown_path: "normalized/b/document.md" }), body: "B" };
    const first = await buildEvidenceCorpus(root, [a, b], "r1");
    expect(first.coverage.unavailable_images).toEqual(["artifact:a#image-0", "artifact:b#image-0"]);
    await file(root, "normalized/b/absent.png", PNG);
    const second = await buildEvidenceCorpus(root, [a, { record: { ...b.record, updated_at: "2026-10-05" }, body: "B" }], "r2", first);
    expect(second.coverage.total_records).toBe(2);
    expect(second.coverage.total_artifacts).toBe(2);
    expect(second.coverage.text_artifacts).toBe(2);
    expect(second.coverage.image_units).toBe(1);
    expect(second.coverage.unavailable_images).toEqual(["artifact:a#image-0"]);
    expect(second.coverage.warnings).toEqual(first.coverage.warnings.filter(value => value.includes("artifact:a")));
    const reads = vi.mocked(readFile).mock.calls.length;
    const third = await buildEvidenceCorpus(root, [a], "r3", second);
    expect(vi.mocked(readFile).mock.calls.length).toBe(reads);
    expect(third.coverage.total_records).toBe(1);
    expect(third.coverage.total_artifacts).toBe(1);
    expect(third.coverage.image_units).toBe(0);
    expect(third.units.every(unit => unit.record_id === "artifact:a")).toBe(true);
  }));

  test("forces fresh reads when previous is omitted or its process-local snapshots are unavailable", async () => fixture(async root => {
    await file(root, "normalized/doc/document.md", "# Main\n![](missing.png)");
    const items = [{ record: record({ normalized_markdown_path: "normalized/doc/document.md" }), body: "" }];
    const first = await buildEvidenceCorpus(root, items, "r1");
    await file(root, "normalized/doc/missing.png", PNG);
    const reused = await buildEvidenceCorpus(root, items, "r2", first);
    expect(reused.coverage.unavailable_images).toEqual(first.coverage.unavailable_images);
    const forced = await buildEvidenceCorpus(root, items, "r3");
    expect(forced.coverage.unavailable_images).toEqual([]);
    expect(forced.coverage.image_units).toBe(1);
    const imageOpens = vi.mocked(open).mock.calls.length;
    const restored = await buildEvidenceCorpus(root, items, "r4", JSON.parse(JSON.stringify(forced)));
    expect(vi.mocked(open).mock.calls.length).toBe(imageOpens + 1);
    expect(restored.coverage).toEqual(forced.coverage);
  }));

  test("does not reuse corpus content across distinct knowledge roots", async () => fixture(async firstRoot => fixture(async secondRoot => {
    await file(firstRoot, "normalized/doc/document.md", "# First root private content");
    await file(secondRoot, "normalized/doc/document.md", "# Second root content");
    const items = [{ record: record({ normalized_markdown_path: "normalized/doc/document.md" }), body: "" }];
    const first = await buildEvidenceCorpus(firstRoot, items, "r1");
    const second = await buildEvidenceCorpus(secondRoot, items, "r2", first);
    expect(second.units[0]!.text).toBe("# Second root content");
    expect(second.units[0]!.id).not.toBe(first.units[0]!.id);
  })));
});
