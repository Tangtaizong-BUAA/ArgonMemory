import { startLightweightProjectHttpServer, type LightweightProjectHttpOptions, type LightweightProjectHttpHandle } from "./project-http-server.js";
import { resolveProjectProfile } from "../runtime.js";

/** Existing HTTP API, backed by the same kernel as local/cloud deployments.
 * Legacy callers stay provider-free unless they explicitly enable Qwen. */
export type ArgonMemoryServerOptions = LightweightProjectHttpOptions;
export type ArgonMemoryServerHandle = LightweightProjectHttpHandle;

export async function startArgonMemoryServer(options: ArgonMemoryServerOptions): Promise<ArgonMemoryServerHandle> {
  const projectProfile = resolveProjectProfile(options.projectProfile ?? process.env.ARGON_MEMORY_MCP_PROFILE);
  if (projectProfile === "upstream-full") throw new Error("The lightweight server accepts only project profiles");
  return startLightweightProjectHttpServer({
    ...options, projectProfile,
    projectDataDir: options.projectDataDir ?? process.env.ARGON_MEMORY_KB_ROOT,
    bearerToken: options.bearerToken ?? process.env.ARGON_MEMORY_MCP_BEARER_TOKEN,
    principalRegistryJson: options.principalRegistryJson ?? process.env.ARGON_MEMORY_MCP_PRINCIPALS_JSON,
    retrievalProvider: options.retrievalProvider !== undefined ? options.retrievalProvider : (process.env.ARGON_MEMORY_QWEN_ENABLED === "true" ? undefined : null),
  });
}
