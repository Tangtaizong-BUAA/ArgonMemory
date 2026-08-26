import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { PROJECT_MCP_SERVER_VERSION } from "../client-skill.js";
import { ProjectRuntime, resolveProjectProfile, resolveProjectRoot, type ProjectProfile } from "../runtime.js";
import { authenticatePrincipal, canResolveConflicts, parsePrincipalRegistry, type ProjectPrincipal } from "../principals.js";
import { installProjectToolVersioning } from "./versioning.js";
import { registerLightweightProjectResource } from "./resource.js";
import { registerProjectTools } from "./tools.js";

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_REQUEST_BYTES = 14 * 1024 * 1024;

type ProjectServerProfile = Exclude<ProjectProfile, "upstream-full">;
type Session = { transport: WebStandardStreamableHTTPServerTransport; lastSeenAt: number; principal: ProjectPrincipal };

export type ArgonMemoryServerOptions = {
  host?: string;
  port?: number;
  projectProfile?: ProjectServerProfile;
  projectDataDir?: string;
  bearerToken?: string;
  allowUnauthenticated?: boolean;
  quiet?: boolean;
  sessionTtlMs?: number;
  maxRequestBytes?: number;
  principalRegistryJson?: string;
};

export type ArgonMemoryServerHandle = {
  host: string;
  port: number;
  stop: () => Promise<void>;
};

function projectInstructions(): string {
  return [
    "Argon Memory project knowledge base.",
    "Call kb_sync_skill first in every task, then kb_brief for the complete maintained main file.",
    "Use kb_graph_context for selected sections and linked artifacts, and kb_search proactively for verifiable details.",
    "Start material work with kb_start_work, persist durable resources and distilled context, then close with kb_finish_work.",
    "The server governs evidence, memory promotion, versions, and write permissions.",
  ].join("\n");
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

function requestHeaders(req: IncomingMessage): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") output[name] = value;
    else if (Array.isArray(value)) output[name] = value.join(", ");
  }
  return output;
}

