# mneme

> **节省 80-90% 的记忆相关 token 开销。** 给 AI Agent 用的 MCP 长期记忆系统——按需召回，而不是每次注入。
> **兼容所有 MCP 客户端**：Claude Code、Cursor、Windsurf、Cline、Continue 等等。

[English](README.md) · [中文](README.zh-CN.md)

---

## 要解决的问题：记忆是要烧 token 的

AI Agent 本质上是无状态的。常见做法是在每次 prompt 里注入一份 context 文件——但这意味着**每条消息**都要付 token 成本，即使 Agent 已经记得答案。

**到底烧多少 token？**

| 方案 | 每条消息 token | 每天 100 条消息 |
|------|--------------------|------------------|
| 预注入（总是注入） | ~2,000-5,000 tokens | 200K-500K tokens/天 |
| **mneme（按需召回）** | **0 tokens（多数消息）** | **~20K-50K tokens/天** |

绝大多数 prompt 根本不需要历史记忆。mneme 让 Agent 自己决定何时查询——**省下 80-90% 的记忆相关 token 成本**。

---

## v2.0 新特性

### Memory Transfer Learning（记忆抽象分层）

灵感来自跨场景记忆复用研究（arxiv 2604.14004），记忆现在分 3 个抽象层级：

| 层级 | 召回权重 | 描述 | 例子 |
|-------|--------------|-------------|---------|
| `meta_knowledge` | 1.3× | 模式、启发式、可复用原则 | "遇到 X 时做 Y" |
| `semi_abstract` | 1.0× | 含一定上下文的半抽象（默认） | "项目 X 用 Y 因为 Z" |
| `concrete_trace` | 0.7× | 具体操作日志 | "04-16 跑了迁移脚本" |

**核心洞察**：具体执行痕迹跨场景复用价值低，甚至会引起负迁移。系统自动给元知识更高权重，让"提炼的模式"在召回时浮上来，压在"原始事件日志"之上。

### sqlite-vec 混合检索（FTS5 + KNN + RRF）

配置 embedding API 后，mneme 跑**双路检索**：

1. **FTS5 路径**：关键词/词法匹配（快、精确）
2. **向量路径**：通过 sqlite-vec KNN 做语义匹配（同义词、改写）
3. **RRF 融合**：Reciprocal Rank Fusion 仅用排名位置合并两个结果集（无需 score 归一化）

如果 sqlite-vec 或 embedding API 没配，会优雅降级到 FTS5-only。

**性能**：~150ms 总时延（FTS5 <10ms + 一次 embedding API 调用 ~120ms）。本地 sqlite-vec KNN 是亚毫秒级。

### 压缩管线

旧对话片段可以自动压缩成摘要记忆：

- 用快模型（如 Claude Haiku）做摘要
- 用 `compressed_from` 字段跟踪源 rowid（可追溯）
- 防级联保护：已压缩的记忆不能再被压缩（防止幻觉放大）
- 触发方式：CLI 命令、hook 或手动调用

**注意**：实际使用中，我们发现从 Claude Code 内置 `/compact` 功能里读取摘要（通过 SessionStart hook）比单独跑压缩管线更简单也更有效。两种方式都支持。

### Compact 摘要导入

mneme 可以从 Claude Code 的 `/compact` 功能读入摘要：

```bash
# 由 SessionStart hook 在 source=compact 时触发
TOKENMEM_COMPACT_SUMMARY="..." TOKENMEM_COMPACT_SESSION="session-id" \
  node index.mjs --store-compact-summary
```

这能在 Claude Code 压缩上下文时自动捕获 session 知识，让原本会丢失的内容变成持久长期记忆。

### Breaking Changes

- `buildMemoryContext()` 现在是 **async**（返回 `Promise<string>`）
- `storeMemoryAsync()` 现在会写入 sqlite-vec 虚拟表（如可用）
- MCP 工具 `store_memory` 加了新参数 `memory_level`
- DB 路径可由环境变量 `TOKENMEM_DB_PATH` 配置

---

## v2.1 新特性（记忆健康度）

