import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { atomicJson, SKILL_PATHS } from "./config.js";
import { PROJECT_MCP_SERVER_VERSION } from "../client-skill.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const managedPaths = new Set([...SKILL_PATHS, "deployment.json"]);
const invitationSchema = z.object({ schema: z.literal("knowledge-engine-invitation/v1"), endpoint: z.string(), project_id: z.string().startsWith("project:"), token: z.string().min(20).max(200) });
export async function readInvitation(path: string) {
  const invite = invitationSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const url = new URL(invite.endpoint);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || !url.pathname.endsWith("/mcp") || url.username || url.password || url.search || url.hash) throw new Error("Invalid invitation MCP endpoint");
  return invite;
}

export async function configureClient(invitationPath: string, output: string): Promise<string> {
  const invite = await readInvitation(invitationPath);
  const absolute = resolve(output);
  const existing = await readFile(absolute, "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; });
  const config = JSON.parse(existing);
  if (!config || typeof config !== "object" || Array.isArray(config) || (config.mcpServers && (typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)))) throw new Error("Expected an MCP JSON configuration object");
  const name = `knowledge-${digest(invite.endpoint).slice(0, 8)}`;
  await atomicJson(absolute, { ...config, mcpServers: { ...config.mcpServers, [name]: { url: invite.endpoint, headers: { Authorization: `Bearer ${invite.token}` } } } });
  return absolute;
}

async function clientConnection(invitationPath: string): Promise<Client> {
  const invite = await readInvitation(invitationPath);
  const client = new Client({ name: "argon-memory-client", version: PROJECT_MCP_SERVER_VERSION });
  try { await client.connect(new StreamableHTTPClientTransport(new URL(invite.endpoint), { requestInit: { headers: { Authorization: `Bearer ${invite.token}` } } })); }
  catch { await client.close().catch(() => undefined); throw new Error("MCP authentication or connection failed"); }
  return client;
}

async function safeDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) { await mkdir(path, { recursive: true, mode: 0o700 }); return; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Skill directory must not be a symlink or file");
}

export async function synchronizeClientSkill(invitationPath: string, output: string): Promise<{ directory: string; version: string; status: string; session_reload_required: boolean }> {
  const target = resolve(output); await safeDirectory(target);
  let manifest: { skill_name: string; version: string; files: Record<string, string> } | undefined;
  const manifestPath = join(target, "skill-version.json");
  const manifestInfo = await lstat(manifestPath).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (manifestInfo?.isSymbolicLink()) throw new Error("Skill manifest cannot be a symlink");
  if (manifestInfo) manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const installedFiles: Array<{ path: string; sha256: string }> = [];
  for (const path of Object.keys(manifest?.files ?? {})) {
    if (!managedPaths.has(path)) throw new Error("Local manifest contains an unmanaged path");
    const file = join(target, path), info = await lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Managed Skill file is not a regular file");
    installedFiles.push({ path, sha256: info ? digest(await readFile(file, "utf8")) : "0".repeat(64) });
  }
  const client = await clientConnection(invitationPath);
  const args = { client: "generic", installed_version: manifest?.version ?? "none", ...(installedFiles.length ? { installed_files: installedFiles } : {}) };
  try {
    const result = await client.callTool({ name: "kb_sync_skill", arguments: args });
    if (result.isError || !result.structuredContent) throw new Error("Server did not return a verifiable Skill delta");
    const sync = result.structuredContent as Record<string, any>;
    if (manifest && manifest.skill_name !== sync.install?.skill_name) throw new Error("Target directory belongs to another deployment's Skill");
    const delta = sync.delta;
    if (!delta || !Array.isArray(delta.files) || delta.files.length > 8 || !Array.isArray(delta.remove_paths)) throw new Error("Invalid Skill delta");
    let total = 0;
    for (const file of delta.files) {
      if (!(managedPaths.has(file.path) || file.path === "skill-version.json") || typeof file.content !== "string" || digest(file.content) !== file.sha256 || Buffer.byteLength(file.content) !== file.size_bytes || (total += file.size_bytes) > 2 * 1024 * 1024) throw new Error("Unmanaged or invalid Skill file");
    }
    if (new Set(delta.files.map((file: any) => file.path)).size !== delta.files.length || delta.remove_paths.some((path: string) => !managedPaths.has(path) || !manifest?.files[path])) throw new Error("Invalid Skill changes");
    if (sync.status === "update_required") {
      const receivedManifest = delta.files.find((file: any) => file.path === "skill-version.json");
      if (!receivedManifest) throw new Error("Skill delta omitted its manifest");
      const next = JSON.parse(receivedManifest.content);
      if (next.skill_name !== sync.install.skill_name || next.version !== sync.target_version || next.bundle_sha256 !== delta.bundle_sha256 || digest(JSON.stringify(next.files)) !== next.bundle_sha256 || Object.keys(next.files).some(path => !managedPaths.has(path))) throw new Error("Skill manifest identity or bundle hash mismatch");
      for (const [path, expected] of Object.entries(next.files)) {
        const changed = delta.files.find((file: any) => file.path === path);
        const actual = changed ? changed.sha256 : installedFiles.find(file => file.path === path)?.sha256;
        if (actual !== expected) throw new Error("Skill delta does not reconstruct the claimed bundle");
      }
      const stage = join(target, `.sync-${randomUUID()}`); await mkdir(stage, { mode: 0o700 });
      try {
        for (const file of delta.files) { await mkdir(dirname(join(stage, file.path)), { recursive: true }); await writeFile(join(stage, file.path), file.content, { mode: 0o600 }); }
        for (const file of delta.files.filter((file: any) => file.path !== "skill-version.json")) {
          const destination = join(target, file.path);
          if (file.path.includes("/")) await safeDirectory(dirname(destination));
          const info = await lstat(destination).catch(error => { if (error.code === "ENOENT") return null; throw error; });
          if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Skill destination is not a regular file");
          await rename(join(stage, file.path), destination);
        }
        for (const path of delta.remove_paths) await rm(join(target, path), { force: true });
        await rename(join(stage, "skill-version.json"), manifestPath);
      } finally { await rm(stage, { recursive: true, force: true }); }
    }
    const installed = JSON.parse(await readFile(manifestPath, "utf8"));
    const files = await Promise.all(Object.keys(installed.files).map(async path => ({ path, sha256: digest(await readFile(join(target, path), "utf8")) })));
    const checked = await client.callTool({ name: "kb_sync_skill", arguments: { client: "generic", installed_version: installed.version, installed_files: files } });
    if (checked.isError || (checked.structuredContent as Record<string, unknown> | undefined)?.status !== "current") throw new Error("Installed Skill verification failed");
    return { directory: target, version: installed.version, status: "current", session_reload_required: sync.status === "update_required" };
  } finally { await client.close(); }
}

export async function clientDoctor(invitationPath: string) {
  const invite = await readInvitation(invitationPath), client = await clientConnection(invitationPath);
  try {
    const listed = await client.listTools();
    const brief = await client.callTool({ name: "kb_brief", arguments: { project_id: invite.project_id } });
    if (brief.isError) throw new Error("Project brief unavailable for this member");
    return { connected: true, project_id: invite.project_id, tools: listed.tools.map(tool => tool.name), project_available: Boolean((brief.structuredContent as Record<string, unknown> | undefined)?.project) };
  } finally { await client.close(); }
}
