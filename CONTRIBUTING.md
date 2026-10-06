# Contributing

Contributions that strengthen provenance, retrieval quality, interoperability, and safe maintenance are welcome.

```bash
npm install
npm run check
npm run build
npm test
npm run benchmark:smoke
```

Keep canonical storage human-inspectable, preserve append-only history, and do not add a general shell or hidden model call to the query path. New write tools must identify the actor, project, evidence, and idempotency boundary. Never commit sample credentials or real project data.

The managed local and cloud deployments share `src/project/`. Root runtime and MCP modules are compatibility exports; do not create another truth store or retrieval implementation. Provider calls must remain explicitly enabled, bounded and disclosed. Synthetic acceptance tests use temporary data and mocked model calls; they are not benchmark scores.
