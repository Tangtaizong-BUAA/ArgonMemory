# Argon Memory

把结构化主文件的全貌、跨资料的文本与图片 RAG、原文核验和异步维护放进同一个知识内核。当前开源架构版本为 **0.2.0**。

[English](README.md) · [架构](docs/architecture.md) · [部署指南](docs/deployment.md) · [MCP 工具](docs/mcp-tools.md)

## 本次架构升级

主文件和专题分文件帮助智能体理解项目、规划来源；全局检索在整个可见项目资料中寻找证据，不受文件树深度或章节关联限制。查询返回证据 URI、原文位置、版本、续页、解析和向量覆盖缺口，以及相关冲突。分散的实践信息可通过 collect 分页收集，再定向补查计划来源。图片检索在启用 Qwen 后处理实际像素，查询合照可返回原图。

资料解析后进入独立维护队列。Jev 位于解析与维护提案之间，提供有预算和权限边界的章节关联建议；它不参与用户查询、不直接修改正式知识。目录维护或 Qwen 整理提案通过来源、哈希、版本与冲突校验后原子提交。冲突裁决由有权限的负责人凭明确用户指令提交。

## 两种工作方式，共用内核

| 模式 | 接入方式 | 使用范围 |
| --- | --- | --- |
| 本机个人模式 | 客户端启动 stdio、认证 loopback HTTP 或 Docker 虚拟服务器 | 只有部署者一个 owner |
| 云端协作模式 | 部署者自己的 HTTPS MCP 服务 | 独立成员令牌，读者、贡献者、负责人和运维分权 |

不依赖 OpenAI 插件，普通 MCP 客户端也可接入。每个部署导出自己的 Skill，按实际文件哈希增量更新；架构介绍按电脑与部署实例只提示一次。没有持久本地状态时静默跳过。

## 快速开始

需要 Node.js 22 或 24。本地 PDF/图片处理需要 Python 3.10+。

```sh
git clone https://github.com/Tangtaizong-BUAA/ArgonMemory.git
cd ArgonMemory
npm ci
npm run build
python3 -m pip install -r deploy/requirements.txt
node dist/cli.js init local --dir ./my-kb --name "我的知识库"
```

将生成的 `my-kb/mcp.stdio.json` 合并到客户端 MCP 配置；安装 `my-kb/client-skill` 到客户端确认的 Skill 目录。服务和索引/维护进程由客户端管理。初始化只创建空白实例，不扫描其他电脑资料。

云端服务和成员邀请：

```sh
node dist/cli.js init cloud --dir ./team-kb --name "团队知识库" --public-url https://kb.example.org/mcp
node dist/cli.js serve --config ./team-kb/knowledge.config.json --http
node dist/cli.js member issue --config ./team-kb/knowledge.config.json --id alice --role contributor --out ./alice.private.json
```

配置自己的 HTTPS 反向代理。成员撤权和角色降级即时拒绝已有会话。个人与云端 Docker 模板、成员安装和密钥配置见[部署指南](docs/deployment.md)。

## 可核查的边界

外部模型默认关闭；部署者分别启用 Qwen、MinerU 与 Jev 并提供自己的密钥。未启用 Qwen 时明确回退到结构和词法检索。未解析、缺失、权限外或尚无向量的资料会保留覆盖缺口；翻完召回集合不能证明所有事实均被找到。

标准化与向量按内容哈希复用；资料版本变化时词法投影仍会重建，新查询仍需排序。当前向量通道是精确余弦计算，尚未接入 ANN。一个受管部署服务一个共享项目；不同团队使用独立数据目录、registry 与服务进程。

原有库导出和无参数 `ARGON_MEMORY_*` HTTP 启动方式继续可用，统一调用新内核。旧 HTTP 模式启用 Qwen 检索需明确设置 `ARGON_MEMORY_QWEN_ENABLED=true`。原有评测适配器保留，升级数据边界见[架构说明](docs/architecture.md)。

合成验收覆盖个人 stdio、协作权限与撤权、证据续页、原图读取、解析、缓存与维护校验，不等同于真实全语料检索准确率。此同步包含通用代码、配置模板和文档。

## 公开基准测试

下述已发布诊断来自 0.1.x 的旧检索实现。本次 0.2.0 架构升级尚未运行新的完整基准，不沿用旧成绩宣称提升。

仓库已提供官方 [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) Agent 长期记忆基准的 MCP 原生适配器，覆盖长期 Web/Enterprise Agent 轨迹、五类记忆能力、回答质量和查询延迟。自造样例只用于接口门禁，绝不作为公开 Benchmark 分数。详见 [Benchmark 入口](benchmarks/README.md)、[报告规范](docs/benchmarking.md) 与首份[公开检索诊断](docs/benchmark-results/2026-08-26-longmemeval-v2-public-retrieval.md)。

[![LongMemEval-V2 已公开记忆系统横向对比](docs/assets/longmemeval-v2-public-frontier.svg)](benchmarks/README.md#published-memory-system-comparison)

上图按官方统一口径对比 RAG、AgentRunbook-R、Codex、AgentRunbook-C，并将 AgentRunbook-C V2 标为独立研究更新。Argon Memory 的正式回答准确率和 LAFS 仍待完整运行；下图仅为检索诊断，未被混入准确率排名。

[![Argon Memory LongMemEval-V2 公开检索概览](docs/assets/longmemeval-v2-snapshot.svg)](docs/benchmark-results/2026-08-26-longmemeval-v2-public-retrieval.md)

## 贡献者

Argon Memory 由 [Tangtaizong-BUAA](https://github.com/Tangtaizong-BUAA) 创建并主导，OpenAI Codex 作为 AI 工程协作者参与架构、实现、文档、审查和发布准备。详细角色与署名边界见 [CONTRIBUTORS.md](CONTRIBUTORS.md)。

当前版本为 `0.2.0`。Argon Memory `0.1.1` 及后续版本采用 [Apache License 2.0](LICENSE)，允许商业使用、修改、分发和私有使用，并包含明确的专利授权。MinerU Document Explorer 的上游署名及原始 MIT 许可声明保留在 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中。