借自记忆衰减学术文献的三项机制，**只动 memory 数据健康度层**——不做 prompt 注入、不做心情状态机、不做人格建模。目标是"让记忆排序随时间符合现实"，而不是"给 AI 情绪"。

### 幂律衰减

每条记忆现在都有 `decay_score`，会按时间、importance、复用频率周期性更新：

```
w(t)  = (1 + t / τ)^(-b_eff)        τ = 24h,  b_base = 0.7
b_eff = b_base / (1 + importance / 10)
decay = min(1.0, w × (1 + min(10, access_count) × 0.3))
```

- 高 importance + 频繁召回的记忆保持在 **1.0** 附近（复用 boost 救回）
- 低 importance + 长期没碰的记忆几周内衰减到 **~0.2**——但**永不消失**。仍可被查到，只是排名低。

通过维护型 daemon 的 interval 调 `runDecayCycle()`，跟 `expireMemories()` / `promoteMemories()` 并列。CLI 没单独脚本——从你自己的 daemon 或 `setInterval` 调用。

召回打分（FTS 和 hybrid 两条路径）现在都乘 `decay_score`——天然新鲜/相关的记忆自动浮上来，不用手动调 TTL。没跑过 decay cycle 的记忆默认 `1.0`（向后兼容）。

### 浮现召回（"忽然想起来"）

当 `recall_memory` 返回少于请求数量时，**25% 概率**从**冷池**里捞 1-3 条记忆：

- `importance >= 8`（真有价值的，不是噪音）
- 30 天以上没碰过（真冷）
- `decay_score >= 0.3`（还没埋透）

浮现记忆带 `recall_source: 'surfaced_random'` 字段，让调用方能区分浮现条 vs 查询命中条。`buildMemoryContext()` 在输出里用 `[surfaced]` 标记它们。

这是为了对治"高价值长尾记忆衰减后排不到 top N"问题——几个月前的好模式可以无提示地浮现，模拟"忽然想起来"的感觉。

### Supersede Paper Trail（替换链路追溯）

`store_memory` 调用时如果传了 `supersedes` 数组（旧记忆 rowid 字符串列表），新记忆会：

1. **继承**旧记忆的 `prior_versions[]`（链式吸收——v1 → v2 → v3 也能保留 v1 的内容）
2. **推入**旧记忆的 `content` / `summary` / `created_at` 到自己的 `prior_versions[]`
3. **更新**旧记忆的 `superseded_by` 指针（保留现有软链机制）
4. `expireMemories()` 下次扫描时软删旧链

召回只返回**最新版**内容。`prior_versions[]` 字段（JSON 存储）可供 audit / 根因分析 / "我之前是怎么想的？" 类查询。retract 后历史不丢。

### Migrations 目录

Schema 变更现在版本化在 `migrations/` 目录：

```
migrations/
├── 001-add-superseded-by.sql       # supersede 指针列（paper trail 前置依赖）
└── 003-add-decay-and-priors.sql    # decay_score + prior_versions + 冷池索引
```

按顺序 apply 到现有 `tokenmem.db`（SQLite `ALTER TABLE`）。Schema 向后兼容——旧记忆获得默认值（`decay_score = 1.0`，`prior_versions = '[]'`），现有 recall 调用照旧 work。

### 加强数据库备份保护

`.gitignore` 现在覆盖 `*.db.bak` / `*.db.bak-*` / `*.db.bak.*` 模式——以前只挡 `*.db.backup-*`，会让带日期后缀的备份文件意外溜进 commit。

---

## 工作原理

```
┌────────────────────────────────────────────────┐
│           任何兼容 MCP 的 Agent                  │
│      (Claude Code / Cursor / Windsurf / ...)   │
│                                                │
│  用户 prompt → "我已经知道这事吗?"               │
│                     │                          │
│              ┌──────┴──────┐                   │
│              ↓ 是          ↓ 否                │
│         直接回答          recall_memory()      │
│         (零额外 token)         ↓               │
│                          MCP Server            │
│                              ↓                 │
│                    FTS5 + sqlite-vec KNN       │
│                    + RRF 融合打分              │
│                       (tokenmem.db)            │
│                              ↓                 │
│                    ← 排序结果                  │
│                                                │
│  store_memory("重要事实",                       │
│    level: "meta_knowledge") → MCP Server       │
│                                      ↓         │
│                     INSERT + embedding → vec   │
└────────────────────────────────────────────────┘
```

