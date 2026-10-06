# Maintenance and provider boundaries

Canonical knowledge is revisioned Markdown with stable record IDs. Raw files and normalized text/images remain original evidence. SQLite search indexes, vectors and maintenance queues are derived or operational data; never maintain a second competing fact store.

The indexer normalizes registered documents locally, optionally submits scanned public/internal PDFs to MinerU when explicitly enabled, then rebuilds text/image projections and vectors. OCR-disabled scans have an explicit coverage gap. It does not silently discover every file on disk.

The query service combines maintained structure, lexical search, enabled Qwen text/image embeddings, ranking fusion, reranking and source diversity. Evidence carries version-bound URIs, locations, continuation calls and coverage. Queries do not wait for asynchronous maintenance.

The maintenance service first refreshes its bounded evidence packet. Optional Jev advice relates accepted evidence to sections, after parsing and before the proposal. `shadow` records suggestions while preserving candidates; `advisory` may add eligible candidates. Neither mode writes facts, grants permissions, resolves conflicts or restricts query recall. Configuration explicitly authorizes that provider's bounded egress; it is off by default.

In `catalog` mode, maintenance requires no model: it adds source navigation for newly parsed documents through the same Harness. It does not summarize content, synthesize facts or decide conflicts. In `qwen` mode, Qwen/MS-Agent proposes evidence-backed section/main changes. Harness checks evidence status, project boundary, source hashes, current revisions, mutable blocks and protected conflicts, then commits a canonical revision atomically. A rejected or quarantined plan does not become knowledge.

Model keys alone do not enable providers. The deployment owner enables services in `knowledge.config.json` and supplies private environment secrets. A fully offline deployment has local parsing, structural navigation, lexical text/image-metadata retrieval and original-image reading. It cannot perform Qwen visual-semantic matching without the enabled provider and indexed vectors.

Never state that every known fact was retrieved: registered visible sources, index completion and fact completeness are different measurements.
