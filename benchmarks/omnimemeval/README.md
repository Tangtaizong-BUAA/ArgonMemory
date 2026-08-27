# OmniMemEval adapter

This adapter evaluates Argon Memory beside Mem0, Zep/Graphiti, Letta, MemOS, and other memory backends under OmniMemEval's shared ingestion, retrieval, answer, and judge pipeline.

It uses Argon's public Streamable HTTP MCP interface. Each OmniMemEval `user_id` maps to a separate Argon project, and every `kb_search` request is constrained to that project. A benchmark run must use a fresh `ARGON_OMNI_KB_ROOT`; Argon's append-only history is never deleted to simulate cleanup.

The retrieval adapter consumes `kb_search`'s ranked, query-centred evidence snippets directly. It does not issue an additional `kb_graph_context` request per hit: graph expansion is useful for interactive deep reading, while the benchmark needs a bounded RAG context and comparable online query latency.

## Install

```bash
npm run build
python benchmarks/omnimemeval/install_adapter.py \
  --omnimemeval-repo /path/to/OmniMemEval

export ARGON_MEMORY_CLI="$PWD/dist/cli.js"
export ARGON_OMNI_KB_ROOT=/path/to/fresh/argon-omnimemeval-kb
```

Copy [`omnimemeval.env.example`](omnimemeval.env.example) to a private path outside the repository and provide the answer/judge credentials there. Never commit the populated file. Then run an OmniMemEval pipeline with `--lib argon`. For a directly comparable published matrix, preserve OmniMemEval's pinned answer model, judge model, prompts, dataset revision, and metric implementation.

## Claim boundary

- `smoke_test.py` proves MCP ingestion, retrieval, and per-project isolation only.
- A partial run is labelled as a public slice, never a full score.
- An Argon number enters the comparison matrix only after the complete benchmark produces its normal result and report artifacts.

## Matrix renderer

[`render_matrix.py`](render_matrix.py) generates the README-ready SVG from the pinned reproduced-result snapshot in [`reference-results.json`](reference-results.json) and a validated Argon result JSON. It refuses to publish an incomplete Argon column unless `--allow-pending` is used explicitly for layout previews.

[`collect_results.py`](collect_results.py) reads OmniMemEval's native grade files, rejects failed or skipped pipeline records, normalizes the official 0–1 metrics to percentages, and produces the Argon result JSON consumed by the renderer. Without `--allow-partial`, all six matrix rows must be complete.
