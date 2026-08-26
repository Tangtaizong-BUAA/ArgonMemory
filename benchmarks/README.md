# Public benchmarks

Argon Memory reports capability claims only on public, version-pinned benchmarks. Synthetic cases in this repository are smoke tests and regression gates; they are never presented as benchmark scores.

| Benchmark | Role | Coverage | Integration status |
|---|---|---|---|
| [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) | Primary | Long-horizon web and enterprise Agent trajectories, five memory abilities, multimodal evidence, answer quality, query latency, and the official LAFS frontier score | MCP adapter, persistence gate, and public retrieval probe implemented |
| [MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) | Secondary | Accurate retrieval, test-time learning, long-range understanding, and conflict resolution | Adapter planned after the primary run is frozen |

The primary integration is under [`longmemeval_v2/`](longmemeval_v2/). See the [benchmarking policy](../docs/benchmarking.md) for the reporting contract and the first [public retrieval diagnostic](../docs/benchmark-results/2026-08-26-longmemeval-v2-public-retrieval.md) for bounded current evidence.

## Current public comparison

| Configuration | Literal evidence coverage | Mean query latency | Mean returned context | Decision |
|---|---:|---:|---:|---|
| Argon top 6 | **6/11 (54.5%)** | **1.62 s** | **12,170 tokens** | Selected |
| Argon top 10 | 4/11 (36.4%) | 1.77 s | 12,283 tokens | Rejected: evidence fragments became too short |

This is an ablation over the same 20 public questions and 12,000-token budget. Literal evidence coverage is a post-retrieval diagnostic, not LongMemEval-V2 answer accuracy or LAFS.
