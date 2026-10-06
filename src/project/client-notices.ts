import { createHash } from "node:crypto";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

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

/** Atomic across MCP sessions, principals and processes sharing the data root.
 * Receipt creation consumes delivery BEFORE returning the body. A dropped
 * response may therefore omit the notice, but never automatically repeats it.
 * Receipts are operational state, not knowledge records or maintenance events.
 */
export async function deliverClientNotice(root: string, input: ClientNoticeInput, notice: ProjectNotice = DEFAULT_PROJECT_NOTICE): Promise<ClientNoticeResult> {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(notice.notice_id)) throw new Error("Invalid configured client notice campaign");
  const output = (status: ClientNoticeResult["status"], message?: string): ClientNoticeResult => ({
    schema: "argon-memory-client-notice-result/v1", notice_id: notice.notice_id,
    status, display: status === "announce", ...(message ? { message } : {}),
  });
  if (!input.device_id) return output("identity_required");
  if (!/^[a-f0-9]{64}$/.test(input.device_id)) throw new Error("Expected a project-scoped anonymous device hash");
  if (input.notice_id && input.notice_id !== notice.notice_id) throw new Error("Unknown client notice campaign");
  if (input.action && !["claim", "ack"].includes(input.action)) throw new Error("Invalid client notice action");
  const device = createHash("sha256").update(input.device_id).digest("hex");
  const directory = join(root, "client-notices", notice.notice_id);
  const delivered = join(directory, `${device}.delivered.json`);
  const acknowledged = join(directory, `${device}.shown.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (input.action === "ack" && !(await stat(delivered).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  }))) return output("not_delivered");
  const path = input.action === "ack" ? acknowledged : delivered;
  const handle = await open(path, "wx", 0o600).catch(error => {
    if (error.code === "EEXIST") return null;
    throw error;
  });
  if (!handle) return output(input.action === "ack" ? "acknowledged" : "already_delivered");
  try {
    await handle.writeFile(`${JSON.stringify({ schema: "argon-memory-client-notice-receipt/v1", notice_id: notice.notice_id, device_hash: device, event: input.action === "ack" ? "shown" : "delivered", at: new Date().toISOString() })}\n`);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(path);
    throw error;
  }
  await handle.close();
  if (process.platform !== "win32") {
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }
  return input.action === "ack" ? output("acknowledged") : output("announce", notice.message);
}
