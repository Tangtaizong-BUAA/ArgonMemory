import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeEvidencePreview } from "../src/project/retrieval/preview.js";

const PYTHON = process.env.ARGON_MEMORY_PYTHON_BIN || "python3";
const HAS_FITZ = spawnSync(PYTHON, ["-c", "import fitz"], { stdio: "ignore" }).status === 0;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "argon-memory-preview-")); roots.push(root); return root; }
async function fakePython(root: string, body: string): Promise<string> {
  const path = join(root, "fake-python");
  // Linux requires an absolute interpreter in a shebang, even when the
  // configured Python command is resolved from PATH.
  const interpreter = execFileSync(PYTHON, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  await writeFile(path, `#!${interpreter}\nimport sys,time\nsys.stdin.buffer.read()\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("compact evidence image previews", () => {
  test.skipIf(!HAS_FITZ)("real PyMuPDF shrinks wide transparent images to a bounded white-background JPEG and persists it", async () => {
    const root = await fixture();
    const original = execFileSync(PYTHON, ["-c", "import fitz,sys\nd=fitz.open();p=d.new_page(width=3600,height=1800)\np.draw_rect(fitz.Rect(1000,500,2600,1300),color=(1,0,0),fill=(1,0,0))\nsys.stdout.buffer.write(p.get_pixmap(alpha=True).tobytes('png'))"], { maxBuffer: 12 * 1024 * 1024 });
    const originalPath = join(root, "original.png"), originalHash = sha(original);
    await writeFile(originalPath, original);
    const preview = await makeEvidencePreview(root, originalHash, "image/png", original.toString("base64"));
    const bytes = Buffer.from(preview.data, "base64");
    expect(preview.mimeType).toBe("image/jpeg");
    expect(bytes.length).toBeLessThanOrEqual(256 * 1024);
    const metadata = JSON.parse(execFileSync(PYTHON, ["-c", "import fitz,sys,json\np=fitz.Pixmap(sys.stdin.buffer.read())\nprint(json.dumps({'width':p.width,'height':p.height,'alpha':p.alpha,'corner':p.pixel(0,0),'center':p.pixel(p.width//2,p.height//2)}))"], { input: bytes, encoding: "utf8" }));
    expect(metadata.width).toBe(720); expect(metadata.height).toBe(360); expect(metadata.alpha).toBe(0);
    expect(metadata.corner.every((value: number) => value >= 245)).toBe(true);
    expect(metadata.center[0]).toBeGreaterThan(230); expect(metadata.center[1]).toBeLessThan(30);
    expect(sha(await readFile(originalPath))).toBe(originalHash);
    const cache = join(root, "knowledge/indexes/image-previews", `${originalHash}-v1.jpg`);
    expect(await readFile(cache)).toEqual(bytes);
    expect((await stat(cache)).size).toBe(bytes.length);

    // Reload the module to prove a fresh process can reuse the disk projection.
    vi.resetModules();
    const reloaded = await import("../src/project/retrieval/preview.js");
    vi.stubEnv("ARGON_MEMORY_PYTHON_BIN", join(root, "missing-python"));
    expect(await reloaded.makeEvidencePreview(root, originalHash, "image/png", original.toString("base64"))).toEqual(preview);
  });

  test.skipIf(!HAS_FITZ)("returns and reuses an in-memory preview when cache storage is unwritable", async () => {
    const root = await fixture();
    await writeFile(join(root, "knowledge"), "not a writable cache directory");
    const first = await makeEvidencePreview(root, sha(PNG), "image/png", PNG.toString("base64"));
    expect(Buffer.byteLength(first.data, "base64")).toBeLessThanOrEqual(256 * 1024);
    vi.stubEnv("ARGON_MEMORY_PYTHON_BIN", join(root, "missing-python"));
    expect(await makeEvidencePreview(root, sha(PNG), "image/png", PNG.toString("base64"))).toEqual(first);
    expect(await readFile(join(root, "knowledge"), "utf8")).toBe("not a writable cache directory");
  });

  test("rejects unverified hashes, excessive inputs, and unsupported MIME before spawning", async () => {
    const root = await fixture();
    vi.stubEnv("ARGON_MEMORY_PYTHON_BIN", join(root, "missing-python"));
    await expect(makeEvidencePreview(root, "../escape", "image/png", PNG.toString("base64"))).rejects.toThrow(/SHA-256/);
    await expect(makeEvidencePreview(root, "0".repeat(64), "image/png", PNG.toString("base64"))).rejects.toThrow(/integrity/);
    await expect(makeEvidencePreview(root, sha(PNG), "image/png", "a".repeat(14 * 1024 * 1024))).rejects.toThrow(/10 MiB/);
    await expect(makeEvidencePreview(root, sha(PNG), "application/pdf", PNG.toString("base64"))).rejects.toThrow(/MIME/);
  });

  test.each([
    ["output limit", "sys.stdout.buffer.write(b'x'*(256*1024+1))", /256 KiB/],
    ["stderr limit", "sys.stderr.write('x'*(8*1024+1))", /stderr limit/],
    ["failed process", "sys.exit(3)", /renderer failed/],
    ["invalid output", "sys.stdout.buffer.write(b'not a jpeg')", /invalid/],
  ])("bounds renderer failure: %s", async (_label, body, error) => {
    const root = await fixture();
    vi.stubEnv("ARGON_MEMORY_PYTHON_BIN", await fakePython(root, body));
    await expect(makeEvidencePreview(root, sha(PNG), "image/png", PNG.toString("base64"))).rejects.toThrow(error);
  });

  test("kills a stuck renderer at the ten-second deadline", async () => {
    const root = await fixture();
    vi.stubEnv("ARGON_MEMORY_PYTHON_BIN", await fakePython(root, "time.sleep(60)"));
    const started = Date.now();
    await expect(makeEvidencePreview(root, sha(PNG), "image/png", PNG.toString("base64"))).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(13_000);
  }, 15_000);
});
