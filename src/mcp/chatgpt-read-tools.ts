import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProjectRuntime } from "../project/runtime.js";
import { registerProjectTools } from "./tools/project.js";

export const CHATGPT_READ_TOOLS = ["kb_brief", "kb_coverage", "kb_lookup", "kb_search", "kb_outline", "kb_view", "kb_read", "kb_graph_context"] as const;

/** Registration allowlist is enforced independently of hints and future profiles. */
export function registerChatgptReadTools(server: McpServer, runtime: ProjectRuntime): void {
  const allowed = new Set<string>(CHATGPT_READ_TOOLS);
  const registration = new Proxy(server, {
    get(target, property) {
      if (property === "registerTool") return (name: string, config: Record<string, any>, callback: any) => {
        if (!allowed.has(name)) return undefined;
        if (config.annotations?.readOnlyHint !== true) throw new Error("Connector tool must be read-only");
        return target.registerTool(name, { ...config, annotations: { ...config.annotations, readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, callback);
      };
      return Reflect.get(target, property);
    },
  });
  registerProjectTools(registration, runtime, "project-read", "chatgpt-read");
}
