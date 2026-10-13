import { createHash } from "node:crypto";
import { chmod, mkdir, opendir, rmdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";

// This campaign is independent of server/Skill versions. Patch upgrades must
// never create another copy of the same announcement.
export const ARCHITECTURE_NOTICE_ID = "architecture-2026-10-05";
export const ARCHITECTURE_NOTICE_MESSAGE = [
  "Argon Memory 知识库已采用全新架构：结构化知识导航 + 全局多模态 RAG + 可追溯证据 + 异步维护。",
  "主文件和专题文档帮助理解全貌；全局检索跨资料寻找证据，提供续页、原图和覆盖缺口。启用 Qwen 后加入文本和图片语义检索与重排；未启用时明确使用结构和词法检索。",
  "后台采用目录维护或可选 Qwen/MS-Agent 整理提案，经 Harness 校验来源、版本和冲突后提交；可选 Jev 提供有界章节关联建议。查询与维护独立运行。外部服务只在部署者明确启用后使用。",
  "这条架构介绍在同一台电脑只提示一次。",
].join("\n\n");

export type ProjectNotice = { notice_id: string; message: string };
export const DEFAULT_PROJECT_NOTICE: ProjectNotice = { notice_id: ARCHITECTURE_NOTICE_ID, message: ARCHITECTURE_NOTICE_MESSAGE };

export function projectNoticeContract(notice: ProjectNotice = DEFAULT_PROJECT_NOTICE) {
  return {
    schema: "argon-memory-client-notice/v1" as const,
    notice_id: notice.notice_id,
    delivery_tool: "kb_client_notice" as const,
    deduplication: "computer" as const,
    helper_path: "scripts/client-device.mjs",
    identity: "project-scoped-machine-hash; persistent-user-profile-fallback",
    delivery_semantics: "at-most-once-issuance" as const,
  };
}

export type ClientNoticeInput = { device_id?: string; action?: "claim" | "ack"; notice_id?: string };
export type ClientNoticeResult = {
  schema: "argon-memory-client-notice-result/v1";
  notice_id: string;
  status: "identity_required" | "announce" | "already_delivered" | "acknowledged" | "not_delivered";
  display: boolean;
  message?: string;
};

export const CLIENT_NOTICE_LIMITS = Object.freeze({ perPrincipal: 32, total: 4096, perPrincipalPerHour: 8, retentionMs: 30 * 24 * 60 * 60 * 1000 });
const legacyCleanups = new Map<string, Promise<void>>();

/** Legacy receipts are a delivery cache. Stream expiration checks so
 * upgrading a deployment with millions of files never builds a directory-sized
 * array or delays the authenticated request. Only the old generated names are
 * eligible; unexpired devices retain their upgrade deduplication until they are
 * migrated on demand. Canonical records are outside this directory. */
function retireLegacyReceipts(directory: string): void {
  if (legacyCleanups.has(directory)) return;
  const cleanup = (async () => {
    const campaigns = await opendir(directory);
    for await (const campaign of campaigns) {
      if (!campaign.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(campaign.name)) continue;
      const path = join(directory, campaign.name);
      const receipts = await opendir(path);
      let processed = 0;
      for await (const receipt of receipts) {
        if (receipt.isFile() && /^[a-f0-9]{64}\.(?:delivered|shown)\.json$/.test(receipt.name)) {
          const receiptPath = join(path, receipt.name);
          const info = await stat(receiptPath).catch(() => null);
          if (info && info.mtimeMs <= Date.now() - CLIENT_NOTICE_LIMITS.retentionMs) await unlink(receiptPath).catch(() => undefined);
        }
        if (++processed % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      }
      await rmdir(path).catch(() => undefined);
    }
  })().catch(() => undefined).finally(() => legacyCleanups.delete(directory));
  legacyCleanups.set(directory, cleanup);
}

/** Atomic across MCP sessions, principals and processes sharing the data root.
 * Receipt creation consumes delivery BEFORE returning the body. A dropped
 * response may therefore omit the notice, but never automatically repeats it.
 * Receipts are operational state, not knowledge records or maintenance events.
 */
export async function deliverClientNotice(root: string, input: ClientNoticeInput, notice: ProjectNotice = DEFAULT_PROJECT_NOTICE, principalId: string): Promise<ClientNoticeResult> {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(notice.notice_id)) throw new Error("Invalid configured client notice campaign");
  if (!principalId || principalId.length > 240) throw new Error("An authenticated client notice principal is required");
  const output = (status: ClientNoticeResult["status"], message?: string): ClientNoticeResult => ({
    schema: "argon-memory-client-notice-result/v1", notice_id: notice.notice_id,
    status, display: status === "announce", ...(message ? { message } : {}),
  });
  if (!input.device_id) return output("identity_required");
  if (!/^[a-f0-9]{64}$/.test(input.device_id)) throw new Error("Expected a project-scoped anonymous device hash");
  if (input.notice_id && input.notice_id !== notice.notice_id) throw new Error("Unknown client notice campaign");
  if (input.action && !["claim", "ack"].includes(input.action)) throw new Error("Invalid client notice action");
  const device = createHash("sha256").update(input.device_id).digest("hex");
  const principal = createHash("sha256").update(principalId).digest("hex");
  const directory = join(root, "client-notices");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Migrate only the requested legacy key. Never enumerate old receipts into
  // memory or import an unbounded, unauthenticated set into the new database.
  const legacy = await stat(join(directory, notice.notice_id, `${device}.delivered.json`)).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const databasePath = join(directory, "receipts.sqlite");
  const db = new Database(databasePath);
  try {
    await chmod(databasePath, 0o600);
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = FULL");
    db.exec(`CREATE TABLE IF NOT EXISTS client_notice_receipts (
      notice_id TEXT NOT NULL, device_hash TEXT NOT NULL, principal_hash TEXT NOT NULL,
      delivered_at INTEGER NOT NULL, acknowledged_at INTEGER,
      PRIMARY KEY (notice_id, device_hash)
    ); CREATE INDEX IF NOT EXISTS client_notice_principal_idx ON client_notice_receipts(principal_hash, delivered_at);`);
    const result = db.transaction(() => {
      const now = Date.now();
      db.prepare("DELETE FROM client_notice_receipts WHERE delivered_at <= ?").run(now - CLIENT_NOTICE_LIMITS.retentionMs);
      const existing = db.prepare("SELECT principal_hash FROM client_notice_receipts WHERE notice_id=? AND device_hash=?").get(notice.notice_id, device) as { principal_hash: string } | undefined;
      if (existing) {
        // Computer-level display deduplication remains shared, but another
        // principal cannot mutate the receipt or claim its acknowledgement.
        if (input.action === "ack" && existing.principal_hash === principal) db.prepare("UPDATE client_notice_receipts SET acknowledged_at=COALESCE(acknowledged_at, ?) WHERE notice_id=? AND device_hash=? AND principal_hash=?").run(now, notice.notice_id, device, principal);
        return output(input.action === "ack" && existing.principal_hash === principal ? "acknowledged" : "already_delivered");
      }
      if (input.action === "ack") return output("not_delivered");
      const total = (db.prepare("SELECT COUNT(*) AS count FROM client_notice_receipts").get() as { count: number }).count;
      const own = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(delivered_at > ?),0) AS recent FROM client_notice_receipts WHERE principal_hash=?").get(now - 60 * 60 * 1000, principal) as { count: number; recent: number };
      if (total >= CLIENT_NOTICE_LIMITS.total || own.count >= CLIENT_NOTICE_LIMITS.perPrincipal) throw new Error("Client notice receipt capacity reached");
      if (own.recent >= CLIENT_NOTICE_LIMITS.perPrincipalPerHour) throw new Error("Client notice principal rate limit reached");
      db.prepare("INSERT INTO client_notice_receipts (notice_id,device_hash,principal_hash,delivered_at) VALUES (?,?,?,?)").run(notice.notice_id, device, principal, now);
      return legacy?.isFile() && legacy.mtimeMs > now - CLIENT_NOTICE_LIMITS.retentionMs ? output("already_delivered") : output("announce", notice.message);
    }).immediate();
    if (legacy && result.status !== "not_delivered") {
      // Remove only this successfully migrated device, never unrelated fresh
      // receipts whose owners have not connected since the upgrade.
      await Promise.all(["delivered", "shown"].map(event => unlink(join(directory, notice.notice_id, `${device}.${event}.json`)).catch(() => undefined)));
    }
    retireLegacyReceipts(directory);
    return result;
  } finally { db.close(); }
}
