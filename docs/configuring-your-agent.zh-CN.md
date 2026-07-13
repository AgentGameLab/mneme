# 配置你的 Agent 用好 mneme

mneme 是*后端*——负责存和召回。但你的 Agent **何时**存、**存什么**、对级别多自律，是由
Agent 的指令文件决定的，不是 mneme。那几行配置，决定了记忆是越用越准，还是膨胀成垃圾抽屉。

本指南给你两样：

1. **一段可直接粘贴的指令块**。
2. **每个 Agent 在哪个文件读这段配置**（CLAUDE.md、AGENTS.md、`.cursor/rules`……）。

---

## 1. 指令块

粘进你 Agent 的指令文件（具体路径见 §2）。它故意写得短——重点就是让"存"读起来便宜、做起来克制。

```markdown
## 记忆（mneme）

你能通过 `mneme` MCP server 用持久记忆：`recall_memory`、`store_memory`、`memory_stats`。

### 召回——先看上下文
只在当前上下文没有可靠答案时调 `recall_memory`：
- 用户提到过往工作、决策、人物、偏好、项目历史
- 你正要查一个你可能记录过的东西

上下文已答 / 问题很通用 / 本 session 已查过同主题 → 跳过。

### 存——是写入闸，不是反射
存之前先问：**这条会改变我未来的行为，或在别的 session 有用吗？** 否就别存——
闲聊、一次性确认、以及任何能从上下文重建的东西，都不是记忆。

要存的时候：
- **默认 `semi_abstract`。** `meta_knowledge` 是要"挣"的，不是默认——只留给真正跨场景的
  启发式。判据：*放到一个完全无关的项目里还有用吗？* 绑定某项目/人/决策 → `semi_abstract`；
  一次性操作日志 → `concrete_trace`。
- **importance 是弱 prior，不是杠杆。** 按锚点给，别默认拉高：`9-10` 身份/铁律/安全 ·
  `7-8` 活跃决策 · `5-6` 有用上下文 · `≤4` 痕迹。别什么都存 7+。真正的权重靠记忆被召回的
  频次涌现，不是你写入时拍的那个数。
- 如果 `store_memory` 警告**近邻重复**，用 `supersedes: ["<id>"]` 覆盖旧条目，别新建。

### 策展——覆盖，不要整体重写
发现过时记忆时，存一个修正版并 `supersedes: ["<旧 id>"]`。替换具体条目，绝不整体重写记忆库。
```

> **为什么是这些规则？** Agent 记忆最大的失效模式是 *store-time 自评*：刚做完事的 Agent 会
> 高估、过度抽象自己的产出，于是记忆库漂向"什么都重要、什么都是 meta"。（修之前我们在一个真实库
> 实测到 84% 是 `meta`、92.5% importance ≥7。）防线是：让"存"变得克制（一道闸）、让
> `meta`/高 importance 要"挣"、让召回频次而非写入标签来驱动排序。mneme 的排序本身已经弱化了
> 裸 importance、奖励召回频次——指令和引擎是一个方向。

---

## 2. 每个 Agent 在哪读配置

mneme 能对接任何支持 MCP 的 Agent。每个 Agent 有自己的"指令文件"（多数还支持嵌套/作用域变体）。
把 §1 的块放进下表对应文件，Agent 会自动把它加载进系统上下文。

| Agent | 指令文件 | 备注 |
|-------|----------|------|
| **Claude Code** | `~/.claude/CLAUDE.md`（全局）或 `./CLAUDE.md`（项目；嵌套目录逐级叠加） | 每 session 注入系统提示。全局块放这最好。 |
| **OpenAI Codex CLI** | `AGENTS.md`（仓库根；嵌套 `AGENTS.md` 自上而下合并） | 纯指令，按目录拼接。保持精简（有大小上限）。 |
| **Amp（Sourcegraph）** | `AGENTS.md`（项目；user/project/local 层是覆盖不是合并） | 跟 Codex 同文件名——一段块两家通用。 |
| **Cursor** | `.cursor/rules/*.mdc`（Project Rules） | frontmatter 用 `alwaysApply: true`（或 `Always` 规则），让记忆块每次请求都在上下文里。 |
| **Cline** | `.clinerules`（文件或 `.clinerules/` 目录） | Cline 另有 `memory-bank/` 约定；这段块放 `.clinerules`，跟项目 memory-bank 文件分开。 |
| **Gemini CLI** | `GEMINI.md`（项目 / 子目录 / `~/.gemini/GEMINI.md` 全局） | 整段读进上下文——保持短，这段块本就短。 |
| **Windsurf（Cascade）** | `.windsurf/rules/` 或 Workspace Rules | 把规则 trigger 设成 *Always On*，让它一直在上下文里。 |

