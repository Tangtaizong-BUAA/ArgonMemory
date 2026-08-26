# Argon Memory MCP workflow

```text
kb_sync_skill → kb_brief → kb_graph_context → kb_search as needed
              → kb_start_work → publish/capture → kb_finish_work
```

## Retrieval

- `kb_brief`: complete main file and live navigation.
- `kb_graph_context`: a section, graph neighbours, and linked Artifact excerpts.
- `kb_search`: detail RAG for verifiable facts.
- `kb_lookup`: exact structured filters.
- `kb_outline` / `kb_read`: inspect one resource without loading everything.
- `kb_view`: compact derived timelines, deliverables, risks, and ownership views.

## Persistence

- `kb_start_work`: durable task identity and acceptance criteria.
- `kb_publish_resource`: small Artifact upload.
- `kb_begin_resource_upload` → `kb_append_resource_chunk` → `kb_commit_resource_upload`: large Artifact upload.
- `kb_capture_context`: distilled memory candidates with evidence.
- `kb_finish_work`: idempotent closeout with outputs and unresolved items.

## Failure boundaries

- A completed work item does not imply every memory candidate was accepted.
- A queued maintenance proposal does not imply canonical files were updated.
- A normalized Artifact is retrievable evidence; it is not automatically an accepted project fact.
- A conflict remains open until an authorized resolution is committed.