async function collectBody(req: IncomingMessage, maximumBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumBytes) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startArgonMemoryServer(
  options: ArgonMemoryServerOptions,
): Promise<ArgonMemoryServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8793;
  const profile = resolveProjectProfile(options.projectProfile ?? process.env.ARGON_MEMORY_MCP_PROFILE);
  if (profile === "upstream-full") throw new Error("The lightweight server accepts only project profiles");
  const projectRoot = resolveProjectRoot(options.projectDataDir ?? process.env.ARGON_MEMORY_KB_ROOT);
  if (!projectRoot) throw new Error("ARGON_MEMORY_KB_ROOT or projectDataDir is required");
  const bearerToken = options.bearerToken ?? process.env.ARGON_MEMORY_MCP_BEARER_TOKEN ?? "";
  const principalRegistry = parsePrincipalRegistry(options.principalRegistryJson ?? process.env.ARGON_MEMORY_MCP_PRINCIPALS_JSON);
  if (!bearerToken && principalRegistry.length === 0 && !options.allowUnauthenticated) throw new Error("ARGON_MEMORY_MCP_BEARER_TOKEN or ARGON_MEMORY_MCP_PRINCIPALS_JSON is required unless unauthenticated mode is explicitly enabled");

  const sessionTtlMs = Math.max(60_000, options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS);
  const maximumBytes = Math.max(64 * 1024, options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES);
  const runtime = new ProjectRuntime(projectRoot);
  await runtime.initialize();
  const sessions = new Map<string, Session>();
  const startedAt = Date.now();

  async function createSession(principal: ProjectPrincipal): Promise<WebStandardStreamableHTTPServerTransport> {
    let transport: WebStandardStreamableHTTPServerTransport;
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (sessionId: string) => {
        sessions.set(sessionId, { transport, lastSeenAt: Date.now(), principal });
      },
    });
    const server = new McpServer(
      { name: "argon-memory", version: PROJECT_MCP_SERVER_VERSION },
      { instructions: projectInstructions() },
    );
    installProjectToolVersioning(server);
    registerLightweightProjectResource(server, runtime, principal.profile);
    registerProjectTools(server, runtime, principal.profile, principal.principal_id);
    await server.connect(transport);
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    return transport;
  }

  const httpServer = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
    try {
      if (pathname === "/health" && req.method === "GET") {
        const usage = process.memoryUsage();
        json(res, 200, {
          status: "ok",
          role: profile,
          version: PROJECT_MCP_SERVER_VERSION,
          uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
          sessions: sessions.size,
          rss_mb: Number((usage.rss / 1048576).toFixed(1)),
        });
        return;
      }
      if (pathname !== "/mcp") {
        json(res, 404, { error: "Not found" });
        return;
      }
      // This endpoint returns each JSON-RPC result directly from the POST that
      // initiated it.  It deliberately does not offer an inbound SSE stream.
      // A 405 is the Streamable HTTP MCP signal for an optional SSE channel
      // that is unavailable; AI SDK clients then keep the healthy POST session
      // instead of treating a 400 response as a transport failure and retrying
      // the same tool call.
      if (req.method === "GET" || req.method === "HEAD") {
        res.writeHead(405, { allow: "POST, DELETE" });
        res.end();
        return;
      }
      const suppliedToken = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
      const registeredPrincipal = suppliedToken && principalRegistry.length ? authenticatePrincipal(suppliedToken, principalRegistry) : null;
      const legacyAuthorized = bearerToken && suppliedToken === bearerToken;
      if (!registeredPrincipal && !legacyAuthorized && !options.allowUnauthenticated) {
        json(res, 401, { error: "Missing or invalid MCP bearer token" }, { "www-authenticate": "Bearer" });
        return;
      }
      const requestPrincipal: ProjectPrincipal = registeredPrincipal ?? { principal_id: legacyAuthorized ? "team-shared" : "unauthenticated-local", profile: profile as ProjectServerProfile, roles: [] };
      if (requestPrincipal.profile === "project-resolve" && !canResolveConflicts(requestPrincipal)) {
        json(res, 403, { error: "project-resolve requires project-owner or designated-resolver role" });
        return;
      }

      const headers = requestHeaders(req);
      const sessionId = headers["mcp-session-id"];
      if (req.method === "POST") {
        const rawBody = await collectBody(req, maximumBytes);
        const body = JSON.parse(rawBody) as { id?: unknown; method?: string };
        const requestId = body.id ?? null;
        let transport: WebStandardStreamableHTTPServerTransport | undefined;
        if (sessionId) {
          const session = sessions.get(sessionId);
          if (session) {
            if (session.principal.principal_id !== requestPrincipal.principal_id) {
              json(res, 403, { jsonrpc: "2.0", error: { code: -32003, message: "Session principal mismatch" }, id: requestId });
              return;
            }
            session.lastSeenAt = Date.now();
            transport = session.transport;
          }
        } else if (isInitializeRequest(body)) {
          transport = await createSession(requestPrincipal);
        }
        if (!transport) {
          json(res, sessionId ? 404 : 400, {
            jsonrpc: "2.0",
            error: { code: sessionId ? -32001 : -32000, message: sessionId ? "Session not found" : "Missing session ID" },
            id: requestId,
          });
          return;
        }
        const request = new Request(`http://${host}:${port}/mcp`, { method: "POST", headers, body: rawBody });
        const response = await transport.handleRequest(request, { parsedBody: body });
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }

      if (!sessionId) {
        json(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Missing session ID" }, id: null });
        return;
      }
      const session = sessions.get(sessionId);
      if (!session) {
        json(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
        return;
      }
      if (session.principal.principal_id !== requestPrincipal.principal_id) {
        json(res, 403, { jsonrpc: "2.0", error: { code: -32003, message: "Session principal mismatch" }, id: null });
        return;
      }
      session.lastSeenAt = Date.now();
      const rawBody = req.method === "GET" || req.method === "HEAD" ? undefined : await collectBody(req, maximumBytes);
      const request = new Request(`http://${host}:${port}/mcp`, { method: req.method ?? "GET", headers, ...(rawBody ? { body: rawBody } : {}) });
      const response = await session.transport.handleRequest(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") {
        json(res, 413, { error: "Request body exceeds the configured limit" });
        return;
      }
      if (!options.quiet) console.error("Lightweight project MCP request failed", error);
      json(res, 500, { error: "Internal server error" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  const actualPort = (httpServer.address() as AddressInfo).port;

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - sessionTtlMs;
    for (const [id, session] of sessions) {
      if (session.lastSeenAt >= cutoff) continue;
      sessions.delete(id);
      void session.transport.close().catch(() => undefined);
    }
  }, Math.min(60_000, Math.floor(sessionTtlMs / 2)));
  sweeper.unref();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(sweeper);
    await Promise.allSettled([...sessions.values()].map(session => session.transport.close()));
    sessions.clear();
    await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
  };
  if (!options.quiet) console.error(`Argon Memory lightweight MCP listening on http://${host}:${actualPort}/mcp (${profile})`);
  return { host, port: actualPort, stop };
}