> 如果你的 Agent 不在表里但支持 MCP + 系统指令/规则文件，两步同样适用：用 MCP 接上 mneme（§3），
> 把块粘进那个文件。

---

## 3. 用 MCP 接上 mneme

上面多数 Agent 都接受 MCP server 配置。形状到处一样——stdio 指向 `mcp-server.mjs`。
示例（Claude Code `~/.claude.json` / 项目 `.mcp.json`）：

```json
{
  "mcpServers": {
    "mneme": {
      "command": "node",
      "args": ["/绝对路径/到/mneme/mcp-server.mjs"]
    }
  }
}
```

- **Cursor**：`.cursor/mcp.json`，同样的 `mcpServers` 形状。
- **Cline / Windsurf**：在 MCP 设置 UI 里加（同样的 command + args）。
- **Gemini CLI**：`~/.gemini/settings.json` 里的 `mcpServers`。
- **Codex CLI**：`~/.codex/config.toml` 里 `[mcp_servers.mneme]`（`command` + `args`）。

mneme 也能跑 HTTP（`node mcp-server.mjs --transport=http --port=18790`），适合多个 Agent 共享
一个实例，而不是每个 Agent 起一个 stdio 进程。

---

## 4. 可选：实体感知召回（v2.5）

mneme 可以在关键词（FTS5）+ 向量之外加**第三路召回信号**：你记忆里出现的命名实体（项目/人/工具…）。
查询里点到某个实体名，就会顺带召回关于它的记忆，用 RRF 融合。

**默认关、纯可选。** 不开它召回照常（关键词 + 向量）。schema **自动升级**——pull 新版 mneme 重启，
就会跑迁移建出 `entities` / `mentions` 表（无需手动迁移；不开也不会坏）。

要开：

1. 指向任意 OpenAI-compat chat 模型——只用于**异步抽取**，绝不在召回路上。不设就一直休眠。
   ```bash
   ENTITY_LLM_API_BASE_URL=https://api.your-provider.com/v1
   ENTITY_LLM_API_KEY=sk-...
   ENTITY_LLM_MODEL=your-chat-model
   ```
2. 给存量记忆 backfill 实体（一次性）：
   ```bash
   node index.mjs --extract-entities --limit 100000
   ```
3. 定期跑同一条命令给新记忆补实体——它只处理还没抽过的：
   ```bash
   node index.mjs --extract-entities --limit 200   # 比如每晚 cron
   ```

抽取异步 + 批量；召回保持纯 SQL（热路零 LLM）。

---

## 4b. 可选：meta-gate 软词表（v2.6）

`meta-gate.mjs` 的 write-gate 会在 store 有具体绑定时把 `meta_knowledge` 自动降级 `semi_abstract`。绑定里项目名 / 人名两类是**软绑定**——你不给词表就不触发。公开仓默认空，不带任何团队名。

在 agent 跑 mneme 的地方 set 这几个 env 就开启软匹配：

| 变量 | 举例 | 含义 |
|-----|------|------|
| `MNEME_META_GATE_PROJECT_NAMES` | `MyApp,billing-service,mobile-app` | 逗号分隔的项目 / 产品名 |
| `MNEME_META_GATE_PERSON_NAMES` | `alice,bob,carol` | 逗号分隔人名（≥ 2 命中才触发降级） |
| `MNEME_META_GATE_SIGNAL_WORDS` | `cross-project,跨项目` | 覆盖内置 EN+ZH signal-word 集，用于给软绑定豁免 |

硬绑定（ISO 日期 / mem-rowid 引用 / commit hash / 绝对路径 / 版本号）零配置就生效。signal words 出现在 content 前 200 字符可以豁免软绑定，**永远不能豁免硬绑定**。

---

## 5. 可选：自动召回 hook（Claude Code）

MCP tool 是 pull 模式——Agent 自己决定何时 `recall_memory`。有些 Agent（尤其 Claude Code）
支持 *hook*，在每次用户 prompt 和每次 tool 调用前跑。mneme 附带两个可选 hook 脚本，会自动把
相关记忆推回对话里，Agent 不用记得主动查也能看到。

**opt-in，不用不影响 pull 模式。** 只用 pull 就跳过本节。

