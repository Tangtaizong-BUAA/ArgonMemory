<div align="center">

# Argon Memory

### 为真正参与项目工作的 Agent 提供可持续沉淀的长期记忆

一个开源 MCP 知识系统，把文档、Agent 产出、决策和经过核证的对话信息，沉淀为可追溯、可检索、可持续维护的项目记忆。

[English](README.md) · [架构](docs/architecture.md) · [MCP 工具](docs/mcp-tools.md) · [安全](SECURITY.md)

</div>

---

很多 Agent 记忆系统保存的是聊天片段。Argon Memory 维护的是一个项目。

每个接入的 Agent 会先获得同一份紧凑项目地图，再按需下钻到专题分区和原始 Artifact；工作完成后，把真正值得长期保留的产出和知识回传。事实不会因模型“觉得新版本更对”就被覆盖：来源、版本、验证状态和冲突历史始终保留。

## 核心能力

- **项目式记忆结构**：主文件、长期分文件、知识图谱、Artifacts 和结构化记忆各司其职。
- **节省上下文**：先加载小而稳定的项目总览，细节再进行 RAG 和证据精读。
- **证据驱动**：无证据的候选知识进入隔离区，不会直接冒充真实项目事实。
- **Agent 工作闭环**：工作项、交付物、决策、经验和未解决问题跨越对话长期保存。
- **冲突不自动选边**：冲突由系统登记、披露和路由，只能由项目负责人或指定负责人明确解决。
- **不可变历史**：使用 SHA-256、追加式审计、不可变 revision 和原子 current pointer。
- **原生 MCP**：可接入 Codex、Claude Code、Qoder、Hermes、Cursor 及其他 MCP 客户端。
- **模型无关**：查询链路不需要服务器模型；维护 Worker 可按部署者需要选择模型或完全关闭。

## 三层读取路径

```text
主文件：项目是什么、现在处于什么阶段、去哪里找
  ↓
分文件：某一大块业务的长期综合认知
  ↓
Artifact：原始文档、图片、表格和 Agent 产出的可核验证据
```

Agent 不需要每次重新听用户介绍项目，也不需要把全库灌进上下文。涉及名字、日期、数字、版本、原文或图片时，必须继续检索 Artifact，而不是只凭摘要回答。

## 快速开始

```bash
git clone https://github.com/Tangtaizong-BUAA/ArgonMemory.git
cd ArgonMemory
npm install
npm run build

export ARGON_MEMORY_KB_ROOT="$PWD/data"
export ARGON_MEMORY_MCP_PROFILE="project-ops"
export ARGON_MEMORY_ALLOW_UNAUTHENTICATED="true" # 仅限本机首次初始化
npm start
```

- MCP：`http://127.0.0.1:8793/mcp`
- 健康检查：`http://127.0.0.1:8793/health`

使用 `kb_bootstrap_project` 创建首个项目：

```json
{
  "project_id": "project:my-product",
  "title": "我的项目",
  "mission": "为本项目维护可信、持久、可追溯的长期记忆。"
}
```

正常团队 Agent 建议使用 `project-contribute` 权限，并安装仓库内置的 [`argon-memory` Skill](skills/argon-memory/SKILL.md)。

## 默认 Agent 工作流

```text
kb_sync_skill → kb_brief → kb_graph_context → 主动 kb_search
              → kb_start_work → 产物/知识回传 → kb_finish_work
```

主文件负责广泛认知，分文件负责专题综合，Artifact 负责事实证据。`kb_capture_context` 只接收精炼后的事实、决策、约束、偏好、流程、经验和开放问题，不保存整段聊天记录。

## 权限模型

| Profile | 适用对象 | 权限 |
|---|---|---|
| `project-read` | 只读客户端和回退节点 | 总览、图谱、检索、精读、结构视图 |
| `project-contribute` | 普通团队 Agent | 查询 + 工作项、Artifact、上下文和关单回传 |
| `project-resolve` | 项目负责人/指定负责人 | 提交明确的人工冲突答案 |
| `project-ops` | 本机运维服务 | 初始化、摄取、解析、健康和校验 |

公开网络部署必须使用 Bearer Token 或 principal registry；无鉴权模式只能用于本机初始化。

## 数据原则

- Markdown + YAML frontmatter 是 canonical truth。
- SQLite 队列、图视图和检索索引都是可重建派生物。
- 原文件、审计事件和冲突历史只追加，不直接删除。
- “工作完成”不等于所有知识候选都已接受。
- “文档已解析”不等于解析内容已经成为项目事实。
- “维护计划已生成”不等于 canonical 主/分文件已经更新。

## 可选 MinerU 解析

```bash
python3 -m pip install mineru-open-sdk
export MINERU_API_KEY="..."
```

运维身份可登记受控源目录、摄取文件并调用 `kb_parse_artifact`。原始文件保留，规范化 Markdown 和外发审计单独保存。

## 本仓库不包含

- 不包含网页端、在线问答 Agent 或聊天 UI。
- 不包含 Shell Runner、容器工作区或远程命令执行系统。
- 不包含任何项目资料、用户文件、生产数据库、Token 或私钥。
- 不包含测试语料和测试文件。
- 不在服务器替团队 Agent 回答问题。

Argon Memory 是持久记忆层，不替代 Codex、Qoder、Hermes 等客户端 Agent 的推理和执行能力。

## 公开基准测试

仓库已提供官方 [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) Agent 长期记忆基准的 MCP 原生适配器，覆盖长期 Web/Enterprise Agent 轨迹、五类记忆能力、回答质量和查询延迟。自造样例只用于接口门禁，绝不作为公开 Benchmark 分数。详见 [Benchmark 入口](benchmarks/README.md) 与 [报告规范](docs/benchmarking.md)。

## 贡献者

Argon Memory 由 [Tangtaizong-BUAA](https://github.com/Tangtaizong-BUAA) 创建并主导，OpenAI Codex 作为 AI 工程协作者参与架构、实现、文档、审查和发布准备。详细角色与署名边界见 [CONTRIBUTORS.md](CONTRIBUTORS.md)。

当前版本为 `0.1.1`。Argon Memory `0.1.1` 及后续版本采用 [Apache License 2.0](LICENSE)，允许商业使用、修改、分发和私有使用，并包含明确的专利授权。MinerU Document Explorer 的上游署名及原始 MIT 许可声明保留在 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中。
