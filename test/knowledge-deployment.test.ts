import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProjectRuntime } from "../src/project/runtime.js";
import { getMinerUCredentials } from "../src/doc-reading-config.js";
import { startLightweightProjectHttpServer, type LightweightProjectHttpHandle } from "../src/mcp/project-http-server.js";
import { atomicJson, configureProviders, deploymentClientRelease, initializeDeployment, issueMember, loadDeployment, revokeMember, validateDeployment, type Deployment } from "../src/project/deployment/config.js";
import { synchronizeClientSkill } from "../src/project/deployment/client.js";
import { runDeploymentMaintenance } from "../src/project/deployment/maintenance.js";
import { syncProjectSkill } from "../src/project/client-skill.js";

const roots: string[] = [], servers: LightweightProjectHttpHandle[] = [], clients: Client[] = [];
const environment = { ...process.env };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.allSettled(clients.splice(0).map(client => client.close()));
  await Promise.allSettled(servers.splice(0).map(server => server.stop()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
  Object.assign(process.env, environment);
});
async function fixture(mode: "local" | "cloud" = "local"): Promise<Deployment> {
  const parent = await mkdtemp(join(tmpdir(), "knowledge-deployment-")); roots.push(parent);
  return initializeDeployment({ directory: join(parent, "instance"), mode, name: "Synthetic knowledge", projectId: "project:test:shared", publicUrl: mode === "cloud" ? "https://kb.example.org/mcp" : undefined, cliPath: "dist/cli/knowledge.js" });
}
async function connect(endpoint: string, token: string): Promise<Client> {
  const client = new Client({ name: "synthetic-client", version: "1" }); clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })); return client;
}
const tool = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent as Record<string, any>;
};
const invitation = async (deployment: Deployment, id: string) => JSON.parse(await readFile(join(deployment.directory, "invitations", `${id}.json`), "utf8"));

