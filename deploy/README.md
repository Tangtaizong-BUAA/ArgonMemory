# Argon Memory deployment

See [deployment instructions](../docs/deployment.md) for local stdio, personal Docker and collaborative HTTPS deployment. Both use the same structured-RAG kernel.

Build from the ArgonMemory repository root. Local Compose publishes only loopback; cloud Compose exposes Caddy HTTPS and keeps the MCP port private. Providers remain disabled until explicitly configured.
