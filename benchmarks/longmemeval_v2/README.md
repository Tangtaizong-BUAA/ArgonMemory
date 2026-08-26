# LongMemEval-V2 adapter

This directory integrates Argon Memory with the official [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) harness. The adapter exercises the same Streamable HTTP MCP boundary as a real Agent:

```text
trajectory.insert
  → kb_bootstrap_project / kb_start_work
  → kb_publish_resource

question.query
  → kb_search
  → kb_graph_context
  → official reader and evaluator
```

No benchmark question ID, answer, category, or gold evidence is passed into Argon Memory during retrieval. The backend receives only the official trajectory stream, question text, and optional question image allowed by LongMemEval-V2.

## Pinned public inputs

- Harness repository: `xiaowu0162/LongMemEval-V2`
- Validated harness commit: `2cc8c540bdb87fe6761629b585e727e1c4704520`
- Dataset repository: `xiaowu0162/longmemeval-v2`
- Validated dataset revision: `f152293e235517d504809563c833d7190b8c713b`
- License: Apache-2.0

The public data is intentionally not vendored into Argon Memory. At the pinned revision it includes about 1.2 GB of trajectory JSON and separate screenshot archives of several gigabytes.

## Setup

Build Argon Memory first:

```bash
npm install
npm run build
```

Clone and pin the official harness:

```bash
git clone https://github.com/xiaowu0162/LongMemEval-V2.git
cd LongMemEval-V2
git checkout 2cc8c540bdb87fe6761629b585e727e1c4704520
python -m venv .venv
source .venv/bin/activate
pip install -e .
python data/download_data.py --revision f152293e235517d504809563c833d7190b8c713b --data-root /path/to/lme-v2-data
python data/prepare_data.py --data-root /path/to/lme-v2-data --mode symlink
python data/validate_data.py --data-root /path/to/lme-v2-data --tier small
```

## Adapter gate

The smoke test verifies real MCP ingestion, retrieval, persistence, reload, and retrieval again. It is not a public benchmark score.

```bash
npm run benchmark:smoke
```

## Official run

Use the official fixed reader and evaluator endpoints when producing a comparable score:

```bash
export READER_BASE_URL=http://localhost:8023/v1
export READER_MODEL=Qwen/Qwen3.5-9B
export OPENAI_API_KEY=...

python benchmarks/longmemeval_v2/run_public_benchmark.py \
  --longmemeval-repo /path/to/LongMemEval-V2 \
  --argon-repo "$PWD" \
  --data-root /path/to/lme-v2-data \
  --domain enterprise \
  --tier small \
  --output-dir /path/to/results/argon-enterprise-small
```

Repeat for `--domain web`, then combine the two official `aggregated_metrics.json` files with LongMemEval-V2's `leaderboard/combine_aggregated_metrics.py`.

For a cost-bounded integration run, add `--limit 10`. Label this a slice, not a leaderboard result. `--index-only` validates the complete official ingestion path without calling a reader or evaluator model.

## Retrieval-only public diagnostic

After an index-only run, a public question slice can exercise the saved memory without spending reader/evaluator tokens:

```bash
python benchmarks/longmemeval_v2/probe_saved_memory.py \
  --longmemeval-repo /path/to/LongMemEval-V2 \
  --memory-state /path/to/results/argon-enterprise-small/memory_state \
  --questions-path /path/to/runtime/questions.json \
  --output /path/to/results/retrieval-probe.json \
  --limit 20
```

The probe reports non-empty retrieval, latency, context size, record IDs, and a deliberately narrow literal-evidence diagnostic for phrase-set questions. Gold answers are inspected only after `memory.query` returns and are never supplied to retrieval. Literal presence is not answer accuracy: reasoning questions may be answerable even when their final computed word never appears in the evidence, while a present phrase does not prove that a reader will use it correctly.

## What the adapter records

Each query exposes benchmark-side metadata through `post_query_hook`:

- Argon retrieval latency;
- retrieved record IDs and count;
- returned context characters and estimated tokens;
- returned image count;
- whether the question image influenced retrieval;
- indexed trajectory count and mean insertion latency;
- credential-like strings redacted by Argon's safety boundary.

Core lexical retrieval ranks local evidence passages with normalized English/CJK terms, corpus rarity, and exact quoted or backticked phrases. This keeps long Artifacts from winning merely because unrelated query words occur far apart and lets graph reads return the matching span instead of the beginning of the file.

The current Argon retrieval path is text-led. Retrieved trajectory screenshots are returned when a matching excerpt contains their linked image path, but the optional question image is not yet used to rank memory. Reports must state this limitation.
