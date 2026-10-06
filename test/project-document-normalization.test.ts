import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProjectDocument } from "../src/project/retrieval/normalize.js";
import { buildEvidenceCorpus, loadEvidenceImage } from "../src/project/retrieval/evidence.js";
import type { KnowledgeRecord } from "../src/project/runtime.js";

const PYTHON = process.env.ARGON_MEMORY_PYTHON_BIN || "python3";
const HAS_FITZ = spawnSync(PYTHON, ["-c", "import fitz"], { stdio: "ignore" }).status === 0;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const rels = (body: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
const relation = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`;
const doc = (body: string) => `<w:document xmlns:w="${W}" xmlns:a="${A}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`;
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

async function fixture(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "argon-memory-normalize-test-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function zip(root: string, name: string, files: Record<string, Buffer | string>): Promise<string> {
  const path = join(root, "originals", name);
  await mkdir(dirname(path), { recursive: true });
  execFileSync(PYTHON, ["-c", "import sys,json,zipfile,base64\nitems=json.load(sys.stdin)\nwith zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:\n for name,content in items.items(): z.writestr(name,base64.b64decode(content))", path], { input: JSON.stringify(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, Buffer.from(value).toString("base64")]))), maxBuffer: 1024 * 1024 });
  return path;
}

describe("local project document normalization", () => {
  test("recovers a small strict UTF-8 body mislabeled as DOCX with an explicit MIME warning", async () => fixture(async root => {
    const path = join(root, "writing-guide.docx");
    const contents = Buffer.from("# 文书写作规范\n\n保留事实来源，不把登记记录当作原文证据。\t尾部事实。\r\n", "utf8");
    await writeFile(path, contents);
    const result = await normalizeProjectDocument(root, path, "artifact:mislabeled-docx", DOCX);
    expect(result.parser).toBe("project-mislabeled-utf8-local/v1");
    expect(result.warnings.some(value => value.includes("Office MIME does not match") && value.includes("no Office-format parsing"))).toBe(true);
    expect(await readFile(join(root, result.markdown_path))).toEqual(contents);
    expect(await readFile(path)).toEqual(contents);
    const report = JSON.parse(await readFile(join(root, dirname(result.markdown_path), "parse-report.json"), "utf8"));
    expect(report.mime_mismatch).toBe(true);
    expect(report.source_sha256).toBe(sha(contents));
  }));

  test.each([
    ["C0 control", Buffer.from("plausible text\x00binary")],
    ["C1 control", Buffer.from("plausible text\u0085binary", "utf8")],
    ["invalid UTF8", Buffer.from([0xff, 0xfe, 0x41])],
    ["truncated ZIP", Buffer.from("PK\x03\x04truncated archive", "utf8")],
    ["too large", Buffer.from("a".repeat(1024 * 1024 + 1))],
  ])("does not apply the mislabeled-text fallback to %s", async (_name, contents) => fixture(async root => {
    const path = join(root, "invalid.docx");
    await writeFile(path, contents);
    await expect(normalizeProjectDocument(root, path, "artifact:invalid-docx", DOCX)).rejects.toThrow("non-ZIP Office input");
    expect(await readdir(join(root, "normalized/artifact_invalid-docx"))).toEqual([]);
  }));

  test("ignores a video member larger than the entire decompression budget while preserving PPT text and images", async () => fixture(async root => {
    const source = await zip(root, "large-video.pptx", {
      "ppt/presentation.xml": `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": rels(relation("rId1", "slide", "slides/slide1.xml")),
      "ppt/slides/slide1.xml": `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>VIDEO_CONTAINER_TEXT_REMAINS_SEARCHABLE</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`,
      "ppt/slides/_rels/slide1.xml.rels": rels(relation("rIdImage", "image", "../media/poster.png") + relation("rIdVideo", "video", "../media/large-video.mp4")),
      "ppt/media/poster.png": PNG,
    });
    execFileSync(PYTHON, ["-c", "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], 'a', zipfile.ZIP_DEFLATED) as z:\n with z.open('ppt/media/large-video.mp4', 'w') as stream:\n  for _ in range(260): stream.write(bytes(1024*1024))", source]);
    const before = sha(await readFile(source));
    const result = await normalizeProjectDocument(root, source, "artifact:large-video", PPTX);
    const text = await readFile(join(root, result.markdown_path), "utf8");
    const report = JSON.parse(await readFile(join(root, dirname(result.markdown_path), "parse-report.json"), "utf8"));
    expect(text).toContain("VIDEO_CONTAINER_TEXT_REMAINS_SEARCHABLE");
    expect(text).toContain(`images/${sha(PNG)}.png`);
    expect(report.zip_skipped_media).toBe(1);
    expect(report.zip_read_bytes).toBeLessThan(1024 * 1024);
    expect(result.warnings.some(value => value.includes("skipped without decompression") && value.includes("video/audio content was not indexed"))).toBe(true);
    expect(sha(await readFile(source))).toBe(before);
  }));

  test("enforces the cumulative decompression budget on parts that are actually read", async () => fixture(async root => {
    const source = await zip(root, "budget.docx", { "one.xml": "1".repeat(24), "two.xml": "2".repeat(24) });
    const extractor = fileURLToPath(new URL("../src/backends/python/extract_project_document.py", import.meta.url));
    const result = execFileSync(PYTHON, ["-c", "import importlib.util,json,pathlib,sys,tempfile\nspec=importlib.util.spec_from_file_location('extractor',sys.argv[1])\nmodule=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\nmodule.MAX_TOTAL=40\nwith tempfile.TemporaryDirectory() as temp:\n package=module.Package(pathlib.Path(sys.argv[2]),module.Writer(pathlib.Path(temp)))\n try:\n  assert len(package.read('one.xml',32))==24\n  try: package.read('two.xml',32)\n  except ValueError as error: print(json.dumps({'error':str(error),'read_bytes':package.read_bytes}))\n  else: raise AssertionError('cumulative budget was not enforced')\n finally: package.zip.close()", extractor, source], { encoding: "utf8" });
    const report = JSON.parse(result);
    expect(report.error).toContain("cumulative OOXML decompression");
    expect(report.read_bytes).toBe(24);
  }));

  test.each(["text/plain", "text/markdown", "application/json", "application/yaml", "text/yaml", "text/csv"])("preserves strict UTF-8 body bytes for %s without executing content", async mime => fixture(async root => {
    const path = join(root, "report.txt");
    const contents = Buffer.from("  {\"记录\": \"只保留正文\"}\r\n\n# literal $(echo do-not-execute)", "utf8");
    await writeFile(path, contents);
    const result = await normalizeProjectDocument(root, path, "artifact:utf8", mime);
    expect(result.parser).toBe("project-inline-utf8-local/v1");
    expect(await readFile(join(root, result.markdown_path))).toEqual(contents);
    expect(await readFile(path)).toEqual(contents);
  }));

  test("rejects invalid UTF-8 text without replacing a prior derivative", async () => fixture(async root => {
    const path = join(root, "report.txt");
    await writeFile(path, "original valid text");
    const result = await normalizeProjectDocument(root, path, "artifact:utf8", "text/plain");
    await writeFile(path, Buffer.from([0xff, 0xfe, 0x00]));
    await expect(normalizeProjectDocument(root, path, "artifact:utf8", "text/plain")).rejects.toThrow("UnicodeDecodeError");
    expect(await readFile(join(root, result.markdown_path), "utf8")).toBe("original valid text");
  }));

  test("keeps DOCX tail text, heading/table/image context and original bytes while preserving old MinerU output", async () => fixture(async root => {
    const source = await zip(root, "survey.docx", {
      "word/document.xml": doc(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>墙体勘察</w:t></w:r></w:p>${paragraph("北墙裂缝照片与测量记录")}${paragraph("中间记录".repeat(1500))}<w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p><w:tbl><w:tr><w:tc>${paragraph("测点")}</w:tc><w:tc>${paragraph("宽度")}</w:tc></w:tr><w:tr><w:tc>${paragraph("北墙")}</w:tc><w:tc>${paragraph("3毫米")}</w:tc></w:tr></w:tbl>${paragraph("FINAL_TAIL_FACT_调查记录末尾")}`),
      "word/_rels/document.xml.rels": rels(relation("rId1", "image", "media/image1.png")),
      "word/media/image1.png": PNG,
      "word/footer1.xml": `<w:ftr xmlns:w="${W}">${paragraph("页脚补充信息")}</w:ftr>`,
    });
    const before = sha(await readFile(source));
    await mkdir(join(root, "normalized/artifact_fixture"), { recursive: true });
    await writeFile(join(root, "normalized/artifact_fixture/document.md"), "EXISTING_MINERU_BODY");
    const result = await normalizeProjectDocument(root, source, "artifact:fixture", DOCX);
    expect(result.markdown_path).toBe("normalized/artifact_fixture/local-v1/document.md");
    const markdown = await readFile(join(root, result.markdown_path), "utf8");
    expect(markdown).toContain("# 墙体勘察");
    expect(markdown).toContain("FINAL_TAIL_FACT_调查记录末尾");
    expect(markdown).toContain("| 北墙 | 3毫米 |");
    expect(markdown).toContain("页脚补充信息");
    expect(markdown).toContain(`images/${sha(PNG)}.png`);
    expect(sha(await readFile(source))).toBe(before);
    expect(await readFile(join(root, "normalized/artifact_fixture/document.md"), "utf8")).toBe("EXISTING_MINERU_BODY");
    const record: KnowledgeRecord = { id: "artifact:fixture", type: "artifact", title: "Survey", status: "parsed", project_id: "project:fixture", created_by: "test", created_at: "2026-01-01", updated_at: "2026-01-01", normalized_markdown_path: result.markdown_path };
    const corpus = await buildEvidenceCorpus(root, [{ record, body: "" }], "revision");
    const image = corpus.units.find(unit => unit.kind === "image")!;
    expect(image.image_sha256).toBe(sha(PNG));
    expect(Buffer.from((await loadEvidenceImage(root, image)).data, "base64")).toEqual(PNG);
    expect(corpus.units.some(unit => unit.text.includes("FINAL_TAIL_FACT_调查记录末尾"))).toBe(true);
    const report = JSON.parse(await readFile(join(root, "normalized/artifact_fixture/local-v1/parse-report.json"), "utf8"));
    expect(report.source_sha256).toBe(before);
    expect(report.egress).toBe("none");
    expect(report.ocr_performed).toBe(false);
    const rerun = await normalizeProjectDocument(root, source, "artifact:fixture", DOCX);
    expect(rerun.markdown_path).toBe(result.markdown_path);
    expect((await readdir(join(root, "normalized/artifact_fixture"))).sort()).toEqual(["document.md", "local-v1"]);
  }));

  test("preserves PPTX slide order, text, notes and image pixels", async () => fixture(async root => {
    const source = await zip(root, "slides.pptx", {
      "ppt/presentation.xml": `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": rels(relation("rId1", "slide", "slides/slide1.xml")),
      "ppt/slides/slide1.xml": `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>现场测绘成果</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr name="Photo" descr="墙体照片"/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`,
      "ppt/slides/_rels/slide1.xml.rels": rels(relation("rIdImage", "image", "../media/image1.png") + relation("rIdNotes", "notesSlide", "../notesSlides/notesSlide1.xml")),
      "ppt/notesSlides/notesSlide1.xml": `<p:notes xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>演讲备注中的独有内容</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
      "ppt/media/image1.png": PNG,
    });
    const result = await normalizeProjectDocument(root, source, "artifact:slides", PPTX);
    const markdown = await readFile(join(root, result.markdown_path), "utf8");
    expect(result.page_count).toBe(1);
    expect(markdown).toContain("## Slide 1");
    expect(markdown).toContain("### 现场测绘成果");
    expect(markdown).toContain("演讲备注中的独有内容");
    expect(markdown).toContain(`images/${sha(PNG)}.png`);
  }));

  test("preserves XLSX sheet names, cell coordinates, cached values, formulae and anchored images", async () => fixture(async root => {
    const source = await zip(root, "data.xlsx", {
      "xl/workbook.xml": `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="测量数据" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": rels(relation("rId1", "worksheet", "worksheets/sheet1.xml")),
      "xl/sharedStrings.xml": `<sst xmlns="${S}"><si><t>裂缝宽度</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet xmlns="${S}" xmlns:r="${R}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2"><v>3</v></c></row><row r="3"><c r="A3"><f>SUM(A2,A2)</f><v>6</v></c></row></sheetData><drawing r:id="rIdDrawing"/></worksheet>`,
      "xl/worksheets/_rels/sheet1.xml.rels": rels(relation("rIdDrawing", "drawing", "../drawings/drawing1.xml")),
      "xl/drawings/drawing1.xml": `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="${A}" xmlns:r="${R}"><xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:row>4</xdr:row></xdr:from><xdr:pic><a:blip r:embed="rIdImage"/></xdr:pic></xdr:twoCellAnchor></xdr:wsDr>`,
      "xl/drawings/_rels/drawing1.xml.rels": rels(relation("rIdImage", "image", "../media/image1.png")),
      "xl/media/image1.png": PNG,
    });
    const result = await normalizeProjectDocument(root, source, "artifact:sheet", XLSX);
    const markdown = await readFile(join(root, result.markdown_path), "utf8");
    expect(markdown).toContain("## Sheet 1: 测量数据");
    expect(markdown).toContain("| A1 | 裂缝宽度 |");
    expect(markdown).toContain("| A3 | 6 | =SUM(A2,A2) |");
    expect(markdown).toContain("### Drawing at B5");
    expect(markdown).toContain(`images/${sha(PNG)}.png`);
    expect(result.warnings.some(value => value.includes("not evaluated"))).toBe(true);
  }));

  test("rejects ZIP traversal and XML entities without committing derived output", async () => fixture(async root => {
    const traversal = await zip(root, "unsafe.docx", { "word/document.xml": doc(paragraph("good text")), "../escape.txt": "must never be written" });
    await expect(normalizeProjectDocument(root, traversal, "artifact:unsafe", DOCX)).rejects.toThrow("unsafe ZIP");
    const entity = await zip(root, "entities.docx", { "word/document.xml": `<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]>${doc(paragraph("&leak;"))}` });
    await expect(normalizeProjectDocument(root, entity, "artifact:entities", DOCX)).rejects.toThrow("DTD/entity");
    expect(await readdir(join(root, "normalized/artifact_unsafe"))).toEqual([]);
    expect(await readdir(join(root, "normalized/artifact_entities"))).toEqual([]);
  }));

  test("rejects source/output symlinks and oversized expanded members, without touching originals", async () => fixture(async root => {
    const source = await zip(root, "real.docx", { "word/document.xml": doc(paragraph("safe text")) });
    const original = await readFile(source);
    await symlink(source, join(root, "originals/alias.docx"));
    await expect(normalizeProjectDocument(root, join(root, "originals/alias.docx"), "artifact:alias", DOCX)).rejects.toThrow("symlink");
    await mkdir(join(root, "other"));
    await symlink(join(root, "other"), join(root, "normalized"));
    await expect(normalizeProjectDocument(root, source, "artifact:output", DOCX)).rejects.toThrow("symlink");
    await rm(join(root, "normalized"));
    const bomb = await zip(root, "bomb.docx", { "word/document.xml": "x".repeat(2 * 1024 * 1024) });
    await expect(normalizeProjectDocument(root, bomb, "artifact:bomb", DOCX)).rejects.toThrow("compression-ratio");
    expect(await readFile(source)).toEqual(original);
  }));

  test("does not fetch external pictures or execute alternate content", async () => fixture(async root => {
    const source = await zip(root, "external.docx", {
      "word/document.xml": doc(`${paragraph("可信的正文")}<w:p><w:r><w:drawing><a:blip r:embed="rIdExternal"/></w:drawing></w:r></w:p><w:altChunk r:id="rAlt"/>`),
      "word/_rels/document.xml.rels": rels(`<Relationship Id="rIdExternal" Type="${R}/image" Target="https://example.invalid/do-not-fetch.png" TargetMode="External"/>`),
      "word/vbaProject.bin": "MUST_NOT_BE_EXECUTED",
    });
    const result = await normalizeProjectDocument(root, source, "artifact:external", DOCX);
    expect(result.warnings.some(value => value.includes("External OOXML"))).toBe(true);
    expect(result.warnings.some(value => value.includes("alternate-format"))).toBe(true);
    const text = await readFile(join(root, result.markdown_path), "utf8");
    expect(text).toContain("可信的正文");
    expect(text).not.toContain("MUST_NOT_BE_EXECUTED");
  }));

  test.skipIf(HAS_FITZ)("reports a missing PDF runtime explicitly without claiming OCR", async () => fixture(async root => {
    const path = join(root, "scan.pdf");
    await writeFile(path, "%PDF-1.4\n");
    await expect(normalizeProjectDocument(root, path, "artifact:pdf", "application/pdf")).rejects.toThrow("requires PyMuPDF (fitz)");
    expect(await readdir(join(root, "normalized/artifact_pdf"))).toEqual([]);
  }));

  test.skipIf(!HAS_FITZ)("renders scanned PDF pages as local visual evidence without claiming OCR", async () => fixture(async root => {
    const path = join(root, "scan.pdf");
    execFileSync(PYTHON, ["-c", "import fitz,sys\ndoc=fitz.open()\npage=doc.new_page()\npage.draw_rect(fitz.Rect(20,20,100,100),color=(1,0,0),fill=(1,0,0))\ndoc.save(sys.argv[1])", path]);
    const before = sha(await readFile(path));
    const result = await normalizeProjectDocument(root, path, "artifact:scan", "application/pdf");
    expect(result.page_count).toBe(1);
    expect(result.warnings.some(value => value.includes("no OCR"))).toBe(true);
    expect(result.warnings.some(value => value.includes("fewer than 30"))).toBe(true);
    expect(await readFile(join(root, result.markdown_path), "utf8")).toMatch(/!\[Page 1 rendered original layout; no OCR\]\(images\/[a-f0-9]+\.png\)/);
    expect(sha(await readFile(path))).toBe(before);
  }));

  test.skipIf(!HAS_FITZ)("extracts embedded raster images on text PDF pages without redundant page renders", async () => fixture(async root => {
    const path = join(root, "text-with-image.pdf");
    execFileSync(PYTHON, ["-c", "import fitz,sys\ndoc=fitz.open()\npage=doc.new_page()\npage.insert_text((30,30), 'This is a text-bearing PDF page with enough extracted words for indexing.')\npix=fitz.Pixmap(fitz.csRGB,fitz.IRect(0,0,8,8),False)\npix.clear_with(255)\npage.insert_image(fitz.Rect(30,60,90,120),stream=pix.tobytes('png'))\ndoc.save(sys.argv[1])", path]);
    const result = await normalizeProjectDocument(root, path, "artifact:text-pdf", "application/pdf");
    const text = await readFile(join(root, result.markdown_path), "utf8");
    expect(text).toContain("enough extracted words");
    expect(text).toContain("Page 1 embedded image 1");
    expect(text).not.toContain("rendered original layout");
  }));
});