describe("deployable personal and collaborative knowledge engine", () => {
  test("keeps library retrieval local when the host only inherited a provider key", async () => {
    const deployment = await fixture();
    vi.stubEnv("DASHSCOPE_API_KEY", "synthetic-inherited-key");
    vi.stubEnv("ARGON_MEMORY_QWEN_ENABLED", undefined);
    const fetch = vi.fn(() => { throw new Error("Unexpected external request"); });
    vi.stubGlobal("fetch", fetch);
    const runtime = new ProjectRuntime(deployment.root);
    try {
      const work = await runtime.startWork({ project_id: deployment.config.project.id, objective: "Synthetic local retrieval", actor: "test-owner", expected_outputs: ["note"], acceptance_criteria: ["no provider traffic"] });
      const artifact = await runtime.publishResource({ work_id: work.work_id, title: "Local evidence", filename: "local.md", content_type: "text/markdown", encoding: "utf8", content: "# Local\n\nprovider-free-cobalt-observation\n", kind: "note", actor: "test-owner" });
      const result = await runtime.queryEvidence({ query: "provider-free-cobalt-observation", project_id: deployment.config.project.id, mode: "hybrid" });
      expect(result.results.some(hit => hit.unit.artifact_id === artifact.artifact_id)).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally { runtime.close(); }
  });

  test("initializes a private one-owner local instance without copying project data", async () => {
    const deployment = await fixture();
    expect((await stat(deployment.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(deployment.registry)).mode & 0o777).toBe(0o600);
    const registry = JSON.parse(await readFile(deployment.registry, "utf8"));
    const invite = await invitation(deployment, "owner");
    expect(registry).toHaveLength(1); expect(registry[0]).toMatchObject({ profile: "project-resolve", roles: ["project-owner"] });
    expect(JSON.stringify(registry)).not.toContain(invite.token);
    await expect(issueMember(deployment, "alice", "contributor")).rejects.toThrow("one owner");
    await expect(initializeDeployment({ directory: deployment.directory, mode: "local", cliPath: "unused" })).rejects.toThrow();
    expect((await invitation(deployment, "owner")).token).toBe(invite.token);
    const runtime = new ProjectRuntime(deployment.root, { retrievalProvider: null });
    try { expect((await runtime.lookup("project", {}, 20)).map(record => record.id)).toEqual(["project:test:shared"]); } finally { runtime.close(); }
  });

  test("rejects public local listeners and credential-bearing cloud URLs", async () => {
    const deployment = await fixture();
    expect(() => validateDeployment({ ...deployment.config, server: { host: "0.0.0.0", port: 8793 } })).toThrow("loopback");
    for (const public_url of ["http://kb.example.org/mcp", "https://user:secret@kb.example.org/mcp", "https://kb.example.org/mcp?token=secret"]) expect(() => validateDeployment({ ...deployment.config, mode: "cloud", server: { ...deployment.config.server, public_url } })).toThrow();
  });

  test("disables inherited model keys and unrelated MinerU credential fallback", async () => {
    const deployment = await fixture();
    process.env.DASHSCOPE_API_KEY = process.env.MINERU_API_KEY = process.env.TYPESAFE_API_KEY = "synthetic-inherited-key";
    await configureProviders(deployment);
    expect(process.env.DASHSCOPE_API_KEY).toBeUndefined(); expect(process.env.TYPESAFE_API_KEY).toBeUndefined();
    expect(getMinerUCredentials()).toBeNull(); expect(process.env.ARGON_MEMORY_JEV_EGRESS_ALLOWED).toBe("false");
    await atomicJson(deployment.path, { ...deployment.config, providers: { ...deployment.config.providers, qwen: { enabled: true } } });
    await expect(configureProviders(await loadDeployment(deployment.path))).rejects.toThrow("DASHSCOPE_API_KEY is missing");
  });

  test("supplies a deployment-specific verified Skill and notice without hosted project defaults", async () => {
    const deployment = await fixture(), release = await deploymentClientRelease(deployment);
    const delta = syncProjectSkill({ client: "generic", installed_version: "none" }, release);
    const text = JSON.stringify(delta);
    expect(text).not.toContain("argonai.cn"); expect(text).not.toContain("project:argon:changyi-jiuan"); expect(text).not.toContain("长翼久安");
    expect(release.notice.notice_id).toBe("knowledge-architecture-v1");
    const hashes = release.files.map(file => ({ path: file.path, sha256: hash(file.content) }));
    expect(syncProjectSkill({ client: "generic", installed_version: release.version, installed_files: hashes }, release).status).toBe("current");
    const second = await fixture(); expect((await deploymentClientRelease(second)).name).not.toBe(release.name);
  });

  test("serializes member issuance and prevents removing the last owner", async () => {
    const deployment = await fixture("cloud");
    await Promise.all(Array.from({ length: 6 }, (_, index) => issueMember(deployment, `member${index}`, "contributor")));
    expect(JSON.parse(await readFile(deployment.registry, "utf8"))).toHaveLength(8);
    expect(await revokeMember(deployment, "member0")).toBe(true);
    await expect(revokeMember(deployment, "owner")).rejects.toThrow("last project owner");
  });

  test("uploads through personal stdio MCP and reads the original evidence", async () => {
    const deployment = await fixture();
    const client = new Client({ name: "personal-stdio", version: "1" }); clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/cli/knowledge.ts", "serve", "--config", deployment.path, "--stdio", "--no-workers"], stderr: "pipe" });
    await client.connect(transport);
    expect(client.getInstructions()).toContain("project:test:shared"); expect(client.getInstructions()).not.toContain("project:argon:");
    const listed = (await client.listTools()).tools.map(item => item.name);
    expect(listed).toContain("kb_submit_user_resolution"); expect(listed).not.toContain("kb_update_main");
    const work = await tool(client, "kb_start_work", { project_id: deployment.config.project.id, objective: "Synthetic personal evidence", expected_outputs: ["note"], acceptance_criteria: ["read original"] });
    const artifact = await tool(client, "kb_publish_resource", { work_id: work.work_id, resource: { title: "Local practice", filename: "local.md", content_type: "text/markdown", content: "# Local evidence\n\n个人现场实践记录：使用原始文件核验结论。\n", kind: "note" } });
    const raw = await client.readResource({ uri: artifact.raw_resource_uri }); expect(raw.contents.length).toBe(1);
    const hits = await tool(client, "kb_search", { query: "现场实践", project_id: deployment.config.project.id, modality: "text", mode: "lexical" });
    expect(hits.results.some((hit: any) => hit.artifact_id === artifact.artifact_id)).toBe(true);
    const restricted = await tool(client, "kb_publish_resource", { work_id: work.work_id, resource: { title: "Personal restricted evidence", filename: "private.md", content_type: "text/markdown", content: "# Restricted\n\npersonal-private-evidence-314159\n", kind: "note", confidentiality: "restricted" } });
    const privateHits = await tool(client, "kb_search", { query: "personal-private-evidence-314159", project_id: deployment.config.project.id, modality: "text", mode: "lexical" });
    expect(privateHits.results.some((hit: any) => hit.artifact_id === restricted.artifact_id)).toBe(true);
    expect((await client.readResource({ uri: restricted.raw_resource_uri })).contents).toHaveLength(1);
  }, 20_000);

  test("supports concurrent contributions, exhaustive indexed pages, pixels, maintenance and immediate revocation", async () => {
    const deployment = await fixture("cloud"); await configureProviders(deployment);
    await issueMember(deployment, "alice", "contributor"); await issueMember(deployment, "bob", "reader");
    const release = await deploymentClientRelease(deployment);
    const server = await startLightweightProjectHttpServer({ host: "127.0.0.1", port: 0, projectDataDir: deployment.root, projectProfile: "project-contribute", principalRegistryPath: deployment.registry, bearerToken: "", principalRegistryJson: "[]", quiet: true,
      identity: { name: deployment.config.project.name, project_id: deployment.config.project.id }, clientRelease: release, allowedOrigins: ["https://kb.example.org"] }); servers.push(server);
    const endpoint = `http://127.0.0.1:${server.port}/mcp`;
    const ownerInvite = await invitation(deployment, "owner"), aliceInvite = await invitation(deployment, "alice"), bobInvite = await invitation(deployment, "bob");
    const owner = await connect(endpoint, ownerInvite.token), alice = await connect(endpoint, aliceInvite.token), bob = await connect(endpoint, bobInvite.token);
    const names = async (client: Client) => (await client.listTools()).tools.map(item => item.name);
    expect(await names(owner)).toContain("kb_submit_user_resolution");
    expect(await names(alice)).not.toContain("kb_submit_user_resolution"); expect(await names(alice)).not.toContain("kb_maintain");
    expect(await names(bob)).not.toContain("kb_start_work");
    const workArgs = { project_id: deployment.config.project.id, objective: "Synthetic collaborative practice", expected_outputs: ["evidence"], acceptance_criteria: ["complete pages"] };
    const [ownWork, aliceWork] = await Promise.all([tool(owner, "kb_start_work", workArgs), tool(alice, "kb_start_work", workArgs)]);
    const artifacts = await Promise.all(Array.from({ length: 4 }, (_, index) => tool(index % 2 ? alice : owner, "kb_publish_resource", { work_id: index % 2 ? aliceWork.work_id : ownWork.work_id,
      resource: { title: `Practice ${index}`, filename: `practice-${index}.md`, content_type: "text/markdown", content: `# 现场实践 ${index}\n\n这份独立资料记录现场实践步骤 ${index}，使用传感器 ${index} 校核现场数据。\n`, kind: "document" } })));
    const found = new Set(); let args: Record<string, unknown> = { project_id: deployment.config.project.id, query: "现场实践", modality: "text", mode: "lexical", intent: "collect", top_k: 1 };
    for (let page = 0; page < 30; page++) {
      const result = await tool(bob, "kb_search", args); for (const hit of result.results) if (hit.artifact_id) found.add(hit.artifact_id);
      if (!result.next_cursor) break; args = { ...args, cursor: result.next_cursor };
    }
    for (const artifact of artifacts) expect(found.has(artifact.artifact_id)).toBe(true);
    const restricted = await tool(alice, "kb_publish_resource", { work_id: aliceWork.work_id, resource: { title: "Cloud restricted evidence", filename: "private.md", content_type: "text/markdown", content: "# Restricted\n\ncloud-private-evidence-314159\n", kind: "note", confidentiality: "restricted" } });
    for (const member of [owner, alice, bob]) {
      const privateHits = await tool(member, "kb_search", { query: "cloud-private-evidence-314159", project_id: deployment.config.project.id, modality: "text", mode: "lexical" });
      expect(privateHits.results.some((hit: any) => hit.artifact_id === restricted.artifact_id)).toBe(false);
    }
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    await tool(alice, "kb_publish_resource", { work_id: aliceWork.work_id, resource: { title: "合照 synthetic pixels", filename: "合照.png", content_type: "image/png", content: png, encoding: "base64", kind: "image" } });
    const images = await tool(bob, "kb_search", { query: "合照", project_id: deployment.config.project.id, modality: "image", mode: "lexical", include_images: false });
    expect(images.results.length).toBeGreaterThan(0);
    const pixels = await bob.callTool({ name: "kb_read", arguments: { resource_id: images.results[0].evidence_uri } });
    expect((pixels.content as Array<any>).some(block => block.type === "image" && block.data === png)).toBe(true);
    const id = hash("synthetic-same-computer"); expect((await tool(owner, "kb_client_notice", { device_id: id })).display).toBe(true);
    expect((await tool(alice, "kb_client_notice", { device_id: id })).display).toBe(false);
    const runtime = new ProjectRuntime(deployment.root, { retrievalProvider: null });
    try {
      const before = (await runtime.revisionStore.pointer())!.knowledge_revision;
      const result = await runDeploymentMaintenance(runtime, deployment, { once: true }); expect(result.failed).toBe(0); expect(result.completed).toBeGreaterThan(0);
      expect((await runtime.revisionStore.pointer())!.knowledge_revision).not.toBe(before);
      const brief = await runtime.brief(deployment.config.project.id); expect((brief.navigation as any).sections.length).toBe(4);
    } finally { runtime.close(); }
    const clientInvite = join(deployment.directory, "test-client-invite.json"); await atomicJson(clientInvite, { ...bobInvite, endpoint });
    const skillDir = join(deployment.directory, "test-client-skill"); expect((await synchronizeClientSkill(clientInvite, skillDir)).status).toBe("current");
    await writeFile(join(skillDir, "references/workflow.md"), "damaged");
    expect((await synchronizeClientSkill(clientInvite, skillDir)).status).toBe("current");
    expect(await readFile(join(skillDir, "references/workflow.md"), "utf8")).toContain("Canonical knowledge");
    const badOrigin = await fetch(endpoint, { method: "POST", headers: { origin: "https://attacker.example", authorization: `Bearer ${bobInvite.token}` }, body: "{}" }); expect(badOrigin.status).toBe(403);
    await revokeMember(deployment, "alice"); await expect(alice.listTools()).rejects.toThrow();
    expect((await tool(bob, "kb_brief", { project_id: deployment.config.project.id })).project).toBeTruthy();
    // Downgrade the same authenticated principal: an old owner session must
    // not keep the resolution tools it received before the role change.
    const registry = JSON.parse(await readFile(deployment.registry, "utf8"));
    await atomicJson(deployment.registry, registry.map((entry: any) => entry.principal_id === "owner" ? { ...entry, profile: "project-read", roles: [] } : entry));
    await expect(owner.listTools()).rejects.toThrow();
    const downgraded = await connect(endpoint, ownerInvite.token); expect(await names(downgraded)).not.toContain("kb_submit_user_resolution");
  }, 30_000);
});
