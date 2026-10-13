import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { CHUNK_UPLOAD_LIMITS, registerProjectTools } from "../src/mcp/tools/project.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
const roots: string[] = [], ids: string[] = [];
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
beforeAll(() => vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] }));
afterAll(() => vi.useRealTimers());
async function uploadExists(id: string): Promise<boolean> {
  const filename = `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.bin`, base = join(tmpdir(), "argon-memory-mcp-uploads");
  for (const name of await readdir(base).catch(() => [])) if (name.startsWith("process-") && await stat(join(base, name, filename)).catch(() => null)) return true;
  return false;
}
async function expireUploads() {
  await vi.advanceTimersByTimeAsync(CHUNK_UPLOAD_LIMITS.ttlMs + CHUNK_UPLOAD_LIMITS.sweepMs);
  await expect.poll(async () => (await Promise.all(ids.map(uploadExists))).some(Boolean), { timeout: 5000 }).toBe(false);
  ids.length = 0;
}
afterEach(async () => { await expireUploads(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.clearAllMocks(); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "argon-security-upload-")); roots.push(root); return root; }
function toolsFor(root: string, actor = "alice") {
  const registered = new Map<string, { config: any; callback: (input: any) => Promise<any> }>();
  const publish = vi.fn(async (input: any) => ({ artifact_id: "artifact:published", searchable: false, size_bytes: input.bytes.length }));
  const runtime = { root, get: vi.fn(async () => ({ record: { type: "work_item", project_id: "project:test" } })), publishResourceBytes: publish };
  const server = { registerTool: (name: string, config: any, callback: any) => registered.set(name, { config, callback }) };
  registerProjectTools(server as any, runtime as any, "project-contribute", actor);
  const call = async (name: string, input: any) => {
    const tool = registered.get(name)!; const response = await tool.callback(z.object(tool.config.inputSchema).parse(input));
    if (name === "kb_begin_resource_upload" && !response.isError) ids.push(response.structuredContent.upload_id);
    return response;
  };
  const begin = (size = 1, sha = hash("x")) => call("kb_begin_resource_upload", { work_id: "work:test", title: "Synthetic resource", filename: "synthetic.bin", content_type: "application/pdf", kind: "document", expected_size: size, expected_sha256: sha });
  return { call, begin, publish };
}