在 `~/.claude/settings.json`（或项目的 `.claude/settings.json`）里挂：

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "node /绝对路径/到/mneme/hooks/prompt-recall.mjs",
        "timeout": 5
      }]
    }],
    "PreToolUse": [{
      "matcher": "Bash|Grep|Read|Glob",
      "hooks": [{
        "type": "command",
        "command": "node /绝对路径/到/mneme/hooks/tool-recall-pre.mjs",
        "timeout": 5
      }]
    }]
  }
}
```

各自做什么：

- `prompt-recall.mjs` 每次用户 prompt 触发。如果 prompt 命中"基础设施 / how-to / 在哪"这类
  查询词、且库里有 ≥ 2 条 `importance ≥ 6` 的记忆，top 命中会通过 `additionalContext` 注入，
  Agent 回答前就能看到。
- `tool-recall-pre.mjs` 在 Bash / Grep / Read / Glob 前触发。从 tool 参数里抽 query
  （command 头 / grep pattern / 文件名 / glob 词干），surface 相关记忆——很多时候能让 Agent
  省掉这次工具调用。

两个 hook 都是 **detection-only**：任何错误（缺库 / spawn 挂 / 超时）静默 exit，不影响 prompt
或 tool 调用正常继续。session 内去重——同一条记忆在一个 Claude Code session 里不会重复注入。

### 环境变量（都可选）

| 变量 | 默认 | 含义 |
|-----|------|------|
| `MNEME_DB_PATH` | mneme 自带 `engram.db` | `TOKENMEM_DB_PATH` 的别名，选 DB 文件 |
| `MNEME_INDEX_PATH` | `<mneme>/index.mjs` | 覆盖引擎入口 |
| `MNEME_MIN_IMPORTANCE` | `6` | prompt-recall 命中门槛 |
| `MNEME_LEVEL` | `meta_knowledge` | prompt-recall level 过滤 |
| `MNEME_LIMIT` | `5` | prompt-recall 候选上限 |
| `MNEME_MIN_CONSENSUS` | `2` | prompt-recall 少于此数就不注入 |
| `MNEME_TOOL_MIN_IMPORTANCE` | `6` | tool-recall 命中门槛 |
| `MNEME_TOOL_LEVEL` | `meta_knowledge,semi_abstract` | tool-recall level 过滤 |
| `MNEME_TOOL_LIMIT` | `4` | tool-recall 候选上限 |
| `MNEME_TOOL_QUERY_LEN` | `120` | 从 tool 参数抽 query 的最大字符数 |
| `MNEME_STATE_DIR` | `~/.claude/hooks` | session 去重文件放哪 |
| `MNEME_TIMEOUT_MS` | `2800` | recall CLI 的 spawn 超时 |
| `MNEME_ALIAS_CACHE_TTL_MS` | `300000` | tool-recall hook 复用 `--list-paths` 快照的 TTL（毫秒；v2.8）|

### PreToolUse matcher 参照

`matcher` 是 Claude Code hook 的字段——决定哪些 tool 调用触发。几种常用形态：

```jsonc
// 只 Bash——最省，覆盖"我要执行命令"这个最高频瞬间
{ "matcher": "Bash", "hooks": [ /* ... */ ] }

// Bash + Grep + Read + Glob——推荐默认，代码/文件探查也覆盖
{ "matcher": "Bash|Grep|Read|Glob", "hooks": [ /* ... */ ] }

// 所有 tool 调用（很少用——通常噪音太大）
{ "matcher": ".*", "hooks": [ /* ... */ ] }

