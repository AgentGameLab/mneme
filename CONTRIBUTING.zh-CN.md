# 为 mneme 贡献

感谢你对 mneme 感兴趣 —— 一个本地优先、为 Claude Code agent 设计的持久长期记忆层
（SQLite + FTS5 + sqlite-vec + RRF，通过 MCP 暴露）。

[English version →](CONTRIBUTING.md)

## 设计价值观（先读这条）

mneme 只做优雅降级，绝不致命退出。贡献代码时最重要的一条规则：

- **可选的东西必须保持可选。** 向量路径（sqlite-vec）和中文分词器
  （wangfenjin/simple）都是*增强项*。两个扩展都不在时，mneme 仍须能启动、写入、
  召回 —— 退回 FTS5（`unicode61`），最终退回 `LIKE` 匹配。任何让核心路径**依赖**
  某个扩展的改动都是回归，哪怕你本机装了它。
- **读失败要 fail-open，无法校验的写要 fail-closed。** 召回不到东西返回空，不是
  报错；无法校验输入的写入应当拒绝，而不是污染记忆库。

## 开发环境

依赖：

- Node.js 20+（CI/开发在 24 上验证）
- `npm install` —— 唯一的硬依赖是 `better-sqlite3`（原生模块，需要 C++ 工具链；
  Node 24 上需 `better-sqlite3` >= 12）。

可选原生扩展（把预编译二进制放到 `lib/` 下）：

- `sqlite-vec` —— 向量 KNN 检索。没有它，召回只走 FTS5。
- `wangfenjin/simple` —— 中文词级 FTS5 分词器（jieba）。没有它，schema 默认
  `unicode61`，而 `initMemory()` 会在扩展一出现就自动升级回 `simple`。

嵌入（可选）完全由环境变量配置 —— 见 README 的 Configuration 表。不设
`EMBEDDING_API_*` 时，mneme 纯 FTS 运行。

## 本地运行

```bash
# CLI：写入 / 召回往返
node index.mjs --recall "你的查询" --format json

# MCP server（stdio 给 Claude Code，或 HTTP 给共享 daemon）
node mcp-server.mjs                       # stdio
node mcp-server.mjs --transport=http --port=18790
```

开发时用 `TOKENMEM_DB_PATH=/tmp/scratch.db` 指向临时库，绝不碰真实记忆库。

## 项目结构

| 路径 | 作用 |
|------|------|
| `index.mjs` | 核心：schema 初始化、迁移、写入、混合召回（FTS5 + 向量 + RRF）、衰减 |
| `mcp-server.mjs` | MCP server（stdio + HTTP 两种传输），暴露 `store_memory` / `recall_memory` / `memory_stats` |
| `schema.sql` | 表 + FTS5 虚表 DDL。新列走 `migrations/`，不要原地改表 |
| `migrations/` | 只前进、幂等（`IF NOT EXISTS` / 带守卫的 `ALTER`）—— 老库必须能干净升级 |
| `backfill-embeddings.mjs` | 给配置嵌入之前存的行回填向量 |
| `migrate-claude-memories.mjs` | 从 Claude Code 扁平文件记忆一次性导入 |

## 开 PR 之前

没有重型测试框架 —— 验证靠手动，PR 需要展示验证过程：

1. **无扩展也能 fresh 启动。** 用全新的 `TOKENMEM_DB_PATH`、`lib/` 下不放扩展跑
   `index.mjs`，确认所有表都建出来、写入→召回往返正常。（schema 写死分词器时这条
   路曾经崩过 —— 别再引入。）
2. **老库仍能迁移。** 拿一份有数据的拷贝跑，确认迁移第二次是 no-op 且不丢数据。
3. **风格贴合周边代码。** 命名、注释密度、写法一致。注释只用来说明代码本身表达不出
   的约束。
4. 改过的每个文件都 `node --check` 一遍。

PR 保持聚焦 —— 一个 PR 一件事。schema 改动作为 `migrations/` 下的新文件发布，绝不
原地改已有迁移。

## 报告问题

有用的 bug 报告包含：你的 Node 版本、可选扩展是否存在、完整命令、失败输出。召回质量
类问题，附上查询、你的预期、实际返回，最好定位。

提交贡献即表示你同意你的贡献以 [MIT License](LICENSE) 授权。