describe("chunk upload reservations and lifetime", () => {
  test("writer startup removes a previous process's orphan without another upload request", async () => {
    const path = join(tmpdir(), "argon-memory-mcp-uploads", `process-2147483647-${randomUUID()}`);
    await mkdir(path, { recursive: true });
    const orphan = join(path, `resource_upload_argon_${randomUUID().replaceAll("-", "")}.bin`);
    await writeFile(orphan, "uncommitted temporary bytes");
    toolsFor(await fixture());
    await expect.poll(async () => await stat(orphan).catch(() => null), { timeout: 5000 }).toBeNull();
  });

  test("orphan sweeps preserve expired files owned by another instance in this PID and another live PID", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    const base = join(tmpdir(), "argon-memory-mcp-uploads"), livePaths: string[] = [];
    try {
      for (const pid of [process.pid, child.pid!]) {
        const directory = join(base, `process-${pid}-${randomUUID()}`);
        roots.push(directory);
        await mkdir(directory, { recursive: true });
        const path = join(directory, `resource_upload_argon_${randomUUID().replaceAll("-", "")}.bin`);
        await writeFile(path, "active owner bytes");
        const expired = new Date(Date.now() - 2 * CHUNK_UPLOAD_LIMITS.ttlMs);
        await utimes(path, expired, expired);
        livePaths.push(path);
      }
      const deadDirectory = join(base, `process-2147483647-${randomUUID()}`);
      roots.push(deadDirectory);
      await mkdir(deadDirectory, { recursive: true });
      const deadPath = join(deadDirectory, `resource_upload_argon_${randomUUID().replaceAll("-", "")}.bin`);
      await writeFile(deadPath, "dead owner bytes");
      const legacyPath = join(base, `resource_upload_argon_${randomUUID().replaceAll("-", "")}.bin`);
      roots.push(legacyPath);
      await writeFile(legacyPath, "legacy expired bytes");
      const expired = new Date(Date.now() - 2 * CHUNK_UPLOAD_LIMITS.ttlMs);
      await utimes(legacyPath, expired, expired);
      toolsFor(await fixture());
      await vi.advanceTimersByTimeAsync(CHUNK_UPLOAD_LIMITS.sweepMs);
      await expect.poll(async () => await stat(deadPath).catch(() => null), { timeout: 5000 }).toBeNull();
      await expect.poll(async () => await stat(legacyPath).catch(() => null), { timeout: 5000 }).toBeNull();
      expect(await Promise.all(livePaths.map(path => readFile(path, "utf8")))).toEqual(["active owner bytes", "active owner bytes"]);
    } finally {
      // Keep the child alive until its files have been verified and removed.
      for (const path of livePaths) await rm(path, { force: true });
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });

  test("racing begin calls reserve principal count before any file creation", async () => {
    const tools = toolsFor(await fixture());
    const responses = await Promise.all(Array.from({ length: 16 }, () => tools.begin()));
    expect(responses.filter(response => !response.isError)).toHaveLength(CHUNK_UPLOAD_LIMITS.perPrincipalCount);
    expect(responses.filter(response => response.isError).every(response => response.content[0].text.includes("Principal chunked upload capacity"))).toBe(true);
    expect((await Promise.all(ids.map(uploadExists))).every(Boolean)).toBe(true);
  });

  test("declared bytes are bounded per principal and globally, including empty uploads", async () => {
    const root = await fixture(), alice = toolsFor(root);
    const own = await Promise.all(Array.from({ length: 3 }, () => alice.begin(100 * 1024 * 1024)));
    expect(own.filter(response => !response.isError)).toHaveLength(2);
    await expireUploads();
    const all = await Promise.all(Array.from({ length: 6 }, (_, index) => toolsFor(root, `actor-${index}`).begin(100 * 1024 * 1024)));
    expect(all.filter(response => !response.isError)).toHaveLength(5);
    expect(all.filter(response => response.isError)[0].content[0].text).toContain("Global chunked upload capacity");
  });

  test("global file count is bounded across principals and expiration removes files without another upload request", async () => {
    const root = await fixture();
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => toolsFor(root, `actor-${Math.floor(index / 4)}`).begin()));
    expect(responses.filter(response => !response.isError)).toHaveLength(CHUNK_UPLOAD_LIMITS.totalCount);
    expect((await Promise.all(ids.map(uploadExists))).every(Boolean)).toBe(true);
    await expireUploads();
    expect((await toolsFor(root, "replacement").begin()).isError).not.toBe(true);
  });

  test("failed file creation releases its reservation", async () => {
    const tools = toolsFor(await fixture());
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("synthetic disk error"));
    expect((await tools.begin()).isError).toBe(true);
    const retry = await Promise.all(Array.from({ length: 4 }, () => tools.begin()));
    expect(retry.every(response => !response.isError)).toBe(true);
  });

  test("concurrent append and commit are serialized, failed publication frees capacity, and another principal/root cannot use the upload", async () => {
    const root = await fixture(), tools = toolsFor(root), other = toolsFor(root, "bob"), foreignRoot = toolsFor(await fixture());
    const id = (await tools.begin()).structuredContent.upload_id;
    for (const outsider of [other, foreignRoot]) expect((await outsider.call("kb_append_resource_chunk", { upload_id: id, offset: 0, content_base64: "eA==" })).isError).toBe(true);
    const appends = await Promise.all([0, 1].map(() => tools.call("kb_append_resource_chunk", { upload_id: id, offset: 0, content_base64: "eA==" })));
    expect(appends.filter(response => !response.isError)).toHaveLength(1);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    tools.publish.mockImplementationOnce(async () => { entered(); await held; throw new Error("synthetic publisher failure"); });
    const first = tools.call("kb_commit_resource_upload", { upload_id: id }); await started;
    expect((await tools.call("kb_commit_resource_upload", { upload_id: id })).isError).toBe(true);
    await vi.advanceTimersByTimeAsync(CHUNK_UPLOAD_LIMITS.ttlMs + CHUNK_UPLOAD_LIMITS.sweepMs);
    const duringExpiredCallback = await Promise.all(Array.from({ length: 4 }, () => tools.begin()));
    // An expired but still running callback keeps its memory reservation.
    expect(duringExpiredCallback.filter(response => !response.isError)).toHaveLength(3);
    release(); expect((await first).isError).toBe(true); expect(tools.publish).toHaveBeenCalledTimes(1);
    expect(await uploadExists(id)).toBe(false);
    expect((await tools.begin()).isError).not.toBe(true);
  });

  test("a normal 100 MiB resource still commits through the byte API without a base64 publication copy", async () => {
    const tools = toolsFor(await fixture()), bytes = Buffer.alloc(4 * 1024 * 1024, 7), sha = createHash("sha256");
    for (let index = 0; index < 25; index++) sha.update(bytes);
    const expected = sha.digest("hex"), id = (await tools.begin(100 * 1024 * 1024, expected)).structuredContent.upload_id;
    const chunk = bytes.toString("base64");
    for (let index = 0; index < 25; index++) expect((await tools.call("kb_append_resource_chunk", { upload_id: id, offset: index * bytes.length, content_base64: chunk })).isError).not.toBe(true);
    tools.publish.mockImplementationOnce(async input => {
      expect(input.bytes).toBeInstanceOf(Buffer); expect(input.bytes.length).toBe(100 * 1024 * 1024); expect(hash(input.bytes)).toBe(expected);
      expect(input).not.toHaveProperty("content"); expect(input.actor).toBe("alice");
      return { artifact_id: "artifact:large", searchable: false, size_bytes: input.bytes.length };
    });
    const committed = await tools.call("kb_commit_resource_upload", { upload_id: id });
    expect(committed.isError).not.toBe(true); expect(committed.structuredContent.artifact_id).toBe("artifact:large"); expect(await uploadExists(id)).toBe(false);
  }, 30_000);
});
