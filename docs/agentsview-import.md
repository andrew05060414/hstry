# Chronicle → AgentsView 网页对话桥接

> 创建日期：2026-09-26
> 最后更新：2026-09-27
> 版本：2.0

## 方案结论

采用 **WRAP**：Chronicle 负责网页对话采集和只读档案，同步脚本通过正在运行的 AgentsView 守护进程的公开 HTTP 接口写入；不 fork AgentsView，不直接写 `sessions.db`，不修改 Chronicle 数据库。

| 路径 | 结论 | 原因 |
| --- | --- | --- |
| 守护进程 `POST /api/v1/import/chatgpt`（zip）/ `claude-ai` | 采用 | 官方导入器；不需要停守护进程（CLI `agentsview import` 在守护进程运行时拒绝写库） |
| 专用目录 + `[agents.<agent>] dirs` + 一次 `POST /api/v1/sync?wait=true` | 采用（Gemini、Grok） | 走 AgentsView 原生 Gemini / Grok 解析器；文件长期保留；写完全部文件后同步一次，再按会话 ID 逐个确认（逐个调 `sessions/sync` 在繁忙的守护进程上每个要几秒到几分钟） |
| `POST /api/v1/sessions/upload` | 不采用 | 实测只解析 Claude Code JSONL：Gemini 文件会变成 0 条消息、agent 为 `claude` 的空会话 |
| `gemini-apps` Takeout 导入 | 不采用 | 每条 Prompted 活动一个单轮会话，丢失多轮结构和回答 |
| 给 AgentsView 上游提通用导入格式 | 暂缓 | 需 Andrew 先确认 |

## 来源映射

| 服务 | Chronicle source（按 adapter / id 选择） | AgentsView 入口 | AgentsView agent / project |
| --- | --- | --- | --- |
| ChatGPT | adapter `chatgpt-web`、`chatgpt` | `import/chatgpt`（zip 内含 `conversations.json`） | `chatgpt` / `chatgpt.com` |
| Claude | adapter `claude-web` | `import/claude-ai` | `claude-ai` / `claude.ai` |
| Gemini | adapter `gemini` | `<SessionRoot>/gemini/tmp/gemini-web/chats/session-<id>.jsonl` + 同步一次 | `gemini` / `gemini_web` |
| Grok | source id `grok-web*`（Grok CLI 也用 `grok` adapter，所以按 id 区分） | `<SessionRoot>/grok/grok-web/<id>/summary.json` + 同步一次 | `grok` / `grok_web` |

同一网页对话可能同时出现在官方导出和浏览器扩展两个 source 中，脚本按 `external_id` 去重，保留消息最多、更新时间最新的一份。

## 一次性配置

在 `~/.agentsview/config.toml` 中把专用目录加入 Gemini / Grok 的扫描目录。这个设置会覆盖默认目录，所以必须把默认目录一并写上（用绝对路径），然后重启守护进程：

```toml
[agents.gemini]
dirs = ["C:/Users/<you>/.gemini", "<SessionRoot>/gemini"]

[agents.grok]
dirs = ["C:/Users/<you>/.grok/sessions", "<SessionRoot>/grok"]
```

`<SessionRoot>` 默认是 `%APPDATA%\hstry\agentsview-web`，可用 `-SessionRoot` 指定。脚本在真实写入前检查守护进程可达、目录已配置，不满足就报错退出。

## 运行

```powershell
pwsh -File scripts/agentsview-sync.ps1 -DryRun       # 只统计，不写
pwsh -File scripts/agentsview-sync.ps1               # 执行一轮
pwsh -File scripts/agentsview-sync.ps1 -Provider claude,gemini
pwsh -File scripts/agentsview-sync.ps1 -Watch -IntervalSeconds 900
```

- 增量：状态文件（默认 `%APPDATA%\hstry\agentsview-sync.json`）按“服务 + external_id”记录消息数和更新时间，只处理变化项；批次成功后才推进状态，带错误的批次下一轮重试。`-Full` 全量重发（AgentsView 侧幂等）。
- 备份：第一次真实写入前用 SQLite 在线备份 API（需要 `python`）把 `sessions.db` 完整复制到 `-BackupRoot`，附 SHA-256 manifest；之后的增量不再备份，需要时加 `-Backup`。
- 守护进程在做全量 `pg push` 等工作时，导入请求会排队；单个请求超时由 `-RequestTimeoutSec` 控制（默认 1800 秒）。
- `-ChronicleConfig` 可指定另一份 Chronicle 配置（例如让 `adapter_paths` 指向本仓库的 `adapters/`）。

## 已知限制

- ChatGPT：AgentsView 导入器遇到已存在的会话直接跳过，网页端之后追加的消息不会更新到 AgentsView（结果中计为 `skipped`）。Claude 会按 UUID 更新，Gemini / Grok 通过重写文件更新。
- Gemini / Grok 在 AgentsView 中显示为 `gemini` / `grok` agent，靠 project `gemini_web` / `grok_web` 区分网页来源。

## 验收口径

1. `-DryRun` 的 `unique` 等于 Chronicle 中按 external_id 去重后的对话数。
2. 真实运行后，AgentsView 中 `chatgpt.com` / `claude.ai` / `gemini_web` / `grok_web` 的会话数与 `unique` 一致，消息总数与 Chronicle 对应 source 一致。
3. `agentsview session search <词> --project <project>` 能搜到网页对话正文。
4. 立即重跑时各服务 `changed=0`。
