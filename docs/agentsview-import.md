# Chronicle → AgentsView 网页对话桥接

> 创建日期：2026-09-26
> 最后更新：2026-09-27
> 版本：2.1

## 方案结论

采用 **WRAP**：Chronicle 负责网页对话采集和只读档案，同步脚本通过正在运行的 AgentsView 守护进程的公开 HTTP 接口写入；不 fork AgentsView，不直接写 `sessions.db`，不修改 Chronicle 数据库。

| 路径 | 结论 | 原因 |
| --- | --- | --- |
| 守护进程 `POST /api/v1/import/chatgpt`（zip）/ `claude-ai` | 默认采用 | 官方 AgentsView v0.44.0 路径；ChatGPT 已有会话仍会跳过，脚本读回目标消息核对全文，过期内容留在 pending 并报错。另有一个尚未部署的本地 AV 补丁实现 ChatGPT 仅追加更新；未包含在官方二进制能力承诺中。 |
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

- 增量：状态文件（默认 `%APPDATA%\hstry\agentsview-sync.json`）按“服务 + external_id”记录消息数和更新时间。确认前逐条核对 AV 消息的角色、文本和顺序；ChatGPT 每轮也重核已有确认项，以便找回旧脚本错误确认的过期会话。只有完整匹配才确认，过期或读取不完整的会话保持 pending 并报错。`-Full` 全量重发。
- 备份：第一次真实写入前用 SQLite 在线备份 API（需要 `python`）把 `sessions.db` 完整复制到 `-BackupRoot`，附 SHA-256 manifest；之后的增量不再备份，需要时加 `-Backup`。
- 守护进程在做全量 `pg push` 等工作时，导入请求会排队；单个请求超时由 `-RequestTimeoutSec` 控制（默认 1800 秒）。
- `-ChronicleConfig` 可指定另一份 Chronicle 配置（例如让 `adapter_paths` 指向本仓库的 `adapters/`）。

## 已知限制

- ChatGPT：官方 AgentsView v0.44.0 导入器遇到已存在的会话直接跳过；网页端追加后，脚本会报告 pending/error，不会把 `skipped` 当作完成。另一个本地、未部署的 AV 补丁支持严格验证后的仅追加更新；除非该补丁单独发布并安装，否则这里不假设该能力存在。Claude 按 UUID 更新。Gemini / Grok 使用原生文件；覆盖前脚本要求现有目标内容是新导出的完整前缀，避免以较短或冲突文本覆盖更完整会话。
- Gemini / Grok 在 AgentsView 中显示为 `gemini` / `grok` agent，靠 project `gemini_web` / `grok_web` 区分网页来源。

## 验收口径

1. `-DryRun` 的 `unique` 等于 Chronicle 中按 external_id 去重后的对话数。
2. 真实运行后，AgentsView 中 `chatgpt.com` / `claude.ai` / `gemini_web` / `grok_web` 的会话数与 `unique` 一致，消息总数与 Chronicle 对应 source 一致。
3. `agentsview session search <词> --project <project>` 能搜到网页对话正文。
4. 立即重跑时各服务 `changed=0`。
