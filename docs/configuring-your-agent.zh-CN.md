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

## TL;DR

1. 用 MCP 接上 mneme（§3）。
2. 把 §1 的块粘进你 Agent 的指令文件（§2）。
3. 最重要的几条规则：**存是一道闸、`semi_abstract` 是默认、`meta` 要挣、importance 是弱 prior、
   覆盖而非重写。** 这就是让记忆保持锋利而不膨胀的关键。
