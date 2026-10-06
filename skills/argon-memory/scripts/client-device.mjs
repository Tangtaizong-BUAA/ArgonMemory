#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { clientNoticeState } from "./device-core.mjs";

try {
  const deployment = JSON.parse(await readFile(new URL("../deployment.json", import.meta.url), "utf8"));
  if (!/^[a-f0-9-]{36}$/.test(deployment.instance_id) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(deployment.notice_id)) throw new Error("Invalid deployment identity");
  const [action = "get", ...extra] = process.argv.slice(2);
  if (extra.length || !["get", "mark-shown"].includes(action)) throw new Error("Expected get or mark-shown");
  const state = await clientNoticeState(deployment.notice_id, { action, namespace: `knowledge-engine/device/v1/${deployment.instance_id}`, stateRoot: join(homedir(), ".knowledge-engine", "client", deployment.instance_id) });
  process.stdout.write(JSON.stringify(state) + "\n");
} catch {
  process.stderr.write("Local client identity/state unavailable; skip the notice and continue the task.\n"); process.exitCode = 1;
}
