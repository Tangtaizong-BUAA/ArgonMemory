import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildEvidenceCorpus } from "../src/project/retrieval/evidence.js";
import type { KnowledgeRecord } from "../src/project/runtime.js";

const roots: string[] = [];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const record = (id: string, fields: Partial<KnowledgeRecord> = {}): KnowledgeRecord => ({ id, type: "artifact", project_id: "project:fixture", title: id, status: "parsed", created_by: "fixture", created_at: "2026-01-01", updated_at: "2026-01-01", confidentiality: "internal", ...fields });
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "argon-security-image-")); roots.push(root); return root; }
async function file(root: string, path: string, value: string | Buffer) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); }

describe("Markdown image resource ownership", () => {
  test("internal Markdown cannot relabel secret, cross-project, encoded-parent or symlinked image bytes", async () => {
    const root = await fixture();
    await file(root, "normalized/internal/document.md", "# Low trust\n![](../secret/images/private.png)\n![](%2e%2e/secret/images/private.png)\n![](images/foreign.png)\n![](linked/private.png)\n![](images/own.png)\n");
    await file(root, "normalized/secret/document.md", "# Secret\n![](images/private.png)\n");
    await file(root, "normalized/secret/images/private.png", PNG);
    await file(root, "normalized/internal/images/foreign.png", PNG); await file(root, "normalized/internal/images/own.png", PNG);
    await symlink(join(root, "normalized/secret/images"), join(root, "normalized/internal/linked"));
    const items = [
      { record: record("artifact:internal", { normalized_markdown_path: "normalized/internal/document.md" }), body: "" },
      { record: record("artifact:secret", { normalized_markdown_path: "normalized/secret/document.md", confidentiality: "secret" }), body: "" },
      { record: record("artifact:foreign", { managed_relative_path: "normalized/internal/images/foreign.png", mime_type: "image/png", project_id: "project:other", sha256: hash(PNG) }), body: "" },
    ];
    const corpus = await buildEvidenceCorpus(root, items, "revision");
    const images = corpus.units.filter(unit => unit.record_id === "artifact:internal" && unit.kind === "image");
    expect(images).toHaveLength(1); expect(images[0]?.image_path).toContain("images/own.png"); expect(images[0]?.image_artifact_id).toBe("artifact:internal");
    expect(corpus.coverage.unavailable_images.filter(id => id.startsWith("artifact:internal"))).toHaveLength(4);
    expect(corpus.units.filter(unit => unit.kind === "image").every(unit => unit.image_artifact_id)).toBe(true);
  });

  test("a changed registered owner label invalidates an unchanged Markdown cache entry", async () => {
    const root = await fixture(); await file(root, "normalized/doc/document.md", "# Source\n![](images/registered.png)"); await file(root, "normalized/doc/images/registered.png", PNG);
    const source = { record: record("artifact:doc", { normalized_markdown_path: "normalized/doc/document.md" }), body: "" };
    const owner = { record: record("artifact:photo", { managed_relative_path: "normalized/doc/images/registered.png", mime_type: "image/png", sha256: hash(PNG) }), body: "" };
    const first = await buildEvidenceCorpus(root, [source, owner], "revision-1");
    expect(first.units.find(unit => unit.record_id === source.record.id && unit.kind === "image")?.image_artifact_id).toBe(owner.record.id);
    const second = await buildEvidenceCorpus(root, [source, { ...owner, record: { ...owner.record, confidentiality: "secret" as const } }], "revision-2", first);
    expect(second.units.filter(unit => unit.record_id === source.record.id && unit.kind === "image")).toHaveLength(0);
  });

  test("non-artifact Markdown cannot read an unregistered file under the knowledge root", async () => {
    const root = await fixture(); await file(root, "private/image.png", PNG);
    const corpus = await buildEvidenceCorpus(root, [{ record: record("section:unsafe", { type: "knowledge_section" }), body: "# Notes\n![](private/image.png)" }], "revision");
    expect(corpus.units.filter(unit => unit.kind === "image")).toHaveLength(0);
  });

  test.each(["secret", "foreign"])("duplicate exact-path registration cannot downgrade a %s image owner", async scenario => {
    const root = await fixture(); await file(root, "normalized/doc/shared.png", PNG); await file(root, "normalized/doc/document.md", "# Source\n![](shared.png)");
    const original = { record: record("artifact:original", { managed_relative_path: "normalized/doc/shared.png", mime_type: "image/png", sha256: hash(PNG) }), body: "" };
    const conflicting = { record: record("artifact:conflicting", { managed_relative_path: "normalized/doc/shared.png", mime_type: "image/png", sha256: hash(PNG), ...(scenario === "secret" ? { confidentiality: "secret" as const } : { project_id: "project:other" }) }), body: "" };
    const source = { record: record("artifact:doc", { normalized_markdown_path: "normalized/doc/document.md" }), body: "" };
    const corpus = await buildEvidenceCorpus(root, [source, original, conflicting], "revision");
    expect(corpus.units.filter(unit => unit.kind === "image" && [source.record.id, original.record.id].includes(unit.record_id))).toHaveLength(0);
  });
});
