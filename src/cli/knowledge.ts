#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLightweightProjectServer, startLightweightProjectHttpServer } from "../mcp/project-http-server.js";
import { ProjectRuntime } from "../project/runtime.js";
import { parsePrincipalRegistry } from "../project/principals.js";
import { RetrievalBackfill } from "../project/retrieval/backfill.js";
import { atomicJson, configureProviders, deploymentClientRelease, exportDeploymentSkill, initializeDeployment, issueMember, loadDeployment, revokeMember, validateDeployment, type Deployment, type MemberRole } from "../project/deployment/config.js";
import { runDeploymentMaintenance } from "../project/deployment/maintenance.js";
import { clientDoctor, configureClient, synchronizeClientSkill } from "../project/deployment/client.js";

const cliPath = fileURLToPath(import.meta.url);
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: "string" }, dir: { type: "string" }, name: { type: "string" }, "project-id": { type: "string" }, "public-url": { type: "string" }, port: { type: "string" },
  stdio: { type: "boolean" }, http: { type: "boolean" }, "no-workers": { type: "boolean" }, once: { type: "boolean" }, "lexical-only": { type: "boolean" },
  id: { type: "string" }, role: { type: "string" }, out: { type: "string" }, invite: { type: "string" }, help: { type: "boolean" },
  qwen: { type: "string" }, mineru: { type: "string" }, ocr: { type: "string" }, jev: { type: "string" }, maintenance: { type: "string" },
} });
const [command = "help", action] = positionals;
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
const abort = new AbortController();
const children: ChildProcess[] = [];
let shutdown: (() => Promise<void>) | undefined;
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true; abort.abort();
  for (const child of children) child.kill("SIGTERM");
  if (shutdown) await shutdown();
  await Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise<void>(done => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, 3000); child.once("exit", () => { clearTimeout(timer); done(); });
  })));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void stop());

function startWorkers(deployment: Deployment) {
  if (values["no-workers"]) return;
  for (const childCommand of ["indexer", "maintainer"]) {
    const child = spawn(process.execPath, [...process.execArgv, cliPath, childCommand, "--config", deployment.path], { stdio: ["ignore", "ignore", "inherit"] });
    children.push(child);
    child.once("exit", code => { if (!stopping) { console.error(JSON.stringify({ event: "worker_exited", worker: childCommand, code })); process.exitCode = 1; void stop(); } });
  }
}

