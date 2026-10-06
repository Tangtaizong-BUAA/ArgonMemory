import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProjectProfile, ProjectRuntime } from "../project/runtime.js";

/** Register only the kb:// resource namespace, without loading the full QMD stack. */
export function registerLightweightProjectResource(
  server: McpServer,
  runtime: ProjectRuntime,
  profile: Exclude<ProjectProfile, "upstream-full">,
  personalOwner = false,
): void {
  server.registerResource(
    "project-record",
    new ResourceTemplate("kb://{+path}", { list: undefined }),
    {
      title: "Project knowledge record",
      description: "A project main file, maintained section, memory, record, or linked artifact discovered through project MCP tools.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const maximum = personalOwner || profile === "project-admin" || profile === "project-ops" ? "secret" : "internal";
      if (uri.href.startsWith("kb://evidence/")) {
        try {
          const image = await runtime.readEvidenceImage(uri.href, maximum);
          return { contents: [{ uri: uri.href, name: image.title, title: image.title, mimeType: image.mimeType, blob: image.data }] };
        } catch { /* Text evidence and inaccessible IDs use the checked text reader. */ }
      }
      if (/\/image\/\d+$/.test(uri.pathname)) {
        const image = await runtime.readEvidenceImage(uri.href, maximum);
        return { contents: [{ uri: uri.href, name: image.title, title: image.title, mimeType: image.mimeType, blob: image.data }] };
      }
      if (uri.pathname.endsWith("/raw")) {
        const resource = await runtime.readRawArtifactResource(uri.href, maximum);
        return {
          contents: [{
            uri: uri.href,
            name: resource.title,
            title: resource.title,
            mimeType: resource.mimeType,
            blob: resource.blob,
          }],
        };
      }
      const resource = await runtime.readResource(uri.href, maximum);
      return {
        contents: [{
          uri: uri.href,
          name: resource.title,
          title: resource.title,
          mimeType: "text/markdown",
          text: resource.text,
        }],
      };
    },
  );
}
