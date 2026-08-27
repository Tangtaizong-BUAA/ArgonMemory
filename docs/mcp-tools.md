# MCP tool surface

## Read tools

`kb_sync_skill`, `kb_brief`, `kb_lookup`, `kb_search`, `kb_outline`, `kb_view`, `kb_read`, and `kb_graph_context`. Pass `project_id` to `kb_search` whenever a deployment contains more than one project; the server then excludes every other project's records before ranking.

## Contributor tools

`kb_start_work`, `kb_publish_resource`, `kb_begin_resource_upload`, `kb_append_resource_chunk`, `kb_commit_resource_upload`, `kb_capture_context`, and `kb_finish_work`.

## Resolver tool

`kb_submit_user_resolution` is visible only to a `project-resolve` principal with `project-owner` or `designated-resolver` role.

## Ops tools

`kb_bootstrap_project`, `kb_configure_source_root`, `kb_ingest`, `kb_parse_artifact`, and `kb_maintain`.

Tool results carry the Argon Memory client contract. `kb_sync_skill` returns only changed managed files and explicitly retired paths; clients must verify SHA-256 before atomic replacement.
