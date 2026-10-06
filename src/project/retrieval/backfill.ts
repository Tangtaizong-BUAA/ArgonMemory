import type { KnowledgeRecord, ProjectRuntime } from "../runtime.js";

type Runtime = Pick<ProjectRuntime, "records" | "normalizeArtifactLocal" | "parseArtifactWithMinerU">;
export type BackfillCounts = { total: number; succeeded: number; skipped: number; failed: number; retry_deferred: number };
export type BackfillOptions = { normalize: boolean; ocr: boolean; once: boolean; forceNormalize: boolean; queueMaintenance?: boolean };
const RETRY_MS = 10 * 60 * 1000;
const active = (record: KnowledgeRecord) => record.type === "artifact" && !["stale", "superseded", "deleted", "archived", "retired", "deprecated", "candidate", "validating", "quarantined", "rejected", "disputed", "proposal", "proposed", "queued"].includes(record.status);

/** Process-local retries are keyed by operation, artifact and registered source hash. */
export class RetrievalBackfill {
  private readonly retries = new Map<string, number>();
  constructor(private readonly log: (event: Record<string, unknown>, error?: boolean) => void, private readonly now = Date.now) {}

  async run(runtime: Runtime, options: BackfillOptions): Promise<{ normalization?: BackfillCounts; ocr?: BackfillCounts; failed: number }> {
    for (const [key, until] of this.retries) if (until <= this.now()) this.retries.delete(key);
    const result: { normalization?: BackfillCounts; ocr?: BackfillCounts; failed: number } = { failed: 0 };
    const process = async (operation: "normalization" | "ocr", records: KnowledgeRecord[]) => {
      const counts: BackfillCounts = { total: records.length, succeeded: 0, skipped: 0, failed: 0, retry_deferred: 0 };
      const event = operation === "normalization" ? "artifact_normalized" : "artifact_ocr";
      for (const record of records) {
        if (operation === "ocr" && !["public", "internal"].includes(record.confidentiality ?? "internal")) {
          counts.skipped++;
          this.log({ event: "artifact_ocr_skipped", artifact_id: record.id, reason: "confidentiality_exceeds_automatic_ocr_policy" });
          continue;
        }
        const normalized = record.local_normalization as { source_sha256?: string } | undefined;
        const done = operation === "normalization"
          ? normalized && (!normalized.source_sha256 || normalized.source_sha256 === record.sha256) && !(options.once && options.forceNormalize)
          : record.parser_name === "mineru_cloud" && record.status === "parsed" && !record.parser_error_code;
        if (done) { counts.skipped++; continue; }
        const key = JSON.stringify([operation, record.id, record.sha256 ?? ""]);
        if ((this.retries.get(key) ?? 0) > this.now()) { counts.skipped++; counts.retry_deferred++; continue; }
        try {
          const value = operation === "normalization"
            ? await runtime.normalizeArtifactLocal(record.id, "retrieval-upgrade", options.queueMaintenance === true)
            : await runtime.parseArtifactWithMinerU(record.id, "retrieval-upgrade", { force: true, queueMaintenance: options.queueMaintenance === true });
          if (operation === "ocr" && value.status !== "parsed") throw new Error(String(value.error_code ?? "MinerU parsing failed"));
          counts.succeeded++; this.retries.delete(key);
          this.log({ event, ...value, completed: counts.succeeded, total: counts.total });
        } catch (error) {
          counts.failed++; this.retries.set(key, this.now() + RETRY_MS);
          this.log({ event: operation === "normalization" ? "artifact_normalization_failed" : "artifact_ocr_failed", artifact_id: record.id, error: error instanceof Error ? error.message : "unknown_error", retry_after_ms: RETRY_MS }, true);
        }
      }
      this.log({ event: `artifact_${operation}_summary`, ...counts });
      result[operation] = counts; result.failed += counts.failed;
    };
    if (options.normalize) {
      const records = (await runtime.records()).map(({ record }) => record).filter(record => active(record) && /\.(pdf|docx|pptx|xlsx|json|ya?ml|txt|csv|md)$/i.test(String(record.original_relative_path ?? "")));
      await process("normalization", records);
    }
    // Read fresh records so a scan discovered by this round's local parser can be OCRed immediately.
    if (options.ocr) {
      const records = (await runtime.records()).map(({ record }) => record).filter(record => active(record) && record.mime_type === "application/pdf" && JSON.stringify(record.local_normalization ?? {}).includes("fewer than 30"));
      await process("ocr", records);
    }
    return result;
  }
}
