import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { z } from "zod";
import { ProjectRuntime } from "../runtime.js";
import { tokenSha256, parsePrincipalRegistry } from "../principals.js";
import { createProjectClientRelease, PROJECT_MCP_SERVER_VERSION, syncProjectSkill } from "../client-skill.js";

export const deploymentSchema = z.object({
  schema: z.literal("knowledge-engine-deployment/v1"),
  instance_id: z.string().uuid(), mode: z.enum(["local", "cloud"]),
  project: z.object({ id: z.string().regex(/^project:[a-zA-Z0-9:._-]+$/), name: z.string().min(2).max(100), mission: z.string().min(3).max(2000) }),
  data_dir: z.string().min(1),
  server: z.object({ host: z.string().default("127.0.0.1"), port: z.number().int().min(1).max(65535).default(8793), public_url: z.string().optional() }),
  providers: z.object({
    qwen: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
    mineru: z.object({ enabled: z.boolean().default(false), ocr_scanned: z.boolean().default(false) }).default({ enabled: false, ocr_scanned: false }),
    jev: z.object({ mode: z.enum(["off", "shadow", "advisory"]).default("off") }).default({ mode: "off" }),
  }),
  maintenance: z.object({ mode: z.enum(["catalog", "qwen"]).default("catalog"), model: z.string().default("qwen3.7-flash") }),
});
export type DeploymentConfig = z.infer<typeof deploymentSchema>;
export type Deployment = { path: string; directory: string; root: string; registry: string; config: DeploymentConfig };
export type MemberRole = "reader" | "contributor" | "owner" | "operator";
const roleProfile = { reader: "project-read", contributor: "project-contribute", owner: "project-resolve", operator: "project-ops" } as const;
const SECRET_KEYS = new Set(["DASHSCOPE_API_KEY", "MINERU_API_KEY", "TYPESAFE_API_KEY", "ARGON_MEMORY_PYTHON_BIN", "ARGON_MEMORY_MAINTENANCE_PYTHON", "ARGON_MEMORY_TEXT_EMBEDDING_MODEL", "ARGON_MEMORY_IMAGE_EMBEDDING_MODEL", "ARGON_MEMORY_TEXT_RERANK_MODEL", "ARGON_MEMORY_IMAGE_RERANK_MODEL", "ARGON_MEMORY_EMBEDDING_DIMENSION"]);

export function validateDeployment(value: unknown): DeploymentConfig {
  const config = deploymentSchema.parse(value);
  if (config.mode === "local" && !["127.0.0.1", "::1", "localhost"].includes(config.server.host)) throw new Error("Local mode must bind loopback");
  if (config.mode === "cloud") {
    if (!config.server.public_url) throw new Error("Cloud mode requires a public HTTPS /mcp URL");
    const url = new URL(config.server.public_url);
    if (url.protocol !== "https:" || !url.pathname.endsWith("/mcp") || url.username || url.password || url.search || url.hash) throw new Error("Cloud MCP URL must be HTTPS, end in /mcp and contain no credentials, query or fragment");
  }
  if (config.providers.mineru.ocr_scanned && !config.providers.mineru.enabled) throw new Error("OCR requires the explicitly enabled MinerU provider");
  if (config.maintenance.mode === "qwen" && !config.providers.qwen.enabled) throw new Error("Qwen maintenance requires the enabled Qwen provider");
  return config;
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, path); } finally { await rm(temp, { force: true }); }
}

export async function loadDeployment(path: string): Promise<Deployment> {
  const absolute = resolve(path), directory = dirname(absolute);
  const config = validateDeployment(JSON.parse(await readFile(absolute, "utf8")));
  return { path: absolute, directory, root: resolve(directory, config.data_dir), registry: join(directory, "principals.json"), config };
}