**对外暴露 3 个 MCP 工具：**

| 工具 | 用途 |
|------|---------|
| `recall_memory(query, limit?, category?)` | 混合检索：FTS5 + 向量 KNN + RRF 融合打分 |
| `store_memory(content, level?, ...)` | 存储记忆，可指定抽象层级（meta_knowledge / semi_abstract / concrete_trace） |
| `memory_stats()` | 统计：压缩压力、死知识、搜索未命中率 |

---

## 为什么用 MCP 让它通用

mneme 是标准 **MCP server**（stdio 传输）。任何支持 [Model Context Protocol](https://modelcontextprotocol.io/) 的 AI Agent 或 IDE 都能直连——无需改代码。

**测试通过：**

| Agent | 配置 |
|-------|-------|
| Claude Code | `claude mcp add --scope user mneme -- node /path/to/mcp-server.mjs` |
| Cursor | 加到 `.cursor/mcp.json` |
| Windsurf | 加到 MCP server 配置 |
| Cline / Continue | 加到 MCP settings |

---

## 主要特性

### 记忆分层 + 自动升迁

| 层级 | TTL | 自动升迁条件 |
|-------|-----|--------------------|
| `working` | 6 小时 | 访问 ≥ 3 次 或 importance ≥ 7 |
| `short_term` | 7 天 | 访问 ≥ 8 次 或 importance ≥ 8 |
| `long_term` | 无 TTL | — |
| `permanent` | 无 TTL，不删除 | — |

### 复合打分（AIRI 启发）

```
score = FTS 相关度 (40%) + importance (30%) + 时间新鲜度 (20%) + 访问频率 (10%)
```

叠加 Memory Transfer Learning：
```
final_score = base_score × level_weight × decay_score
  其中 level_weight = { meta_knowledge: 1.3, semi_abstract: 1.0, concrete_trace: 0.7 }
       decay_score  = 幂律衰减 × 复用 boost   (v2.1，默认 1.0)
```

Hybrid 模式（FTS5 + 向量）：
```
score = (RRF_score × 0.7 + importance × 0.2 + 时间新鲜度 × 0.1) × level_weight × decay_score
```

v2.1 的 `× decay_score` 乘数让长时间未碰的记忆自然排到后面，无需手动调 TTL。详见上面 [v2.1 新特性](#v21-新特性记忆健康度)。

### 9 个记忆分类

`general`（通用） · `people`（人物） · `project`（项目） · `decision`（决策） · `feedback`（反馈） · `bug` · `relationship`（关系） · `skill`（技能） · `preference`（偏好）

### 中文分词 *（可选）*

通过 [wangfenjin/simple](https://github.com/wangfenjin/simple) 内置中文支持——基于 cppjieba 的 SQLite native 扩展，做词级切分。如果未安装该扩展，会优雅降级为字符级 FTS5。

**非中文用户：完全跳过即可。** 默认 FTS5 tokenizer 对英文和其他语言都 work。

### 健康指标

`memory_stats()` 现在报告：
- **压缩压力**：临时记忆 / 永久记忆比率（> 1.0 = 临时记忆堆积）
- **死知识**：30 天未访问的 long-term 记忆
- **搜索未命中率**：返回 0 结果的查询（知识盲区信号）

---

## 快速开始

### 前置要求

- Node.js 18+
- 任意兼容 MCP 的 AI Agent

### 可选的 Native 扩展

为增强功能，可以添加这些 SQLite 扩展（放到 `lib/` 目录）：

- **[sqlite-vec](https://github.com/asg017/sqlite-vec)**：混合检索用的 KNN 向量搜索
- **[wangfenjin/simple](https://github.com/wangfenjin/simple)**：中文词级切分

两个都是可选的——只用 FTS5 也能完全 work。

### 安装

```bash
git clone https://github.com/AgentGameLab/mneme.git
cd mneme
npm install
```

### 配置 Embedding（可选）

要用混合检索（FTS5 + 向量），设置以下环境变量：

```bash
export EMBEDDING_API_BASE_URL="https://api.openai.com/v1"  # 或任何 OpenAI 兼容 API
export EMBEDDING_API_KEY="your-key"
export EMBEDDING_MODEL="text-embedding-3-small"  # 默认值
export EMBEDDING_DIMENSION="1536"  # 默认值
```

也可以放到项目根目录的 `.env.local` 文件里。

### 初始化

```bash
node index.mjs --stats
# 首次运行会自动创建 tokenmem.db
```

### 连接到你的 Agent

**Claude Code：**
```bash
claude mcp add --scope user mneme -- node /absolute/path/to/mcp-server.mjs
```

**Cursor / Windsurf / 其他 MCP 客户端：**
```json
{
  "mcpServers": {
    "mneme": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server.mjs"]
    }
  }
}
```

### 加 Agent 指令

mneme 负责存和召回，但**何时**存、**怎么**存的纪律是你 Agent 的指令文件决定的，不是 mneme。
几行配置就决定了记忆是越用越准还是膨胀成垃圾抽屉。完整指南见
**[docs/configuring-your-agent.zh-CN.md](docs/configuring-your-agent.zh-CN.md)**：指令块 +
每个 Agent（Claude Code / Codex / Cursor / Cline / Gemini CLI / Windsurf / Amp）配在哪个文件。

精简版——粘进 `CLAUDE.md` / `AGENTS.md` / `.cursor/rules` / `GEMINI.md` 等：

```markdown
## 记忆（mneme MCP）

你能通过 `mneme` 用持久记忆：`recall_memory`、`store_memory`、`memory_stats`。

- **召回**只在上下文没有可靠答案时（过往工作、决策、人物、偏好、项目历史）。上下文已答 /
  问题很通用 / 本 session 已查过 → 跳过。
- **存是写入闸不是反射**：只存会改变未来行为、或在别的 session 有用的——闲聊和一次性确认不是记忆。
- **默认 `semi_abstract`。** `meta_knowledge` 是要"挣"的——只给那种放到一个完全无关的项目里
  还有用的启发式。importance 是弱 prior（按锚点：9-10 身份/铁律 · 7-8 活跃决策 · 5-6 上下文 ·
  ≤4 痕迹），不是排序杠杆——真正的权重靠召回频次涌现，不是写入时拍的数。
- 遇到**近邻重复**警告，用 `supersedes: ["<id>"]` 覆盖旧条目，别新建。
```

---

## CLI 用法

mneme 也能作为独立 CLI 工具——给 hook、脚本、调试用：

```bash
# 看统计
node index.mjs --stats

# 召回记忆
node index.mjs --recall "饮食偏好" --limit 5

# 存记忆（指定抽象层级）
node index.mjs --store "遇到 X 时先检查 Y" \
  --importance 8 --type long_term --category skill \
  --level meta_knowledge

# 构建注入用 context（hook 里有用）
node index.mjs --context "当前项目状态"

# 压缩旧对话（需 claude CLI）
node index.mjs --compress <chat_id> --days 30
node index.mjs --compress-all

# 导入 compact 摘要（SessionStart hook 调）
TOKENMEM_COMPACT_SUMMARY="..." node index.mjs --store-compact-summary

# 回填现有记忆的 embedding
node backfill-embeddings.mjs --concurrency 3
node backfill-embeddings.mjs --dry-run  # 仅统计不写入
```

---

## 辅助脚本

### `backfill-embeddings.mjs`

批量给没有 embedding 向量的旧记忆生成 vector。首次启用向量搜索时有用。

### `migrate-claude-memories.mjs`

把 Claude Code auto-memory `.md` 文件（`~/.claude/projects/*/memory/*.md`）导入到 SQLite。幂等——重复跑安全。不删原文件。

---

## 文件结构

```
mneme/
├── mcp-server.mjs              # MCP server 入口（stdio transport）
├── index.mjs                   # 核心引擎：存储、召回、混合搜索、压缩、衰减
├── schema.sql                  # SQLite schema（memories / conversations / FTS5 / goals）
├── migrations/                 # 版本化 schema 迁移（按顺序 apply）
│   ├── 001-add-superseded-by.sql
│   └── 003-add-decay-and-priors.sql
├── package.json                # 仅 3 个依赖
├── backfill-embeddings.mjs     # 批量 embedding 回填脚本
├── migrate-claude-memories.mjs # Claude auto-memory 迁移工具
├── tokenmem.db                 # SQLite 数据库（自动创建，gitignored）
└── lib/                        # 可选：native 扩展二进制（gitignored）
    ├── libsimple-windows-x64/  #   中文分词（wangfenjin/simple）
    └── sqlite-vec-windows-x64/ #   向量搜索（asg017/sqlite-vec）
```

**约 1800 行代码。3 个依赖。无构建步骤。**

---

## 设计决策

**为什么用 SQLite 而不是向量数据库？**
对个人 Agent 记忆来说，FTS5 + sqlite-vec 提供了足够的语义召回，没有运维负担。混合方案（FTS5 走精确匹配 + sqlite-vec 走语义）覆盖两种查询风格。

**为什么按需召回而不是预注入？**
预注入每条消息都浪费 token。按需召回让 Agent 自己跳过查询（多数时候根本不需要）。

**为什么用 MCP 而不是自定义 API？**
MCP 是 Agent 工具通信的新兴标准。一份实现支持 Claude Code、Cursor、Windsurf 以及任何未来 MCP 兼容的 Agent。

**为什么用 Memory Transfer Learning？**
研究表明具体执行痕迹跨场景迁移效果差，甚至会负迁移。系统在召回时自动给元知识更高权重——让"可复用模式"压在"原始事件日志"之上。

**为什么 hybrid 用 RRF？**
Reciprocal Rank Fusion 只用排名位置，不用原始分数。这样 FTS5 BM25 分数和向量距离——完全不同的 scale——可以公平融合不用归一化。

---

## 环境变量

| 变量 | 默认 | 描述 |
|----------|---------|-------------|
| `TOKENMEM_DB_PATH` | `./tokenmem.db` | SQLite 数据库路径 |
| `EMBEDDING_API_BASE_URL` | — | OpenAI 兼容 embedding API base URL |
| `EMBEDDING_API_KEY` | — | embedding 服务 API key |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | embedding 模型名 |
| `EMBEDDING_DIMENSION` | `1536` | 向量维度 |
| `ENTITY_LLM_API_BASE_URL` | — | 可选实体层的 OpenAI-compat chat base URL（v2.5；不设则休眠） |
| `ENTITY_LLM_API_KEY` | — | 实体抽取的 API key |
| `ENTITY_LLM_MODEL` | `gpt-4o-mini` | 实体抽取用的 chat 模型 |
| `CLAUDE_BIN` | `claude` | Claude CLI 路径（压缩管线用） |
| `TOKENMEM_COMPACT_SUMMARY` | — | compact 摘要文本（SessionStart hook 用） |
| `TOKENMEM_COMPACT_SESSION` | — | compact 摘要的 session ID |

---

## 参考

- [moeru-ai/airi](https://github.com/moeru-ai/airi) — 记忆架构灵感（复合打分模型）
- [wangfenjin/simple](https://github.com/wangfenjin/simple) — SQLite FTS5 的中文分词（基于 cppjieba）
- [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec) — SQLite 向量搜索扩展
- [SQLite FTS5](https://www.sqlite.org/fts5.html) — 内置 BM25 排名的全文搜索
- [Model Context Protocol](https://modelcontextprotocol.io/) — Agent 工具通信标准
- [Memory Transfer Learning (arxiv 2604.14004)](https://arxiv.org/abs/2604.14004) — 跨场景记忆复用研究

---

## License

MIT
