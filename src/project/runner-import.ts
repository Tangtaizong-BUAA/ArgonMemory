import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

export type RunnerImportCapability = {
  v: 1;
  task_id: string;
  output_id: string;
  logical_path: string;
  size: number;
  sha256: string;
  work_id: string;
  exp: number;
  nonce: string;
};

function fail(message: string): never {
  throw new Error(`Invalid Runner import capability: ${message}`);
}

function decodeCapability(token: string, secret: string): RunnerImportCapability {
  if (!secret || secret.length < 32) fail("server secret is unavailable");
  if (!token || token.length > 4096) fail("token length");
  const parts = token.split(".");
  if (parts.length !== 2) fail("token shape");
  const payloadText = parts[0]!;
  const signatureText = parts[1]!;
  const expected = createHmac("sha256", secret).update(payloadText).digest();
  const received = Buffer.from(signatureText, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) fail("signature");
  let payload: RunnerImportCapability;
  try { payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8")); } catch { fail("payload JSON"); }
  return payload!;
}

function validateCapability(payload: RunnerImportCapability, workId: string, now: number): string[] {
  if (payload.v !== 1) fail("version");
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(payload.task_id)) fail("task id");
  if (!/^[a-f0-9]{32}$/.test(payload.output_id)) fail("output id");
  if (!Number.isSafeInteger(payload.size) || payload.size < 1 || payload.size > 100 * 1024 * 1024) fail("size");
  if (!/^[a-f0-9]{64}$/.test(payload.sha256)) fail("sha256");
  if (payload.work_id !== workId) fail("work item binding");
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= now || payload.exp > now + 10 * 60_000) fail("expiry");
  if (!/^[a-f0-9-]{16,64}$/.test(payload.nonce)) fail("nonce");
  if (!payload.logical_path || payload.logical_path.length > 500 || isAbsolute(payload.logical_path) || payload.logical_path.includes("\\") || payload.logical_path.includes("\0")) fail("logical path");
  const parts = payload.logical_path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail("logical path segments");
  return parts;
}

export async function readRunnerImportCapability(token: string, workId: string, {
  root = process.env.ARGON_MEMORY_RUNNER_EXPORT_ROOT || "",
  secret = process.env.ARGON_MEMORY_RUNNER_IMPORT_SECRET || "",
  now = Date.now(),
}: { root?: string; secret?: string; now?: number } = {}): Promise<{ capability: RunnerImportCapability; bytes: Buffer }> {
  if (!root || !isAbsolute(root)) fail("export root is unavailable");
  const capability = decodeCapability(token, secret);
  const logicalParts = validateCapability(capability, workId, now);
  const trustedRoot = await realpath(root);
  const taskRoot = resolve(trustedRoot, capability.task_id);
  const outboxRoot = resolve(taskRoot, "outbox");
  const target = resolve(outboxRoot, ...logicalParts);
  if (!target.startsWith(`${outboxRoot}${sep}`)) fail("path escape");
  for (const candidate of [taskRoot, outboxRoot, target]) {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) fail("symbolic link");
  }
  const resolvedTarget = await realpath(target);
  if (!resolvedTarget.startsWith(`${outboxRoot}${sep}`)) fail("resolved path escape");
  const info = await lstat(resolvedTarget);
  if (!info.isFile() || info.isSymbolicLink()) fail("not a regular file");
  const bytes = await readFile(resolvedTarget);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== capability.size || sha256 !== capability.sha256) fail("file integrity");
  return { capability, bytes };
}