async function main() {
  if (command === "help" || values.help) {
    print({ commands: ["init local --dir ./my-kb", "init cloud --dir ./team-kb --public-url https://kb.example.org/mcp", "serve --config ./my-kb/knowledge.config.json [--stdio|--http]", "indexer --config PATH [--once]", "maintainer --config PATH [--once]", "member issue --config PATH --id alice --role contributor --out alice.json", "member revoke --config PATH --id alice", "member list --config PATH", "skill export --config PATH [--out DIR]", "client configure --invite alice.json --out mcp.json", "client skill --invite alice.json --out /confirmed/skill-directory", "client doctor --invite alice.json", "status --config PATH"] }); return;
  }
  if (command === "client") {
    if (!values.invite) throw new Error("client requires --invite");
    if (action === "doctor") print(await clientDoctor(values.invite));
    else if (action === "configure" && values.out) print({ mcp_config: await configureClient(values.invite, values.out) });
    else if (action === "skill" && values.out) print(await synchronizeClientSkill(values.invite, values.out));
    else throw new Error("client configure|skill requires an explicit --out directory or file"); return;
  }
  if (command === "init") {
    if (!values.dir || !["local", "cloud"].includes(action ?? "")) throw new Error("init requires local|cloud and --dir NEW_DIRECTORY");
    const deployment = await initializeDeployment({ directory: values.dir, mode: action as "local" | "cloud", name: values.name, projectId: values["project-id"], publicUrl: values["public-url"], port: values.port ? Number(values.port) : undefined, cliPath });
    print({ mode: deployment.config.mode, config: deployment.path, owner_invitation: resolve(deployment.directory, "invitations/owner.json"), client_skill: resolve(deployment.directory, "client-skill"), mcp_config: resolve(deployment.directory, deployment.config.mode === "local" ? "mcp.stdio.json" : "mcp.http.json"), providers: "disabled; enable explicitly in config" }); return;
  }
  const deployment = await loadDeployment(values.config ?? process.env.KB_CONFIG ?? "knowledge.config.json");
  if (command === "config" && action === "providers") {
    const next = structuredClone(deployment.config);
    for (const key of ["qwen", "mineru"] as const) if (values[key] !== undefined) {
      if (!["on", "off"].includes(values[key]!)) throw new Error(`${key} expects on|off`);
      next.providers[key].enabled = values[key] === "on";
    }
    if (values.ocr !== undefined) { if (!["on", "off"].includes(values.ocr)) throw new Error("ocr expects on|off"); next.providers.mineru.ocr_scanned = values.ocr === "on"; }
    if (values.jev !== undefined) next.providers.jev.mode = values.jev as typeof next.providers.jev.mode;
    if (values.maintenance !== undefined) next.maintenance.mode = values.maintenance as typeof next.maintenance.mode;
    await atomicJson(deployment.path, validateDeployment(next));
    print({ providers: next.providers, maintenance: next.maintenance, restart_services: true }); return;
  }
  if (command === "member") {
    if (action === "list") {
      const principals = parsePrincipalRegistry(await readFile(deployment.registry, "utf8")); print(principals.map(({ principal_id, profile, roles }) => ({ principal_id, profile, roles }))); return;
    }
    if (!values.id) throw new Error("member issue|revoke requires --id");
    if (action === "issue") print({ invitation: await issueMember(deployment, values.id, (values.role ?? "contributor") as MemberRole, values.out) });
    else if (action === "revoke") print({ revoked: await revokeMember(deployment, values.id), effective: "immediate, including existing HTTP sessions" });
    else throw new Error("Unknown member operation"); return;
  }
  if (command === "skill" && action === "export") { print({ client_skill: await exportDeploymentSkill(deployment, values.out ? resolve(values.out) : undefined) }); return; }
  if (!["serve", "indexer", "maintainer", "status"].includes(command)) throw new Error("Unknown command; use help");
  await configureProviders(deployment);
  const identity = { name: deployment.config.project.name, project_id: deployment.config.project.id };
  if (command === "serve") {
    const release = await deploymentClientRelease(deployment);
    const stdio = values.stdio || (!values.http && deployment.config.mode === "local");
    if (values.stdio && values.http) throw new Error("Choose stdio or HTTP");
    if (stdio && deployment.config.mode !== "local") throw new Error("Cloud deployments use authenticated HTTP");
    if (stdio) {
      const runtime = new ProjectRuntime(deployment.root); await runtime.initialize();
      const server = createLightweightProjectServer(runtime, { principal_id: "owner", profile: "project-resolve", roles: ["project-owner"] }, { identity, clientRelease: release, personalOwner: true });
      shutdown = async () => { await server.close(); runtime.close(); };
      const transport = new StdioServerTransport(); await server.connect(transport);
      const close = transport.onclose; transport.onclose = () => { close?.(); void stop(); };
      startWorkers(deployment); return;
    }
    // Container port publishing is separately restricted in the local Compose
    // definition; native local mode still binds loopback by default.
    const host = process.env.KB_CONTAINER_LISTEN === "true" ? "0.0.0.0" : deployment.config.server.host;
    const allowedOrigins = deployment.config.mode === "cloud" ? [new URL(deployment.config.server.public_url!).origin] : [`http://127.0.0.1:${deployment.config.server.port}`, `http://localhost:${deployment.config.server.port}`, `http://[::1]:${deployment.config.server.port}`];
    const server = await startLightweightProjectHttpServer({ host, port: deployment.config.server.port, projectDataDir: deployment.root,
      projectProfile: "project-contribute", bearerToken: "", principalRegistryJson: "[]", principalRegistryPath: deployment.registry, allowUnauthenticated: false, identity, clientRelease: release, allowedOrigins, personalOwner: deployment.config.mode === "local" });
    shutdown = server.stop; startWorkers(deployment); return;
  }
  const runtime = new ProjectRuntime(deployment.root); await runtime.initialize();
  shutdown = async () => runtime.close();
  try {
    if (command === "status") { print({ mode: deployment.config.mode, project_id: deployment.config.project.id, providers: deployment.config.providers, maintenance: deployment.config.maintenance.mode, coverage: await runtime.retrievalCoverage(deployment.config.project.id) }); return; }
    if (command === "maintainer") { const result = await runDeploymentMaintenance(runtime, deployment, { once: values.once, signal: abort.signal }); if (result.failed && values.once) process.exitCode = 1; return; }
    const backfill = new RetrievalBackfill(event => console.error(JSON.stringify(event)));
    let lastRevision = "";
    do {
      try {
        const normalization = await backfill.run(runtime, { normalize: true, ocr: deployment.config.providers.mineru.ocr_scanned, once: Boolean(values.once), forceNormalize: false, queueMaintenance: true });
        const corpus = await runtime.evidenceCorpus();
        if (values.once || corpus.revision !== lastRevision) {
          const embed = deployment.config.providers.qwen.enabled && !values["lexical-only"];
          const index = await runtime.rebuildRetrieval(embed);
          console.error(JSON.stringify({ event: "retrieval_index", ...index }));
          if (!embed || (Number(index.text_embedded_units) >= Number(index.text_embedding_eligible_units) && Number(index.image_embedded_units) >= Number(index.image_units) - (Array.isArray(index.unsupported_image_formats) ? index.unsupported_image_formats.length : 0))) lastRevision = corpus.revision;
        }
        if (normalization.failed && values.once) process.exitCode = 1;
      } catch (error) { console.error(JSON.stringify({ event: "indexer_failed", message: error instanceof Error ? error.message : "Indexer failed" })); if (values.once) process.exitCode = 1; }
      if (!values.once && !abort.signal.aborted) await delay(30_000, undefined, { signal: abort.signal }).catch(() => undefined);
    } while (!values.once && !abort.signal.aborted);
  } finally { runtime.close(); }
}

try { await main(); }
catch (error) {
  // Validation paths explain bad config; do not print model bodies or env values.
  console.error(error instanceof Error ? error.message : "Knowledge engine failed"); process.exitCode = 1; await stop();
}
