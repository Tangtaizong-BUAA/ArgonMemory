import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { projectClientContract } from "../client-skill.js";

export const PROJECT_CONTRACT_META_KEY = "dev.argon-memory/client-contract";

export function versionProjectToolResult(result: CallToolResult): CallToolResult {
  const contract = projectClientContract();
  const structured = result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
    ? result.structuredContent
    : {};
  return {
    ...result,
    _meta: { ...(result._meta ?? {}), [PROJECT_CONTRACT_META_KEY]: contract },
    structuredContent: { ...structured, _client_contract: contract },
  };
}

/**
 * Decorate project tool definitions and results once, including tools added in
 * future releases. This avoids version metadata drifting between handlers.
 */
export function installProjectToolVersioning(server: McpServer): void {
  const registerTool = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: Record<string, unknown>, callback: (...args: any[]) => CallToolResult | Promise<CallToolResult>) => {
    const contract = projectClientContract();
    return registerTool(
      name,
      { ...config, _meta: { ...((config._meta as Record<string, unknown> | undefined) ?? {}), [PROJECT_CONTRACT_META_KEY]: contract } } as never,
      (async (...args: any[]) => versionProjectToolResult(await callback(...args))) as never,
    );
  }) as typeof server.registerTool;
}
