# codex-recovery-proxy

> mneme 首个 **host adapter** —— 一个 stdio→HTTP recovery proxy，让 [Codex Desktop](https://openai.com/codex/) 在遇到已知的 MCP session wedge bug 时不影响 mneme 使用。

## 为什么需要它

Codex Desktop 有一个未修复的上游 bug（[openai/codex#32470](https://github.com/openai/codex/issues/32470)）：一个长驻的 Streamable HTTP MCP session 在某次 tool call 丢失 `completion` 事件之后，**该 session 之后所有调用会永久 pending 不返回**（也不 timeout）。整个 codex↔mneme 通道被"卡死"直到用户手动重开 codex task 或重载 Desktop。

这个 bug 不是 mneme 的问题，是 codex 客户端的 completion event 追踪层的问题。但**用户体验受伤**——mneme 完全健康却看起来"挂了"。

## 这个 proxy 干什么

不修 codex 的 bug（那要上游修），而是**让 bug 不能传播**：

- codex 侧仍看到一个 stdio MCP server（`chinatsu-memory`）
- proxy 内部把每次 `tools/list` 或 `tools/call` 转成一次**独立的 HTTP session** 打到真 mneme server
- 每次调用**结束即 DELETE session**，30 秒有界 timeout
- **写调用绝不自动重试**（保 at-most-once 语义，不会导致重复 store_memory）
- `Authorization: Bearer <token>` header 逐调用透传，mneme server 看到的 bearer 与直连模式**完全一致**（proxy 不修改、不缓存、不加工 auth header）

**架构效果**：单次 tool call 如果 wedge，只污染那一次；下次调用是全新 session，不受影响。

## 装法

假设 mneme 已经装在你机器上、跑在 `http://127.0.0.1:18792/mcp`。

### 1. Codex config

编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.chinatsu-memory]
command = "node"
args = ["<mneme-path>/adapters/codex-recovery-proxy/proxy.mjs"]
env_vars = ["MNEME_TOKEN_CODEX"]
startup_timeout_sec = 20
tool_timeout_sec = 40

[mcp_servers.chinatsu-memory.env]
MNEME_HTTP_URL = "http://127.0.0.1:18792/mcp"
MNEME_PROXY_TIMEOUT_MS = "30000"
```

### 2. 环境变量

**Windows**：`setx MNEME_TOKEN_CODEX "<your token>"`（然后**完全退出 Codex Desktop 重开**——`setx` 只对新进程生效）

**macOS/Linux**：`export MNEME_TOKEN_CODEX=<your token>` in `~/.zshrc` 或 `~/.bashrc`

### 3. 验证

```bash
# 独立 smoke（不经 codex）
MNEME_TOKEN_CODEX=<token> node adapters/codex-recovery-proxy/smoke.mjs

# 完整故障注入测试
node adapters/codex-recovery-proxy/proxy.test.mjs
```

- Smoke 通过 = proxy 到真 mneme 的路通了
- Test 通过（`fresh sessions=60, calls=59, live sessions=0`）= 60 个故障注入下无 session 泄漏

## 环境变量

| Var | 默认 | 说明 |
|---|---|---|
| `MNEME_HTTP_URL` | `http://127.0.0.1:18792/mcp` | 真 mneme HTTP endpoint |
| `MNEME_TOKEN_CODEX` | **必填** | Bearer token — proxy 逐调用透传给 mneme HTTP endpoint |
| `MNEME_PROXY_TIMEOUT_MS` | `30000` | 单次请求 timeout |
| `MNEME_PROXY_CLOSE_TIMEOUT_MS` | `2000` | 关闭 remote session 的 timeout |

## 归档策略（上游修好后）

**这是补丁不是能力**。当 [openai/codex#32470](https://github.com/openai/codex/issues/32470) 修复且验证稳定后：

1. codex 配置改回直连 mneme HTTP（不经 proxy）
2. 保留本目录作为"故障期实证方案"归档，不删除（未来别的 host 遇到类似 wedge 时可复用架构）
3. README 顶部加"⚠️ 上游已修复，此 adapter 现为归档参考"标记

## 什么时候你需要类似的 adapter

如果你在给 mneme 接入一个**新 host**（Cursor / Cline / Windsurf / …），发现：

- 遇到 host-specific 的 MCP 传输层 bug
- host 有独特的 auth / capability negotiation 要求
- 需要 host-specific 的 shim（比如 stdio↔HTTP 转换）

那 `adapters/<host-name>/` 是这类适配层的位置。**约定**：

- 只做 host 适配，**不改 mneme server 一行**
- 上游 fix 后可归档，不影响 mneme 主线
- 独立 README 讲清楚：治什么问题、上游 issue、装法、归档条件
