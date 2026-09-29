# AGENTS.md

> 创建日期：2026-02（继承自上游 byteowlz/hstry，2026-09-28 按本 fork 重写）
> 最后更新：2026-09-28
> 版本：2.0

Chronicle（命令 `chronicle`，兼容名 `hstry`）是 Andrew 的对话档案：采集各 agent 和网页 AI 的聊天记录，存档、备份、多机汇总，并提供检索。它不是任务看板，也不派发工作。

本文件是本 fork 的唯一项目规则，不再沿用上游 byteowlz 的工作流（`trx`、`byt`、`mmry`、Homebrew/AUR 发布等）。上游历史文件（如 `.trx/`）只读保留，不要创建、更新或依赖它们。

## 职责边界（2026-09-27 分工，见 `docs/chronicle-agentsview-split.md`）

- **Chronicle / hstry 负责**：浏览器插件网页采集（`/ingest`）、存档正本、`chronicle backup`（3-2-1）、多机汇总到 NAS、`resume`、`export`。
- **AgentsView 负责**：搜索、浏览界面、记忆提炼。新的检索类需求优先放到 AgentsView，不在这里重复建设。
- 本机 agent 日志的适配器仍在跑，是否停用等 restic 原始文件备份稳定后再定。

## 工作方式

- 任务追踪用 GitHub Issues（本仓库），PR 关联对应 issue。
- `main` 有分支保护，改动走 PR；提交、push、开 PR 按 Andrew 的全局规则授权。
- 不发布到任何公共包仓库，不创建 release tag，除非 Andrew 明确要求。
- 倾向就地重构，不留 `FooV2` 之类的兼容壳；文件头不加作者/时间横幅。
- 行为在 Windows 11、Linux、macOS 14+ 上保持一致；Andrew 主力机是 Windows，NAS 是 Linux。

## Rust

- 遵循 Clippy 习惯：合并琐碎的 `if`、`format!` 内联参数、用方法引用代替多余闭包。
- 测试比较结构体时断言整个值，不逐字段断言。
- 改完跑 `cargo fmt` 和**被改到的 crate** 的 `cargo test`（`just test-crate <crate>`）。`just check-all`（fmt + clippy + 全量测试）只在 PR 前或 Andrew 要求时跑。
- **Windows 上后台启动子进程必须加 `CREATE_NO_WINDOW`。** 服务本身没有控制台，漏加会让 node 适配器、ssh/scp 等每次运行都弹出终端窗口（见 #72）。新增任何 `Command::new` 都要检查这一点。

## CLI 约定

- 动词用子命令；安静/详细输出用标准参数（`-q`、可叠加的 `-v`、`--debug`、`--trace`）。
- 支持 `--json` 等机器可读输出，遵守 `NO_COLOR` / `FORCE_COLOR`。
- 需要时提供 `--dry-run`、`--yes/--force`、`--no-progress`、`--timeout`、`--parallel`。
- 帮助和 shell 补全都来自同一套 Clap 定义。

## 配置、数据与部署（本机实际路径）

- Windows 配置：`%APPDATA%\hstry\config.toml`；适配器：`%APPDATA%\hstry\adapters\`；Linux/macOS 用 `~/.config/hstry/`。操作前先确认实际配置和路径，不要假设 XDG。
- Windows 上作为服务 `chronicle`（WinSW，LocalSystem）运行，可执行文件是 `~/.cargo/bin/hstry.exe`（2026-09-29 起；此前是 `chronicle.exe`，该别名已移除，服务切换需管理员）。服务运行时文件被锁：升级按 README 的 "Upgrading a machine that runs the service"——停服务（需要管理员）→ `cargo install --path crates/hstry-cli --locked` → 启服务。本地 HTTP：`127.0.0.1:3000`（插件 `/ingest`）。
- 浏览器插件从 `origin/main` 导出到固定目录：`just install-extension`（见 README "Browser extension"）。
- 不提交密钥或敏感路径；日志给出前先脱敏。档案数据库是 Andrew 的长期记录，不要删除、重建或截断。

## 适配器

适配器是 `adapters/<name>/adapter.ts` 下的 TypeScript 模块，由 Rust 运行时以子进程启动（Bun / Deno / Node，见 `crates/hstry-runtime/src/runner.rs`），通过 JSON 通信。

- 改完适配器先部署再测试：Windows 用 `just update-adapters-windows`，其他平台 `just update-adapters`。CLI 从配置目录加载适配器，不读源码目录。
- 直接测试：设置 `HSTRY_REQUEST='{"method":"detect","params":{"path":"..."}}'`（或 `parse`，可带 `"opts":{"limit":1}`）后运行已部署的 `adapter.ts`。
- 类型契约：时间戳必须是整数毫秒（浮点秒用 `Math.floor()` 转）；Rust 侧 `ParsedConversation.created_at` 是 `i64`，浮点会反序列化失败。响应类型在 `adapters/types/index.ts`，须与 `runner.rs` 一致。
- 可选字段 `version`、`messageCount` 只是提示，数据库的值为准，适配器不得依赖它们保证写入正确。
- 常见错误："Could not detect format" = `detect()` 返回 null；"data did not match any variant" = 类型不符（多半是浮点时间戳）；"No conversations found" = `parse()` 返回空。

## Justfile

`just` 列出全部命令。常用：`just build`、`just test-crate <crate>`、`just clippy-crate <crate>`、`just fmt`、`just check`（快速编译检查）、`just install-all`、`just install-extension`、`just update-adapters(-windows)`。
