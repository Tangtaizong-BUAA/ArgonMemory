#!/usr/bin/env node
// Shared local-only device state; no network, token or source reads.
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);
export const DEVICE_NAMESPACE = "knowledge-engine/device/v1";
const defaultStateRoot = () => join(homedir(), ".knowledge-engine", "client");
const validCampaign = value => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);

export async function machineIdentity(platform = process.platform) {
  try {
    if (platform === "darwin") {
      const { stdout } = await run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 3000, maxBuffer: 65536 });
      return stdout.match(/"IOPlatformUUID"\s*=\s*"([a-f0-9-]{36})"/i)?.[1] ?? null;
    }
    if (platform === "win32") {
      const { stdout } = await run("reg.exe", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"], { timeout: 3000, maxBuffer: 65536, windowsHide: true });
      return stdout.match(/MachineGuid\s+REG_SZ\s+([a-f0-9-]{36})/i)?.[1] ?? null;
    }
    if (platform === "linux") {
      for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        const value = await readFile(path, "utf8").catch(() => "");
        if (/^[a-f0-9]{32}$/i.test(value.trim()) && !/^0+$/.test(value.trim())) return value.trim();
      }
    }
  } catch { /* Restricted/cloud hosts can use a persistent profile ID. */ }
  return null;
}

async function fallbackId(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, "device-id"), id = randomUUID();
  const file = await open(path, "wx", 0o600).catch(error => { if (error.code === "EEXIST") return null; throw error; });
  if (file) {
    try { await file.writeFile(id); await file.sync(); } finally { await file.close(); }
    return id;
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    const value = (await readFile(path, "utf8")).trim();
    if (/^[a-f0-9-]{36}$/i.test(value)) return value;
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error("Persistent device identity is incomplete; skip the notice");
}

export async function getClientDevice({ stateRoot = defaultStateRoot(), platform = process.platform, readMachine = machineIdentity, namespace = DEVICE_NAMESPACE } = {}) {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const cache = join(stateRoot, "device.json");
  const readCache = async () => {
    const text = await readFile(cache, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (text === null) return null;
    try {
      const value = JSON.parse(text);
      if (/^[a-f0-9]{64}$/.test(value.device_id) && ["computer", "user_profile"].includes(value.identity_scope)) return { device_id: value.device_id, identity_scope: value.identity_scope };
    } catch { /* Another first-run client may still be writing. */ }
    return undefined;
  };
  const saved = await readCache();
  if (saved) return saved;
  const machine = await readMachine(platform), raw = machine || await fallbackId(stateRoot);
  const candidate = {
    device_id: createHash("sha256").update(`${namespace}\0${machine ? platform : "user-profile"}\0${raw.trim().toLowerCase()}`).digest("hex"),
    identity_scope: machine ? "computer" : "user_profile",
  };
  const file = await open(cache, "wx", 0o600).catch(error => { if (error.code === "EEXIST") return null; throw error; });
  if (file) { try { await file.writeFile(JSON.stringify(candidate)); await file.sync(); } finally { await file.close(); } return candidate; }
  for (let attempt = 0; attempt < 40; attempt++) {
    const value = await readCache(); if (value) return value;
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error("Cached device identity is incomplete; skip the notice");
}

export async function clientNoticeState(noticeId, { action = "get", stateRoot = defaultStateRoot(), ...identityOptions } = {}) {
  if (!validCampaign(noticeId) || !["get", "mark-shown"].includes(action)) throw new Error("Invalid notice state request");
  const device = await getClientDevice({ stateRoot, ...identityOptions });
  const path = join(stateRoot, "notices", device.device_id, `${noticeId}.shown`);
  if (action === "mark-shown") {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, "wx", 0o600).catch(error => { if (error.code === "EEXIST") return null; throw error; });
    if (file) { try { await file.writeFile(`${new Date().toISOString()}\n`); await file.sync(); } finally { await file.close(); } }
  }
  const notice_shown = Boolean(await stat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; }));
  return { ...device, notice_id: noticeId, notice_shown };
}
