import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ProjectProfile } from "./runtime.js";

export type ProjectPrincipal = { principal_id: string; profile: Exclude<ProjectProfile, "upstream-full">; roles: string[] };

const entrySchema = z.object({
  token_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  principal_id: z.string().min(1).max(200),
  profile: z.enum(["project-read", "project-contribute", "project-resolve", "project-ops"]),
  roles: z.array(z.string()).default([]),
});

export function tokenSha256(token: string): string { return createHash("sha256").update(token).digest("hex"); }

export function parsePrincipalRegistry(value: string | undefined): Array<z.infer<typeof entrySchema>> {
  if (!value?.trim()) return [];
  return z.array(entrySchema).parse(JSON.parse(value));
}

export function authenticatePrincipal(token: string, registry: Array<z.infer<typeof entrySchema>>): ProjectPrincipal | null {
  const actual = Buffer.from(tokenSha256(token), "hex");
  for (const entry of registry) {
    const expected = Buffer.from(entry.token_sha256, "hex");
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) return { principal_id: entry.principal_id, profile: entry.profile, roles: entry.roles };
  }
  return null;
}

export function canResolveConflicts(principal: ProjectPrincipal): boolean {
  return principal.profile === "project-resolve" && principal.roles.some(role => role === "project-owner" || role === "designated-resolver");
}
