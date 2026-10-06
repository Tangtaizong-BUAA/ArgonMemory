# Security policy

Please report vulnerabilities privately through GitHub Security Advisories. Do not include credentials or production data in a public issue.

## Deployment rules

- Bind to loopback by default and place TLS/authentication at a trusted reverse proxy when remote access is required.
- Never expose `ARGON_MEMORY_ALLOW_UNAUTHENTICATED=true` on a network.
- Store only token hashes in the principal registry and inject secrets through the process environment or a secret manager.
- Give normal agents `project-contribute`, not `project-ops` or `project-resolve`.
- Keep `ARGON_MEMORY_KB_ROOT` outside the source checkout and back up the full directory atomically.
- Treat MinerU normalization as external data egress and configure it only for data approved for that provider.
- Qwen, MinerU and Jev are separate opt-in providers. An inherited API key alone must not enable retrieval egress. Supply only approved material within each provider's documented scope.
- One managed deployment serves one shared project. Isolate different teams with separate volumes, registries and service processes.
- Preserve private deployment directories, invitations and `secrets.env` outside version control. Registry revocation and role downgrades invalidate existing HTTP sessions.

Argon Memory deliberately does not include a shell, arbitrary filesystem tool, SQL tool, browser, or remote command runner.
