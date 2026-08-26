# Public benchmarks

Argon Memory reports capability claims only on public, version-pinned benchmarks. Synthetic cases in this repository are smoke tests and regression gates; they are never presented as benchmark scores.

| Benchmark | Role | Coverage | Integration status |
|---|---|---|---|
| [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) | Primary | Long-horizon web and enterprise Agent trajectories, five memory abilities, multimodal evidence, answer quality, query latency, and the official LAFS frontier score | MCP adapter, persistence gate, and public retrieval probe implemented |
| [MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) | Secondary | Accurate retrieval, test-time learning, long-range understanding, and conflict resolution | Adapter planned after the primary run is frozen |

The primary integration is under [`longmemeval_v2/`](longmemeval_v2/). See [benchmarking policy](../docs/benchmarking.md) for the reporting contract.
