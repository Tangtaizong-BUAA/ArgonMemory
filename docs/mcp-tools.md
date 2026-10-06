# MCP tool surface · 0.2.0

## Read and client control

`kb_sync_skill`, `kb_client_notice`, `kb_brief`, `kb_lookup`, `kb_search`, `kb_outline`, `kb_view`, `kb_read`, and `kb_graph_context`.

`kb_search` combines structure planning with global visible evidence retrieval. Use `project_id` to filter before ranking; `modality="image"` to request photos; `mode="lexical"` for an explicit provider-free query. Qwen semantic retrieval is optional and must be enabled. Results disclose active channels, source locations, related conflicts and parsing/embedding coverage.

For dispersed sources, use `intent="collect"`, preserve filters and execute the returned `next_call` until `has_more=false`. `source_ids` starts a focused search over planned sources missing from a page. A cursor binds query scope and corpus revision; restart if either changes. Exhausting the recall set is not proof of fact completeness.

`kb_read` supports evidence URIs, original pixels and outline/line-based continuation. Read actual evidence before treating a title, OCR caption or synthesis as a verified claim.

## Contributions

`kb_start_work`, `kb_publish_resource`, `kb_begin_resource_upload`, `kb_append_resource_chunk`, `kb_commit_resource_upload`, `kb_capture_context`, and `kb_finish_work`.

Contributions retain actor, project, source references, confidentiality and byte hashes. Parsing and maintenance are separate queued stages. Upload completion does not imply canonical publication.

## Resolution and operations

`kb_submit_user_resolution` requires a `project-resolve` principal with `project-owner` or `designated-resolver` role and an explicit user directive. Contributions cannot resolve competing claims by model confidence.

`kb_bootstrap_project`, `kb_configure_source_root`, `kb_ingest`, `kb_parse_artifact`, and `kb_maintain` require the operational profile. Ordinary contributors cannot directly patch maintained main/section files. `kb_maintain` provides queue control; the deployment maintainer consumes proposals separately.

## Skill and notice protocol

Tool results contain the client contract in text and structured form. `kb_sync_skill` returns changed managed files and SHA-256 hashes; clients validate before atomic replacement and recheck the installed files. Each managed deployment supplies a separate project/instance Skill.

`kb_client_notice` atomically claims a campaign once per anonymous computer identity and deployment, independent of Token, IP, session or client. The installed device helper stores its marker outside the Skill directory. Show the introduction only when `display=true`; a dropped response consumes the claim and never triggers repeated announcements. Skip silently when persistent local state is unavailable.