/** No inherited unrelated provider credential may activate external traffic. */
export async function configureProviders(deployment: Deployment): Promise<void> {
  const secrets = await readFile(join(deployment.directory, "secrets.env"), "utf8").catch(error => {
    if (error.code === "ENOENT") return ""; throw error;
  });
  const variables = parseEnv(secrets);
  if (Object.keys(variables).some(key => !SECRET_KEYS.has(key))) throw new Error("secrets.env contains an unsupported variable");
  for (const [key, value] of Object.entries(variables)) process.env[key] = value;
  const { providers, maintenance } = deployment.config;
  process.env.ARGON_MEMORY_QWEN_ENABLED = String(providers.qwen.enabled);
  if (!providers.qwen.enabled) delete process.env.DASHSCOPE_API_KEY;
  else if (!process.env.DASHSCOPE_API_KEY?.trim()) throw new Error("Qwen is enabled but DASHSCOPE_API_KEY is missing");
  process.env.ARGON_MEMORY_MINERU_ENV_ONLY = "true";
  process.env.ARGON_MEMORY_MINERU_DISABLED = String(!providers.mineru.enabled);
  if (!providers.mineru.enabled) delete process.env.MINERU_API_KEY;
  else if (!process.env.MINERU_API_KEY?.trim()) throw new Error("MinerU is enabled but MINERU_API_KEY is missing");
  process.env.ARGON_MEMORY_JEV_MODE = providers.jev.mode;
  process.env.ARGON_MEMORY_JEV_EGRESS_ALLOWED = String(providers.jev.mode !== "off");
  if (providers.jev.mode === "off") delete process.env.TYPESAFE_API_KEY;
  else if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error("Jev is enabled but TYPESAFE_API_KEY is missing");
  process.env.ARGON_MEMORY_MAINTENANCE_MODE = maintenance.mode === "qwen" ? "live" : "catalog";
  process.env.ARGON_MEMORY_KB_ROOT = deployment.root;
  // The standalone mode does not expose this application's runner import.
  delete process.env.ARGON_MEMORY_RUNNER_EXPORT_ROOT; delete process.env.ARGON_MEMORY_RUNNER_IMPORT_SECRET;
}

export const SKILL_PATHS = ["SKILL.md", "agents/openai.yaml", "references/workflow.md", "scripts/client-device.mjs", "scripts/device-core.mjs"];
export async function deploymentClientRelease(deployment: Deployment) {
  const templates = fileURLToPath(new URL("../../../skills/argon-memory/", import.meta.url));
  const skillName = `argon-memory-${deployment.config.instance_id.slice(0, 8)}`;
  const noticeId = "knowledge-architecture-v1";
  const files = await Promise.all(SKILL_PATHS.map(async path => ({ path, content: (await readFile(join(templates, path), "utf8")).replace("name: argon-memory", `name: ${skillName}`) })));
  files.push({ path: "deployment.json", content: JSON.stringify({ schema: "knowledge-engine-client/v1", instance_id: deployment.config.instance_id, project_id: deployment.config.project.id, notice_id: noticeId }, null, 2) + "\n" });
  return createProjectClientRelease({ name: skillName, version: PROJECT_MCP_SERVER_VERSION, server_version: PROJECT_MCP_SERVER_VERSION, files,
    notice: { notice_id: noticeId, message: `${deployment.config.project.name}采用结构化导航、全局文本与图片检索、可追溯证据和异步维护。主文件帮助理解全貌，RAG 跨资料寻找依据，并提供续页、原图和覆盖缺口。Jev 可为后台提供章节关联建议；整理方案通过来源、版本和冲突校验后提交。外部模型仅在部署者启用相应服务后使用。这条介绍在同一电脑、同一部署只提示一次。` },
  });
}

export async function exportDeploymentSkill(deployment: Deployment, target = join(deployment.directory, "client-skill")): Promise<string> {
  const release = await deploymentClientRelease(deployment);
  const delta = syncProjectSkill({ client: "generic", installed_version: "none" }, release).delta;
  for (const file of delta.files) { const path = join(target, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.content); }
  return target;
}

async function registryLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const lockPath = path + ".lock";
  let handle;
  for (let attempt = 0; attempt < 300; attempt++) {
    handle = await open(lockPath, "wx", 0o600).catch(error => { if (error.code === "EEXIST") return null; throw error; });
    if (handle) break;
    await new Promise(done => setTimeout(done, 10));
  }
  if (!handle) throw new Error("Another member-management operation is in progress");
  try { return await action(); } finally { await handle.close(); await rm(lockPath, { force: true }); }
}

