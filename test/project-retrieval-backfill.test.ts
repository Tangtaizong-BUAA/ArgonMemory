import { describe, expect, test, vi } from "vitest";
import type { KnowledgeRecord, ProjectRuntime } from "../src/project/runtime.js";
import { RetrievalBackfill } from "../src/project/retrieval/backfill.js";

function fixture() {
  let now = 1000;
  const records: KnowledgeRecord[] = [];
  const log = vi.fn();
  const runtime = {
    records: vi.fn(async () => records.map(record => ({ record, body: "" }))),
    normalizeArtifactLocal: vi.fn(async (id: string) => {
      const record = records.find(record => record.id === id)!;
      record.local_normalization = { source_sha256: record.sha256, warnings: record.mime_type === "application/pdf" ? ["Page 1 contains fewer than 30 text characters"] : [] };
      record.status = "parsed";
      return { artifact_id: id };
    }),
    parseArtifactWithMinerU: vi.fn(async (id: string) => {
      const record = records.find(record => record.id === id)!;
      record.status = "parsed"; record.parser_name = "mineru_cloud";
      return { artifact_id: id, status: "parsed" };
    }),
  };
  const seed = (id: string, ext = "txt", extra: Record<string, unknown> = {}) => {
    const record = { id, type: "artifact", status: "registered", title: id, original_relative_path: `${id}.${ext}`, sha256: "hash-1", mime_type: ext === "pdf" ? "application/pdf" : "text/plain", ...extra } as KnowledgeRecord;
    records.push(record); return record;
  };
  const worker = new RetrievalBackfill(log, () => now);
  const run = (options = {}) => worker.run(runtime as unknown as ProjectRuntime, { normalize: true, ocr: false, once: false, forceNormalize: false, ...options });
  return { records, runtime, log, seed, run, advance: (ms: number) => { now += ms; } };
}

