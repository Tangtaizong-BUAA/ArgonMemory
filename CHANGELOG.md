# Changelog

## Unreleased

- Add explicit human and AI collaboration attribution for Tangtaizong-BUAA and OpenAI Codex.
- Correct the repository-local Git identity for future commits to map to the project owner's GitHub account.
- Add a Streamable HTTP MCP adapter, reproducibility wrapper, persistence gate, and reporting policy for the public LongMemEval-V2 benchmark.
- Replace whole-document boolean term counting with deterministic local-passage ranking, corpus rarity weighting, English/CJK normalization, and quoted-field emphasis.
- Add a retrieval-only public-data probe that measures latency, context size, record provenance, and post-retrieval literal evidence coverage without presenting it as answer accuracy.

## 0.1.1 — 2026-08-26

- Adopt Apache License 2.0 for Argon Memory releases from 0.1.1 onward.
- Preserve the upstream MinerU Document Explorer MIT notice in the distributed package.

## 0.1.0 — 2026-08-26

- First standalone Argon Memory release.
- MCP project brief, graph context, detail retrieval, structured views, work lifecycle, Artifact persistence, and incremental Skill sync.
- Evidence-gated memory promotion and conflict-aware resolver boundary.
- Immutable revision manifests, atomic current pointer, append-only audit events, and optional MinerU normalization.
