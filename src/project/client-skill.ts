import { createHash } from "node:crypto";
import { projectNoticeContract, type ProjectNotice } from "./client-notices.js";
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
  client_notice: ReturnType<typeof projectNoticeContract>;
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

/** A deployment supplies its own branding and verified Skill bytes. The same
 * runtime serves local and cloud installations; the hosted default is intact. */
export type ProjectClientRelease = {
  name: string; version: string; server_version: string; bundle_sha256: string;
  files: ProjectSkillFile[]; release_hashes: Readonly<Record<string, Readonly<Record<string, string>>>>;
  notice: ProjectNotice;
};

export function createProjectClientRelease(input: Omit<ProjectClientRelease, "bundle_sha256" | "release_hashes" | "files"> & { files: Array<{ path: string; content: string }> }): ProjectClientRelease {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.name) || !/^\d+\.\d+\.\d+$/.test(input.version)) throw new Error("Invalid deployment Skill identity");
  if (input.files.length > 30 || !input.files.some(file => file.path === "SKILL.md") || input.files.some(file => !safeManagedPath(file.path) || file.path === "skill-version.json") || new Set(input.files.map(file => file.path)).size !== input.files.length) throw new Error("Invalid deployment Skill paths");
  const files = input.files.map(file => ({ ...file, sha256: sha256(file.content), size_bytes: Buffer.byteLength(file.content) }));
  const hashes = Object.fromEntries(files.map(file => [file.path, file.sha256]));
  return { ...input, files, bundle_sha256: sha256(JSON.stringify(hashes)), release_hashes: { [input.version]: hashes } };
}

export function projectClientContract(release?: ProjectClientRelease): ProjectClientContract {
  return {
    schema: "argon-memory-client-contract/v1",
    server_version: release?.server_version ?? PROJECT_MCP_SERVER_VERSION,
    client_notice: projectNoticeContract(release?.notice),
    required_skill: {
      name: release?.name ?? PROJECT_SKILL_NAME,
      version: release?.version ?? PROJECT_SKILL_VERSION,
      bundle_sha256: release?.bundle_sha256 ?? PROJECT_SKILL_BUNDLE_SHA256,
      sync_tool: "kb_sync_skill",
      update_mode: "incremental",
    },
  };
}

function targetHint(client: ProjectClientKind, name: string): string {
  if (client === "codex") return `\${CODEX_HOME:-~/.codex}/skills/${name}`;
  return `the active ${client} Skill directory for ${name}; resolve it from client configuration and do not guess`;
}

function manifestFile(files: ProjectSkillFile[], release?: ProjectClientRelease): ProjectSkillFile {
  const hashes = Object.fromEntries(files.map(file => [file.path, file.sha256]));
  const content = `${JSON.stringify({
    schema: "argon-memory-skill-manifest/v1",
    skill_name: release?.name ?? PROJECT_SKILL_NAME,
    version: release?.version ?? PROJECT_SKILL_VERSION,
    bundle_sha256: release?.bundle_sha256 ?? PROJECT_SKILL_BUNDLE_SHA256,
    files: hashes,
  }, null, 2)}\n`;
  return { path: "skill-version.json", content, sha256: sha256(content), size_bytes: Buffer.byteLength(content) };
}

export function syncProjectSkill(input: ProjectSkillSyncInput, release?: ProjectClientRelease): ProjectSkillSyncResult {
  const currentFiles = release?.files ?? getProjectSkillFiles();
  const version = release?.version ?? PROJECT_SKILL_VERSION;
  const releaseHashes = release?.release_hashes ?? PROJECT_SKILL_RELEASE_FILE_HASHES;
  if (currentFiles.some(file => !safeManagedPath(file.path))) throw new Error("Server Skill bundle contains an unsafe managed path");
  const currentByPath = new Map(currentFiles.map(file => [file.path, file]));
  if (input.installed_files?.some(file => !safeManagedPath(file.path))) throw new Error("installed_files contains an unsafe relative path");
  if (input.installed_files && new Set(input.installed_files.map(file => file.path)).size !== input.installed_files.length) throw new Error("installed_files contains duplicate paths");
  const reportedHashes = input.installed_files?.length
    ? Object.fromEntries(input.installed_files.map(file => [file.path, file.sha256]))
    : undefined;
  const baselineHashes = reportedHashes ?? releaseHashes[input.installed_version];

  const changedFiles = baselineHashes
    ? currentFiles.filter(file => baselineHashes[file.path] !== file.sha256)
    : currentFiles;
  const unchangedPaths = baselineHashes
    ? currentFiles.filter(file => baselineHashes[file.path] === file.sha256).map(file => file.path)
    : [];
  const historicalHashes = releaseHashes[input.installed_version];
  const removePaths = historicalHashes
    ? Object.keys(historicalHashes).filter(path => safeManagedPath(path) && !currentByPath.has(path)).sort()
    : [];
  const versionMatches = input.installed_version === version;
  const updateRequired = !versionMatches || changedFiles.length > 0 || removePaths.length > 0;
  const status: ProjectSkillSyncResult["status"] = updateRequired
    ? "update_required"
    : reportedHashes ? "current" : "current_version_unverified";
  const manifest = manifestFile(currentFiles, release);

  return {
    status,
    contract: projectClientContract(release),
    installed_version: input.installed_version,
    target_version: version,
    delta: {
      base_version: input.installed_version,
      target_version: version,
      files: updateRequired ? [...changedFiles, manifest] : [],
      remove_paths: updateRequired ? removePaths : [],
      unchanged_paths: unchangedPaths,
      bundle_sha256: release?.bundle_sha256 ?? PROJECT_SKILL_BUNDLE_SHA256,
      manifest_path: "skill-version.json",
    },
    install: {
      client: input.client,
      skill_name: release?.name ?? PROJECT_SKILL_NAME,
      target_hint: targetHint(input.client, release?.name ?? PROJECT_SKILL_NAME),
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
