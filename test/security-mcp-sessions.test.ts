import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startLightweightProjectHttpServer, type LightweightProjectHttpHandle } from "../src/mcp/project-http-server.js";

const roots: string[] = [], servers: LightweightProjectHttpHandle[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const server of servers.splice(0)) await server.stop(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "argon-security-sessions-")); roots.push(root);
  const server = await startLightweightProjectHttpServer({ projectDataDir: root, host: "127.0.0.1", port: 0, projectProfile: "project-read", bearerToken: "synthetic-test-token", principalRegistryJson: "[]", maxSessions: 1, quiet: true, retrievalProvider: null }); servers.push(server);
  const endpoint = `http://127.0.0.1:${server.port}/mcp`;
  const headers = { authorization: "Bearer synthetic-test-token", "content-type": "application/json", accept: "application/json, text/event-stream" };
  const initialize = (params: unknown = { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "security-test", version: "1" } }) => fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params }) });
  return { initialize, endpoint, headers };
}

describe("MCP initialization reservations", () => {
  test("concurrent initialization counts pending sessions before connect resolves", async () => {
    const f = await fixture();
    const connect = McpServer.prototype.connect;
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(McpServer.prototype, "connect").mockImplementation(async function (transport) { entered(); await held; return connect.call(this, transport); });
    const first = f.initialize(); await started;
    try {
      const others = await Promise.all(Array.from({ length: 12 }, () => f.initialize()));
      expect(others.map(response => response.status)).toEqual(Array(12).fill(429));
      await Promise.all(others.map(response => response.text()));
    } finally { release(); }
    const admitted = await first; expect(admitted.status).toBe(200); await admitted.text();
    const session = admitted.headers.get("mcp-session-id")!; expect(session).toBeTruthy();
    const closed = await fetch(f.endpoint, { method: "DELETE", headers: { ...f.headers, "mcp-session-id": session } }); expect(closed.status).toBe(200); await closed.text();
    const replacement = await f.initialize(); expect(replacement.status).toBe(200); await replacement.text();
  });

  test("connect failures and JSON-RPC initialization errors release their reservations", async () => {
    const f = await fixture();
    const spy = vi.spyOn(McpServer.prototype, "connect").mockRejectedValueOnce(new Error("synthetic connection failure"));
    const failed = await f.initialize(); expect(failed.status).toBe(500); await failed.text(); spy.mockRestore();
    const malformed = await f.initialize({ protocolVersion: "2025-03-26" });
    expect((await malformed.json()).error).toBeTruthy();
    const retry = await f.initialize(); expect(retry.status).toBe(200); expect((await retry.json()).result.protocolVersion).toBeTruthy();
  });
});
