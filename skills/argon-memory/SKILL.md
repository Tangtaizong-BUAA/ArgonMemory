---
name: argon-memory
description: Use an Argon Memory MCP server for durable project context, evidence-grounded retrieval, artifacts, work closeout, and conflict-aware memory.
---

# Argon Memory

Treat the configured Argon Memory MCP server as the project's durable memory. Do not create a competing truth store in chat summaries or local scratch notes.

## Start every project task

1. Call `kb_sync_skill` once and apply only a validated incremental Skill delta when required.
2. Call `kb_brief` with the stable `project_id`. Read the complete main file and live section navigation.
3. Select the relevant section and call `kb_graph_context` with the user's original query.
4. For names, dates, numbers, versions, quotations, decisions, images, tables, or evidence, proactively call `kb_search`, then inspect the matching record or Artifact with `kb_graph_context` or `kb_read`.

The main file is an orientation map. Maintained sections provide domain synthesis. Artifacts remain the evidence layer. Never use a summary as a substitute for a verifiable source.

## Durable work loop

- Before material work, call `kb_start_work`.
- Publish long-lived outputs with `kb_publish_resource`; use chunked upload tools for large resources.
- Distill stable facts, decisions, constraints, preferences, procedures, lessons, and open questions with `kb_capture_context`. Never upload a raw conversation transcript.
- Close every work item with `kb_finish_work`, including partial or failed work, evidence, outputs, and unresolved issues.

Memory candidates may be accepted, quarantined, disputed, or rejected. Report that status honestly. Never present quarantined or disputed memory as confirmed fact.

## Conflicts and authority

Disclose relevant `open` or `resolution_pending` conflicts. Do not silently choose a winning claim based on recency, source order, or model judgment. Only a principal with the resolver capability may persist an owner's explicit resolution through `kb_submit_user_resolution`; other agents may use the answer for the current response but must not write it back through another tool.

## Safety

- Never place credentials, private keys, or tokens in MCP arguments or records.
- Use `kb://` resource identifiers, never server filesystem paths.
- Original Artifacts and audit events are append-only. Archive, supersede, or detach instead of deleting history.
- Respect the server's profile and confidentiality boundaries. Do not attempt to obtain tools hidden from the current principal.

See [references/workflow.md](references/workflow.md) for the compact tool map and failure boundaries.
