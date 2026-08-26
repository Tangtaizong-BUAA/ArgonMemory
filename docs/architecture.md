# Architecture

Argon Memory separates canonical knowledge, derived retrieval, and agent reasoning.

## First principles

1. The connected agent answers; the memory server retrieves, validates, and persists.
2. Canonical truth is inspectable Markdown plus YAML frontmatter.
3. A compact main file gives orientation; sections and Artifacts provide depth.
4. Every durable write belongs to a work item and an actor.
5. Evidence, revisions, conflicts, and audit history are never silently discarded.
6. Query latency never depends on a maintenance model.

## Write path

Agent contributions enter as work records, Artifacts, or memory candidates. Deterministic validation rejects secrets, quarantines unsupported claims, and routes changes into bounded ChangePackets. An optional maintenance worker may propose a structured plan, but the deterministic harness validates revisions, evidence references, conflict protection, and budgets before publishing an immutable snapshot.

## Read path

`kb_brief` returns the full main file and navigation. `kb_graph_context` expands one node and its direct Artifact links. `kb_search` retrieves detail records and normalized Artifact text. This progressive disclosure keeps prompts small without sacrificing evidence.

## Consistency

Canonical publication creates an immutable revision manifest. A single atomically replaced pointer binds the knowledge, topology, and index revisions. Readers pin one pointer per request, so staging or partially built indexes are never visible.

## Conflict lifecycle

Models may detect and register competing claims but cannot resolve them. A resolver principal locks the human's exact statement into `resolution_pending`; the maintenance transaction applies a typed result while preserving previous claims and evidence.
