# Benchmarking policy

Argon Memory uses public evaluations to measure the complete memory path, not a curated demo. The primary benchmark is [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2), whose official harness evaluates memory over long multimodal Agent trajectories and scores both answer quality and query latency. [MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) is the planned secondary benchmark for incremental retrieval and conflict resolution.

## Claim levels

1. **Adapter gate** — synthetic smoke data may establish only that insertion, MCP retrieval, persistence, and reload work.
2. **Public slice** — a declared subset of public questions may be used for iteration. Report question selection, domain, tier, and sample count; never call it a leaderboard result.
3. **Full public run** — run both official domains at one official tier with the fixed reader, evaluator, context budget, and upstream scoring code.
4. **Leaderboard claim** — only after the official packaging validator passes and the submitted configuration, revisions, logs, and costs are published.

## Required report fields

Every result must include:

- Argon Memory commit and configuration;
- benchmark repository commit and dataset revision;
- domain, tier, sample count, and any exclusions;
- reader model, endpoint implementation, decoding parameters, and context limit;
- evaluator model and official metric implementation;
- answer score by memory ability, query latency distribution, LAFS or its official equivalent, and failure count;
- memory insertion time, storage size, returned context tokens, and model/API cost;
- baseline runs using the same reader and evaluator;
- known limitations, retries, manual interventions, and whether screenshots were available.

## Fair baselines

At minimum compare against the official no-retrieval baseline and an official retrieval baseline under the same reader, evaluator, question order, and context budget. A model change invalidates a memory-system comparison unless all compared methods are rerun.

## Anti-leakage rules

- Retrieval receives only inputs permitted by the official backend API.
- Gold answers, question IDs, categories, evaluator specifications, and supporting labels never enter Argon Memory query logic.
- No question-specific prompt, override, hard-coded answer, or per-item retry is allowed.
- All data comes from the public benchmark revision; private project documents are never mixed into a run.
- Raw outputs and aggregate metrics are retained so a claimed score can be audited.

## Current evidence status

The MCP adapter, persistence smoke gate, pinned public-data ingestion path, and retrieval-only public diagnostic are implemented. A retrieval diagnostic is useful for latency, context size, and literal evidence presence, but it is not an official answer-accuracy score. No LongMemEval-V2 accuracy, LAFS, or leaderboard claim is made until both official domains run with the fixed reader and evaluator.
