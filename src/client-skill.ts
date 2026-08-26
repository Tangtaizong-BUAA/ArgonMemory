import { createHash } from "node:crypto";
import {
  PROJECT_MCP_SERVER_VERSION,
  PROJECT_SKILL_BUNDLE_SHA256,
  PROJECT_SKILL_NAME,
  PROJECT_SKILL_RELEASE_FILE_HASHES,
  PROJECT_SKILL_VERSION,
  getProjectSkillFiles,
  type ProjectSkillFile,
} from "./client-skill-bundle.generated.js";

export type ProjectClientKind = "codex" | "qoder" | "hermes" | "generic";

export type ProjectClientContract = {
  schema: "argon-memory-client-contract/v1";
  server_version: string;
  required_skill: {
    name: string;
    version: string;
    bundle_sha256: string;
    sync_tool: "kb_sync_skill";
    update_mode: "incremental";
  };
};

export type ProjectSkillSyncInput = {
  client: ProjectClientKind;
  installed_version: string;
  installed_files?: Array<{ path: string; sha256: string }>;
};

export type ProjectSkillSyncResult = {
  status: "current" | "current_version_unverified" | "update_required";
  contract: ProjectClientContract;
  installed_version: string;
  target_version: string;
  delta: {
    base_version: string;
    target_version: string;
    files: ProjectSkillFile[];
    remove_paths: string[];
    unchanged_paths: string[];
    bundle_sha256: string;
    manifest_path: "skill-version.json";
  };
  install: {
    client: ProjectClientKind;
    skill_name: string;
    target_hint: string;
    strategy: "incremental-atomic-replace";
    requires_new_session: true;
  };
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const safeManagedPath = (path: string): boolean =>
  path.length > 0 && !path.includes("\0") && !path.startsWith("/") && !path.startsWith("\\") &&
  !/^[A-Za-z]:[\\/]/.test(path) && path.split(/[\\/]+/).every(part => part.length > 0 && part !== "." && part !== "..");

export function projectClientContract(): ProjectClientContract {
  return {
    schema: "argon-memory-client-contract/v1",
    server_version: PROJECT_MCP_SERVER_VERSION,
    required_skill: {
      name: PROJECT_SKILL_NAME,
      version: PROJECT_SKILL_VERSION,
      bundle_sha256: PROJECT_SKILL_BUNDLE_SHA256,
      sync_tool: "kb_sync_skill",
      update_mode: "incremental",
    },
  };
}

function targetHint(client: ProjectClientKind): string {
  if (client === "codex") return "${CODEX_HOME:-~/.codex}/skills/argon-memory";
  return `the active ${client} Skill directory for ${PROJECT_SKILL_NAME}; resolve it from client configuration and do not guess`;
}

function manifestFile(files: ProjectSkillFile[]): ProjectSkillFile {
  const hashes = Object.fromEntries(files.map(file => [file.path, file.sha256]));
  const content = `${JSON.stringify({
    schema: "argon-memory-skill-manifest/v1",
    skill_name: PROJECT_SKILL_NAME,
    version: PROJECT_SKILL_VERSION,
    bundle_sha256: PROJECT_SKILL_BUNDLE_SHA256,
    files: hashes,
  }, null, 2)}\n`;
  return { path: "skill-version.json", content, sha256: sha256(content), size_bytes: Buffer.byteLength(content) };
}

export function syncProjectSkill(input: ProjectSkillSyncInput): ProjectSkillSyncResult {
  const currentFiles = getProjectSkillFiles();
  if (currentFiles.some(file => !safeManagedPath(file.path))) throw new Error("Server Skill bundle contains an unsafe managed path");
  const currentByPath = new Map(currentFiles.map(file => [file.path, file]));
  if (input.installed_files?.some(file => !safeManagedPath(file.path))) throw new Error("installed_files contains an unsafe relative path");
  if (input.installed_files && new Set(input.installed_files.map(file => file.path)).size !== input.installed_files.length) throw new Error("installed_files contains duplicate paths");
  const reportedHashes = input.installed_files?.length
    ? Object.fromEntries(input.installed_files.map(file => [file.path, file.sha256]))
    : undefined;
  const baselineHashes = reportedHashes ?? PROJECT_SKILL_RELEASE_FILE_HASHES[input.installed_version];

  const changedFiles = baselineHashes
    ? currentFiles.filter(file => baselineHashes[file.path] !== file.sha256)
    : currentFiles;
  const unchangedPaths = baselineHashes
    ? currentFiles.filter(file => baselineHashes[file.path] === file.sha256).map(file => file.path)
    : [];
  const historicalHashes = PROJECT_SKILL_RELEASE_FILE_HASHES[input.installed_version];
  const removePaths = historicalHashes
    ? Object.keys(historicalHashes).filter(path => safeManagedPath(path) && !currentByPath.has(path)).sort()
    : [];
  const versionMatches = input.installed_version === PROJECT_SKILL_VERSION;
  const updateRequired = !versionMatches || changedFiles.length > 0 || removePaths.length > 0;
  const status: ProjectSkillSyncResult["status"] = updateRequired
    ? "update_required"
    : reportedHashes ? "current" : "current_version_unverified";
  const manifest = manifestFile(currentFiles);

  return {
    status,
    contract: projectClientContract(),
    installed_version: input.installed_version,
    target_version: PROJECT_SKILL_VERSION,
    delta: {
      base_version: input.installed_version,
      target_version: PROJECT_SKILL_VERSION,
      files: updateRequired ? [...changedFiles, manifest] : [],
      remove_paths: updateRequired ? removePaths : [],
      unchanged_paths: unchangedPaths,
      bundle_sha256: PROJECT_SKILL_BUNDLE_SHA256,
      manifest_path: "skill-version.json",
    },
    install: {
      client: input.client,
      skill_name: PROJECT_SKILL_NAME,
      target_hint: targetHint(input.client),
      strategy: "incremental-atomic-replace",
      requires_new_session: true,
    },
  };
}

export {
  PROJECT_MCP_SERVER_VERSION,
  PROJECT_SKILL_BUNDLE_SHA256,
  PROJECT_SKILL_NAME,
  PROJECT_SKILL_VERSION,
};