// MCP tool——例如只在自己那台 MCP server 的 tool 前触发
{ "matcher": "mcp__myserver__.*", "hooks": [ /* ... */ ] }
```

数组顺序有意义：同 matcher 的 hook 自上而下跑。如果你 `PreToolUse` 挂了多个（lint / block /
mneme 等），把 mneme 的 tool-recall 放靠前，让上下文先到，别的 hook 再加噪音。

### Debug——可选但推荐

自带 hook 默认静默，不弄脏你的终端。副作用是不好知道有没有真跑。两个轻量做法：

**方式 A · stderr 快速 trace**。用 shell one-liner 裹一层，记录跑没跑 + 耗时：

```jsonc
{
  "type": "command",
  "command": "node /绝对路径/到/mneme/hooks/prompt-recall.mjs; echo prompt-recall:$? >&2",
  "timeout": 5
}
```

Claude Code 会把 hook stderr 打进自己的 log。`$?` 永远 = 0（hook 设计成 fail-soft 全 exit 0），
但看到这一行就能证明 hook 被 invoke 了。

**方式 B · 追加 jsonl trace**。Fork `prompt-recall.mjs`，在每处 `process.exit(0)` 前加：

```js
import { appendFileSync } from 'node:fs'
try {
  appendFileSync(resolve(HOME, '.claude/hooks/mneme-trace.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), event: 'injected|silent|triggered', sessionId, hits: top?.length ?? 0 }) + '\n')
} catch {}
```

然后 `grep '"event":"injected"' ~/.claude/hooks/mneme-trace.jsonl | wc -l` 就知道记忆真正 surface
了多少次 vs hook 触发但被拦下（去重 / 无命中 / 低于门槛）多少次。上游 mneme 特意不做——留给你按
下游分析需求自己定格式。

### 排障

- Hook 从来不注入 → 检查 `~/.claude/settings.json` 格式正确、`command` 是绝对路径。手动跑一下：
  `echo '{"prompt":"怎么启动 daemon"}' | node hooks/prompt-recall.mjs`
- Prompt 看着能命中却静默 → 触发词是中英通用集。领域黑话多就 fork `prompt-recall.mjs` 里的 `TRIGGERS`
- DB 选错 → 设 `MNEME_DB_PATH`（或 `TOKENMEM_DB_PATH`）指向你实际想用的库。两个都不设就用
  `index.mjs` 旁边的 `engram.db`
- 注入太频 / 太少 → 调 `MNEME_MIN_IMPORTANCE` 和 `MNEME_MIN_CONSENSUS`。同一 session 内每条记忆
  只注一次是设计如此（session-scoped dedup）；跨 session 会再来

---

## 6. 维护 — 整理（consolidation）

只写不整的 mneme 会漂成垃圾抽屉。每一次 store 都在加噪音，不定期反向清就永远清不干净。
mneme 自带一套 primitive：

- `node index.mjs --health` — 只读五扫描报告（通胀 / 僵死 concrete / 完整性 / 盲区 /
  近重复），绝不写库。
- `node index.mjs --surface-cold [--days 30] [--min-importance 8]` — 列出 N 天没被访问过的
  高 importance 记忆，只读。是否 supersede / 合并 / 重标由 caller 决定。
- `node index.mjs --consolidate [--dry-run] [--level-anchor PATH]` — 机械 nightly pipeline：
  `expireMemories` → `runDecayCycle` → `runLevelMigration`，按此序跑。`--dry-run` 只预览；
  `--level-anchor` 在 level 迁移前写 JSONL rollback。

两步循环：**surface → apply**。**不要**基于 cosine 阈值自动合并、也不要基于相似度自动
supersede —— 那会静默删掉信号。

完整 recipe 在 [`docs/recipes/nightly-consolidation.md`](recipes/nightly-consolidation.md)。

---

## 7. 路径别名（`locations`）

不是每个"XX 在哪"都是记忆问题。`godot → E:/tools/godot`、`download → E:/download`、
`docs → https://docs.example.com` 都是**精确匹配 KV**，走 FTS + vector + RRF
既掉精度又慢。v2.8 加一张 `locations` 表（name / path / kind / aliases / notes）
跟 `memories` 并列：

- **CLI**：`--set-path <name> <path>` / `--get-path <nameOrAlias>` /
  `--list-paths` / `--delete-path` / `--import-paths <file.json>`。
- **MCP tools**：`resolve_path` / `set_path` / `list_paths` / `delete_path`。
  Agent 可以像 `store_memory` 一样注册和查询路径别名。
- **Hook 前置**：`hooks/tool-recall-pre.mjs` 从 Bash / Read / Grep / Glob 参数里
  抽 identifier-shaped token，命中就把解析路径挂在 recall 前面（短 TTL 缓存）。

判据：**答案是路径 / URL → `locations`；答案是一段话 → `memories`。**
当前路径存 `locations`、"6 月为啥搬"存 `memories`。

完整 recipe 在 [`docs/recipes/paths-alias-layer.md`](recipes/paths-alias-layer.md)。

---

## TL;DR

1. 用 MCP 接上 mneme（§3）。
2. 把 §1 的块粘进你 Agent 的指令文件（§2）。
3. 最重要的几条规则：**存是一道闸、`semi_abstract` 是默认、`meta` 要挣、importance 是弱 prior、
   覆盖而非重写。** 这就是让记忆保持锋利而不膨胀的关键。
4. 可选：如果在 Claude Code 上想让记忆自动 surface，装 §5 的 auto-recall hook。
5. 每周跑一次 §6 的 `--health` review —— 只有反向压回来记忆库才会越用越锋利。
6. 把常用 handle 注册进 `locations`（§7）—— `godot → E:/tools/godot`、
   `download → E:/download`。一次 lookup vs 一次 glob 整个大目录树的差别。