describe("retrieval backfill watcher", () => {
  test("queues fresh parsed evidence when running the deployable maintenance pipeline", async () => {
    const f = fixture(); f.seed("scan", "pdf");
    await f.run({ ocr: true, queueMaintenance: true });
    expect(f.runtime.normalizeArtifactLocal).toHaveBeenCalledWith("scan", "retrieval-upgrade", true);
    expect(f.runtime.parseArtifactWithMinerU).toHaveBeenCalledWith("scan", "retrieval-upgrade", { force: true, queueMaintenance: true });
  });

  test("does not turn disputed or quarantined files into accepted parsed sources", async () => {
    const f = fixture();
    for (const status of ["quarantined", "disputed", "rejected", "candidate"]) f.seed(status, "pdf", { status });
    f.seed("current", "txt");
    expect((await f.run({ ocr: true, queueMaintenance: true })).normalization?.total).toBe(1);
    expect(f.runtime.normalizeArtifactLocal.mock.calls.map(call => call[0])).toEqual(["current"]);
    expect(f.runtime.parseArtifactWithMinerU).not.toHaveBeenCalled();
    expect(f.records.filter(record => record.id !== "current").map(record => record.status)).toEqual(["quarantined", "disputed", "rejected", "candidate"]);
  });

  test("keeps normalization and OCR opt-in", async () => {
    const f = fixture(); f.seed("disabled", "pdf");
    expect(await f.run({ normalize: false })).toEqual({ failed: 0 });
    expect(f.runtime.records).not.toHaveBeenCalled();
  });

  test("discovers later uploads and normalizes/OCRs a new scan in the same round only once", async () => {
    const f = fixture(); f.seed("plain");
    await f.run({ ocr: true });
    f.seed("scan", "pdf");
    const next = await f.run({ ocr: true });
    expect(next.normalization).toMatchObject({ total: 2, succeeded: 1, skipped: 1, failed: 0 });
    expect(next.ocr).toMatchObject({ total: 1, succeeded: 1, skipped: 0 });
    expect(f.runtime.normalizeArtifactLocal.mock.calls.map(call => call[0])).toEqual(["plain", "scan"]);
    expect(f.runtime.parseArtifactWithMinerU).toHaveBeenCalledWith("scan", "retrieval-upgrade", { force: true, queueMaintenance: false });
    await f.run({ ocr: true });
    expect(f.runtime.normalizeArtifactLocal).toHaveBeenCalledTimes(2);
    expect(f.runtime.parseArtifactWithMinerU).toHaveBeenCalledTimes(1);
  });

  test("counts failures, keeps processing, and backs off the same ID/hash for ten minutes", async () => {
    const f = fixture(); const bad = f.seed("bad"); f.seed("good");
    f.runtime.normalizeArtifactLocal.mockImplementation(async id => {
      if (id === "bad") throw new Error("bad ZIP");
      f.records.find(record => record.id === id)!.local_normalization = { source_sha256: "hash-1" };
      return { artifact_id: id };
    });
    expect(await f.run()).toMatchObject({ failed: 1, normalization: { total: 2, succeeded: 1, skipped: 0, failed: 1 } });
    expect(await f.run()).toMatchObject({ failed: 0, normalization: { succeeded: 0, skipped: 2, retry_deferred: 1 } });
    expect(f.runtime.normalizeArtifactLocal).toHaveBeenCalledTimes(2);
    bad.sha256 = "hash-2";
    expect((await f.run()).failed).toBe(1);
    f.advance(599_999); expect((await f.run()).failed).toBe(0);
    f.advance(1); expect((await f.run()).failed).toBe(1);
    expect(f.runtime.normalizeArtifactLocal).toHaveBeenCalledTimes(4);
    expect(f.log).toHaveBeenCalledWith(expect.objectContaining({ event: "artifact_normalization_summary", succeeded: 1, failed: 1, skipped: 0 }));
  });

  test("treats returned OCR failure as failed and retries after backoff", async () => {
    const f = fixture(); const scan = f.seed("scan", "pdf", { local_normalization: { source_sha256: "hash-1", warnings: ["fewer than 30"] } });
    f.runtime.parseArtifactWithMinerU.mockImplementation(async id => {
      scan.parser_name = "mineru_cloud"; scan.status = "failed"; scan.parser_error_code = "mineru_api_parse_failed";
      return { artifact_id: id, status: "failed" };
    });
    expect(await f.run({ ocr: true })).toMatchObject({ failed: 1, ocr: { succeeded: 0, failed: 1 } });
    expect(await f.run({ ocr: true })).toMatchObject({ ocr: { failed: 0, skipped: 1, retry_deferred: 1 } });
    f.advance(600_000);
    expect((await f.run({ ocr: true })).failed).toBe(1);
    expect(f.runtime.parseArtifactWithMinerU).toHaveBeenCalledTimes(2);
  });

  test("honors force normalization only with once and reprocesses changed registered source hashes", async () => {
    const f = fixture(); const existing = f.seed("existing", "md", { local_normalization: { source_sha256: "hash-1" } });
    expect((await f.run({ forceNormalize: true })).normalization?.skipped).toBe(1);
    expect(f.runtime.normalizeArtifactLocal).not.toHaveBeenCalled();
    expect((await f.run({ forceNormalize: true, once: true })).normalization?.succeeded).toBe(1);
    existing.sha256 = "new-hash";
    expect((await f.run()).normalization?.succeeded).toBe(1);
  });

  test("excludes historical/deleted artifacts and unsupported media", async () => {
    const f = fixture(); f.seed("archived", "pdf", { status: "archived" }); f.seed("video", "mp4"); f.seed("note", "yaml");
    expect((await f.run({ ocr: true })).normalization).toMatchObject({ total: 1, succeeded: 1 });
    expect(f.runtime.normalizeArtifactLocal.mock.calls.map(call => call[0])).toEqual(["note"]);
  });

  test("normalizes confidential originals locally but automatically OCRs only public/internal sources", async () => {
    const f = fixture();
    for (const level of ["public", "internal", "restricted", "secret", "unknown"]) f.seed(level, "pdf", { confidentiality: level });
    const result = await f.run({ ocr: true });
    expect(result.normalization).toMatchObject({ total: 5, succeeded: 5 });
    expect(result.ocr).toMatchObject({ total: 5, succeeded: 2, skipped: 3, failed: 0 });
    expect(f.runtime.parseArtifactWithMinerU.mock.calls.map(call => call[0])).toEqual(["public", "internal"]);
    expect(f.log.mock.calls.filter(([event]) => event.reason === "confidentiality_exceeds_automatic_ocr_policy")).toHaveLength(3);
  });
});