export async function issueMember(deployment: Deployment, id: string, role: MemberRole, output?: string): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(id) || !(role in roleProfile)) throw new Error("Invalid member ID or role");
  if (deployment.config.mode === "local" && (id !== "owner" || role !== "owner")) throw new Error("Local deployment has one owner; switch to cloud mode to collaborate");
  const invitationPath = resolve(output ?? join(deployment.directory, "invitations", `${id}.json`));
  return registryLock(deployment.registry, async () => {
    const registry = parsePrincipalRegistry(await readFile(deployment.registry, "utf8"));
    if (registry.some(entry => entry.principal_id === id)) throw new Error("Member already exists; revoke before issuing a replacement");
    if (await stat(invitationPath).catch(error => { if (error.code === "ENOENT") return null; throw error; })) throw new Error("Invitation output already exists");
    const token = randomBytes(32).toString("base64url");
    const endpoint = deployment.config.mode === "cloud" ? deployment.config.server.public_url! : `http://${deployment.config.server.host === "::1" ? "[::1]" : deployment.config.server.host}:${deployment.config.server.port}/mcp`;
    await atomicJson(invitationPath, { schema: "knowledge-engine-invitation/v1", endpoint, project_id: deployment.config.project.id, principal_id: id, profile: roleProfile[role], token });
    try { await atomicJson(deployment.registry, [...registry, { token_sha256: tokenSha256(token), principal_id: id, profile: roleProfile[role], roles: role === "owner" ? ["project-owner"] : [] }]); }
    catch (error) { await rm(invitationPath, { force: true }); throw error; }
    return invitationPath;
  });
}

export async function revokeMember(deployment: Deployment, id: string): Promise<boolean> {
  if (deployment.config.mode !== "cloud") throw new Error("Local deployment has no distributed members");
  return registryLock(deployment.registry, async () => {
    const registry = parsePrincipalRegistry(await readFile(deployment.registry, "utf8"));
    const next = registry.filter(entry => entry.principal_id !== id);
    if (next.length === registry.length) return false;
    if (!next.some(entry => entry.profile === "project-resolve" && entry.roles.includes("project-owner"))) throw new Error("Cannot revoke the last project owner");
    await atomicJson(deployment.registry, next); return true;
  });
}

export async function initializeDeployment(input: { directory: string; mode: "local" | "cloud"; name?: string; projectId?: string; publicUrl?: string; cliPath: string; port?: number }): Promise<Deployment> {
  const directory = resolve(input.directory);
  const config = validateDeployment({ schema: "knowledge-engine-deployment/v1", instance_id: randomUUID(), mode: input.mode,
    project: { id: input.projectId ?? `project:kb:${input.mode}`, name: input.name ?? "My knowledge base", mission: "Preserve sources, retrieve evidence and maintain project knowledge." }, data_dir: "./data",
    server: { host: "127.0.0.1", port: input.port ?? 8793, ...(input.publicUrl ? { public_url: input.publicUrl } : {}) },
    providers: { qwen: { enabled: false }, mineru: { enabled: false, ocr_scanned: false }, jev: { mode: "off" } }, maintenance: { mode: "catalog", model: "qwen3.7-flash" },
  });
  await mkdir(directory, { recursive: false, mode: 0o700 });
  await chmod(directory, 0o700);
  await atomicJson(join(directory, "knowledge.config.json"), config);
  await atomicJson(join(directory, "principals.json"), []);
  await writeFile(join(directory, "secrets.env"), "# Enable selected providers in knowledge.config.json, then supply your own keys.\n# DASHSCOPE_API_KEY=\n# MINERU_API_KEY=\n# TYPESAFE_API_KEY=\n", { mode: 0o600, flag: "wx" });
  await writeFile(join(directory, ".gitignore"), "*\n!.gitignore\n");
  const deployment = await loadDeployment(join(directory, "knowledge.config.json"));
  const runtime = new ProjectRuntime(deployment.root, { retrievalProvider: null });
  try { await runtime.initialize(); await runtime.bootstrapProject({ project_id: config.project.id, title: config.project.name, mission: config.project.mission, actor: "deployment-owner" }); } finally { runtime.close(); }
  const invitation = await issueMember(deployment, "owner", "owner");
  const endpoint = JSON.parse(await readFile(invitation, "utf8"));
  await atomicJson(join(directory, "mcp.http.json"), { mcpServers: { knowledge: { url: endpoint.endpoint, headers: { Authorization: `Bearer ${endpoint.token}` } } } });
  if (config.mode === "local") await atomicJson(join(directory, "mcp.stdio.json"), { mcpServers: { knowledge: { command: process.execPath, args: [resolve(input.cliPath), "serve", "--config", deployment.path, "--stdio"] } } });
  else await issueMember(deployment, "operator", "operator");
  await exportDeploymentSkill(deployment);
  return deployment;
}
