#!/usr/bin/env node

import { startArgonMemoryServer } from "./mcp/server.js";

// Existing no-argument environment mode is retained for benchmark adapters.
if (process.argv.length > 2) {
  await import("./cli/knowledge.js");
} else {
const host = process.env.ARGON_MEMORY_HOST ?? "127.0.0.1";
const port = Number(process.env.ARGON_MEMORY_PORT ?? "8793");
const allowUnauthenticated = process.env.ARGON_MEMORY_ALLOW_UNAUTHENTICATED === "true";

const handle = await startArgonMemoryServer({ host, port, allowUnauthenticated });

async function shutdown(signal: string): Promise<void> {
  console.error(`Shutting down Argon Memory (${signal})`);
  await handle.stop();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

}
