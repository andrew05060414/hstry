# NAS Hub 多机部署手册（AI 可执行）

> **用途**：在飞牛 NAS（Linux）+ Windows + Mac 上部署 hstry hub/satellite 架构。  
> **产品合同**（备份/恢复/采集范围）：[`archive-model.md`](./archive-model.md)。  
> **交给 AI 时**：把下方「变量表」填好，然后说「按 `docs/nas-hub-setup.md` 执行 Phase 1–4」。

---

## 架构（30 秒理解）

```
Win / Mac（satellite）                飞牛 NAS（hub）
─────────────────────                ────────────────
读本机 Cursor/Codex/Pi/OpenCode…      存主库 hstry.db
  ↓ 解析 → 本地 staging.db（暂存）       service 常开
  ↓ push（每 5 min）                    mmry 定时导入
搜索：satellite 默认 `hstry search` 打 hub（trx-1xsa）；`--scope local` 只搜本机 staging
```

- **采集必须在每台有 AI 工具的机器上做**（NAS 读不到 `%APPDATA%\Cursor`）。
- **主库、搜索、备份在 NAS**。云盘快照与本机 restore 见 [`restore.md`](./restore.md)。
- 各机器数据用 `device_id` + remote 名前缀区分，**不会混成一团**。

---

## 变量表（Andrew 环境 — 已填写）

| 变量                 | 值                                              | 说明                         |
| -------------------- | ----------------------------------------------- | ---------------------------- |
| `NAS_HOST`           | `admin@memini-b506.tail76a98f.ts.net`           | 推荐 Tailscale FQDN          |
| `NAS_HOST_ALT`       | `admin@100.73.230.28` / `admin@memini-b506`     | 备选                         |
| `NAS_ROOT`           | `/vol1/1000/Code/hstry backup`                  | 含空格，命令需加引号         |
| `NAS_DB`             | `/vol1/1000/Code/hstry backup/hstry.db`         | Hub 主库                     |
| `REMOTE_NAME`        | `nas`                                           | Win/Mac remote 固定名        |
| `WIN_DEVICE_ID`      | `arknights`                                     | Windows satellite 标识（`sync.device_id`） |
| `MAC_DEVICE_ID`      | `macbook`                                       | Mac satellite 标识           |
| `WIN_STAGING_DB`     | `D:/Data/hstry/staging.db`                        | Windows 暂存库               |
| `MAC_STAGING_DB`     | `~/.local/share/hstry/staging.db`               | Mac 暂存库                   |
| `HSTRY_VERSION`      | `1.0.0`                                         | 全机版本一致                 |
| `PUSH_INTERVAL_SECS` | `300`                                           | satellite → hub 推送间隔     |

**当前验收（2026-07-25）：** Hub **2154** 会话 / **89352** 消息 / **20** sources（`macbook:*` + `arknights:*` merge 成功）。分支与上游拆分见 [`andrew-nas-branch-notes.md`](./andrew-nas-branch-notes.md)；通用 sync 说明见 [`remote-sync.md`](./remote-sync.md)。

**Handoff 文档：**

- NAS：`docs/nas-hub-handoff.md`
- Mac：`docs/mac-satellite-handoff.md`

### ⚠️ Satellite 必填 `database_path`（Win / Mac 相同问题）

Hub 主库**不在**默认的 `~/.local/share/hstry/hstry.db`，而在：

```
/vol1/1000/Code/hstry backup/hstry.db
```

每台 satellite（Windows `%APPDATA%\hstry\config.toml`、Mac `~/.config/hstry/config.toml`）的 `[[remotes]]` **必须**写：

```toml
database_path = "/vol1/1000/Code/hstry backup/hstry.db"
```

与 NAS 上 `~/.config/hstry/config.toml` 里的 `database = "..."` **完全一致**（含空格，整段加引号）。  
漏配时 push 会打到 NAS 默认路径（不存在）→ 失败或写到错误位置。

### ⚠️ 禁止 Win + Mac 同时 push

两边 `auto_sync` 同时 push 会并发覆盖同一个 `hstry.db`，导致 `database disk image is malformed` 或 SCP 中断留下半截文件。

**规则：**

1. 只让**一台**先 push，完成后再开另一台。
2. push 前可临时关另一侧：`auto_sync = false`，或 `hstry service stop`。
3. 若 Hub 损坏，在 NAS 上从备份恢复后再 push：

```bash
cd "/vol1/1000/Code/hstry backup"
cp -a hstry.db hstry.db.broken-$(date +%Y%m%d-%H%M%S)
cp -a hstry.db.pre-win-push-* hstry.db   # 或最新可用 .local-backup-* / 手动备份
rm -f hstry.db-wal hstry.db-shm
hstry stats   # 应能正常输出
```

### ⚠️ Push 必须真正 merge（验收清单）

成功 push **不会**在日志里从 `001_initial_schema` 跑全套 migration（那表示在空库上 merge，会覆盖 Hub）。

```bash
# NAS 上
hstry stats          # 会话数 ≈ 各 satellite 之和
hstry source list    # 应同时有 macbook:* 与 arknights:*（或你的 device_id）
```

Windows 从源码安装后确认二进制日期：

```powershell
(Get-Item "$env:USERPROFILE\.cargo\bin\hstry.exe").LastWriteTime
Copy-Item -Force "D:\Andrew\Code\Github\hstry\target\release\hstry.exe" "$env:USERPROFILE\.cargo\bin\hstry.exe"
```

若环境变量 `CARGO_TARGET_DIR` 指向别处，repo 内 `target\release\hstry.exe` 可能是旧的。

### ⚠️ SSH：Tailscale vs 局域网

| 场景 | `[[remotes]].host` |
|------|---------------------|
| 外出 / Tailscale 已授权 | `admin@memini-b506.tail76a98f.ts.net` |
| 在家、Tailscale SSH 要浏览器验证 | `memini-b506`（`~/.ssh/config` → `192.168.0.102`） |

```powershell
ssh memini-b506 echo ok   # 局域网探活
```

---

## Phase 0：前置依赖

### 所有机器

- [ ] Tailscale 已安装且同一 tailnet；`tailscale status` 能看到彼此 **direct**
- [ ] SSH 密钥登录 NAS：`ssh $NAS_HOST echo ok`

### NAS（Linux）

```bash
# 按发行版安装（飞牛底层 Linux，用 apt/yum 或 fnOS 包管理）
# 必需：openssh-server, node (LTS), jq
# 编译安装时需要：protoc, rust toolchain
# 或下载 GitHub Release 二进制放到 /usr/local/bin/hstry

hstry -V    # 应输出 $HSTRY_VERSION
node -v
```

### Windows

```powershell
# rust / cargo（若从源码装）或 cargo install --path crates/hstry-cli
winget install OpenJS.NodeJS.LTS
winget install Google.Protobuf   # 仅源码编译需要

hstry -V
node -v
```

### Mac

```bash
brew install node
# brew install hstry  或 cargo install
hstry -V
```

---

## Phase 1：NAS Hub 配置

SSH 到 NAS，以 `admin` 为例：

```bash
export NAS_DB_DIR="/vol1/1000/data/hstry"
mkdir -p "$NAS_DB_DIR"
mkdir -p ~/.config/hstry/adapters

cat > ~/.config/hstry/config.toml << 'EOF'
database = "NAS_DB_DIR/hstry.db"
js_runtime = "node"
adapter_paths = ["~/.config/hstry/adapters"]
sources = []
adapters = []
remotes = []

[service]
enabled = true
poll_interval_secs = 600
search_api = true
transport = "tcp"

[sync]
mode = "hub"
auto_sync = false

[search]
index_batch_size = 500
EOF

# 把 NAS_DB_DIR 替换成实际路径（sed 或手动编辑）
sed -i "s|NAS_DB_DIR|$NAS_DB_DIR|g" ~/.config/hstry/config.toml
```

安装 adapter 依赖（hub 一般不采集 Cursor，但保持版本一致）：

```bash
# 从官方 repo 复制 adapters（或 git clone --depth 1 --branch v$HSTRY_VERSION）
# 然后：
cd ~/.config/hstry/adapters
npm install

hstry service start
hstry service status    # 应 running
hstry stats             # 初始可为空
```

**验证**：从 Windows/Mac 执行 `ssh $NAS_HOST hstry stats`。

---

## Phase 2：Windows Satellite

### 2.1 安装 adapters

```powershell
# 在仓库根目录，或：
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-adapters.ps1

cd $env:APPDATA\hstry\adapters
npm install
```

### 2.2 配置文件

编辑 `%APPDATA%\hstry\config.toml`（注意路径用正斜杠）：

```toml
database = 'WIN_STAGING_DB'
js_runtime = "node"
adapter_paths = [
    'C:/Users/Andrew/AppData/Roaming/hstry/adapters',
]

[[remotes]]
name = "nas"
host = "NAS_HOST"
enabled = true
# 必填：Hub 主库路径（与 NAS 上 ~/.config/hstry/config.toml 的 database= 一致）
database_path = "/vol1/1000/Code/hstry backup/hstry.db"

[sync]
mode = "satellite"
device_id = "WIN_DEVICE_ID"   # push 前缀：arknights / macbook-pro 等，勿用 local
hub_remote = "nas"
auto_sync = true
auto_sync_interval_secs = 300

[service]
enabled = true
poll_interval_secs = 600
search_api = true
transport = "tcp"
```

### 2.3 添加数据源

```powershell
hstry scan

# 推荐至少加这些（按 scan 结果调整）：
hstry source add "$env:APPDATA\Cursor\User\globalStorage"
hstry source add "$env:USERPROFILE\.codex\archived_sessions"
hstry source add "$env:USERPROFILE\.claude\projects"
hstry source add "$env:USERPROFILE\.local\share\opencode"
hstry source add "$env:USERPROFILE\.pi\agent\sessions"

hstry source list
```

### 2.4 启动与首次推送

```powershell
New-Item -ItemType Directory -Force (Split-Path "WIN_STAGING_DB")
hstry service start
hstry sync                              # 采本机数据到 staging

# 推送前：Cursor 多 source 去重（先 dedup 再 prune）
hstry dedup --cross-source --dry-run
hstry dedup --cross-source
hstry source prune-cursor --dry-run
hstry source prune-cursor --auto-remove
hstry source cleanup --auto-remove      # 同路径重复注册（如 cursaves 双份）

hstry remote test nas
hstry remote sync --remote nas --direction push -v
```

推送后 NAS 上 source 前缀为 **`{device_id}:`**（如 `arknights:cursor-…`、`macbook:cursor-…`），不再是 `local:`。

### 2.5 日常搜索（问 NAS，不依赖本地全量）

```powershell
hstry search "关键词" --scope remote --remote nas
hstry search "关键词" --scope all --remote nas   # staging + NAS
```

---

## Phase 3：Mac Satellite

`~/.config/hstry/config.toml`：

```toml
database = "MAC_STAGING_DB"
js_runtime = "node"
adapter_paths = ["~/.config/hstry/adapters"]

[[remotes]]
name = "nas"
host = "NAS_HOST"
enabled = true
database_path = "/vol1/1000/Code/hstry backup/hstry.db"

[sync]
mode = "satellite"
device_id = "MAC_DEVICE_ID"
hub_remote = "nas"
auto_sync = true
auto_sync_interval_secs = 300

[service]
enabled = true
search_api = true
transport = "tcp"
```

```bash
# adapters
just update-adapters 2>/dev/null || cp -r /path/to/hstry/adapters ~/.config/hstry/
cd ~/.config/hstry/adapters && npm install

hstry scan
hstry source add ~/Library/Application\ Support/Cursor/User/globalStorage
hstry source add ~/.codex/archived_sessions
hstry source add ~/.claude/projects
hstry source add ~/.local/share/opencode
hstry source add ~/.pi/agent/sessions

hstry service start
hstry sync
hstry remote test nas
hstry remote sync --remote nas --direction push
```

---

## Phase 4：验收清单（AI 逐项执行）

```bash
# 在 NAS 上
ssh $NAS_HOST hstry stats
# 应看到 win-pc:* 和 macbook:* 前缀的 source

# 在 Windows 上
hstry remote status
hstry search "test" --scope remote --remote nas --limit 3

# 在 Mac 上（同上）
hstry search "test" --scope remote --remote nas --limit 3

# Tailscale 直连
tailscale ping fnos   # 替换为 NAS 主机名
```

| 检查项          | 通过标准                                    |
| --------------- | ------------------------------------------- |
| NAS service     | `running`                                   |
| Win/Mac service | `running`                                   |
| remote test     | 无 SSH 错误                                 |
| NAS stats       | 有 `win-pc:cursor-*`、`macbook:cursor-*` 等 |
| 跨机搜索        | Win 能搜到 Mac 会话标题（反之亦然）         |

---

## Phase 5：NAS → Agent Memory（可选）

在 NAS 上 cron（每天限量，避免压垮 mmry）：

```bash
# crontab -e
0 3 * * * hstry mmry extract --store chat-memories --after "yesterday" --limit 50 >> /var/log/hstry-mmry.log 2>&1
```

或用仓库脚本：

```bash
LIMIT=50 MODE=quick /path/to/hstry/scripts/test-mmry-session-ingest.sh
```

验证：`mmry --store chat-memories search "某话题" --mode hybrid`

---

## 数据会不会混在一起？

**不会。** SQLite 里每条会话有完整归属：

| 字段                   | 含义                 | 示例                                |
| ---------------------- | -------------------- | ----------------------------------- |
| `source_id`            | 数据源（含机器前缀） | `arknights:cursor-0eb5ac86`         |
| `adapter`              | 工具类型             | `cursor`, `codex`, `pi`, `opencode` |
| `workspace`            | 项目路径             | `D:\Code\hstry` / `~/Code/hstry`    |
| `external_id`          | 原工具会话 ID        | Cursor composer UUID                |
| `title` / `created_at` | 标题与时间           | 正常显示                            |

搜索时可过滤：

```bash
hstry search "query" --source win-pc:cursor-0eb5ac86
hstry search "query" --source macbook:cursor-abc123
hstry list --source codex-e50f7c87
```

`list` 跨 source 时会对重复会话做展示层去重；底层仍按 `source_id + external_id` 分开存。

---

## 支持的日常工具（当前）

| 工具                       | Adapter       | 默认路径（Windows）                   | 状态    |
| -------------------------- | ------------- | ------------------------------------- | ------- |
| Cursor                     | `cursor`      | `%APPDATA%\Cursor\User\globalStorage` | ✅ 已用 |
| Codex                      | `codex`       | `~\.codex\archived_sessions`          | ✅      |
| Claude Code                | `claude-code` | `~\.claude\projects`                  | ✅      |
| OpenCode                   | `opencode`    | `~\.local\share\opencode`             | ✅ adapter 已有；确认 source + sync |
| DeepSeek Harness           | `dsh`         | `~\.dsh\sessions`                     | ✅ |
| Pi                         | `pi`          | `~\.pi\agent\sessions`                | ✅      |
| QClaw / OpenClaw           | `qclaw`       | `~\.qclaw\agents`                     | ✅ 已 sync（本机 98 会话） |
| WorkBuddy                  | `workbuddy`   | `~\.workbuddy\projects`               | ✅ 已 sync（本机 36 会话；v1 跳过 subagents） |
| Antigravity 2.0 / agy / IDE 1 / 旧 CLI | `antigravity` | `~\.gemini\antigravity*` 与 `~\.gemini\tmp` | ✅ SQLite+JSONL |
| Goose / Hermes / Aider / … | 各 adapter    | 见 `hstry adapters list`              | ✅ 有 adapter；本机 Hermes 会话目录目前为空 |
| Gemini Export              | `gemini`      | Downloads/Desktop 导出 JSON           | ✅ adapter 只认 **导出文件**，不认 `~\.gemini\history` CLI 目录 |

> 你说的 **Pay** 如果指 **Pi**，已支持。OpenCode 也已支持。

### Adapter backlog（本机 2026-07-25 探测）

按「有没有现成 adapter / 本机有没有数据 / 格式难度」排期。加完后：`just update-adapters` → `hstry source add <path>` → `hstry sync`。

详细今晚执行计划见 [`plan-adapters-tonight.md`](./plan-adapters-tonight.md)（含 vs Cursor 难度、测试矩阵）。

| 优先级 | 工具 | Adapter 现状 | 本机数据 | 建议路径 / 格式线索 | vs Cursor | 备注 |
| ------ | ---- | ------------ | -------- | ------------------- | --------- | ---- |
| ~~P0 今晚~~ **done** | **qclaw** | ✅ `adapters/qclaw` | ✅ ~98 jsonl | `~\.qclaw\agents\*\sessions\*.jsonl` | **≪** | 2026-07-25 sync：98 会话 / 4144 消息 |
| ~~P0 今晚~~ **done** | **workbuddy** | ✅ `adapters/workbuddy` | ✅ ~36 jsonl | `~\.workbuddy\projects\**\*.jsonl` | **<** | 2026-07-25 sync：36 会话；v1 跳过 subagents |
| ~~P0 今晚~~ **done** | **antigravity** | ✅ `adapters/antigravity` CLI | ✅ 21 jsonl | `~\.gemini\tmp\*\chats\session-*.jsonl` | **<** | 2026-07-25 sync：8 有对话会话（其余为 CLI 日志-only）；IDE ChatSessionStore 仍空 |
| P2 延后 | **zcode** | 无 | ✅ 弱/乱 | `tasks-index` 元数据 + `cli/rollout/model-io-*.jsonl` + `cli/db/db.sqlite` | **≈/?** | transcript 未闭合；今晚不做 |
| — | **hermes** | ✅ | ❌ 空 | `~\.hermes\sessions` | — | 有 adapter 无数据 |
| — | **gemini** | Export only | 忽略 | — | — | 用户确认不做 |
| — | **opencode** | ✅ | ✅ | `~\.local\share\opencode` | — | 已 sync |

**不要做的捷径：** 把 qclaw 硬塞进 `pi` 的 canonical root；用 `opencode` 去 import `~\.qclaw`；把 Antigravity IDE protobuf 硬解码塞进 v1。

---

## 开机自启（各平台）

### Windows（任务计划程序）

```powershell
# 触发器：登录时
# 操作：D:\path\to\hstry.exe service start
schtasks /Create /TN "hstry-service" /TR "C:\Users\Andrew\.cargo\bin\hstry.exe service start" /SC ONLOGON /RL LIMITED /F
```

### Mac（launchd，示例）

`~/Library/LaunchAgents/com.hstry.service.plist` → `ProgramArguments`: `hstry service start`

### NAS（systemd 用户服务或 crontab @reboot）

```bash
@reboot sleep 30 && hstry service start
```

---

## 故障排查

| 症状                         | 处理                                                                |
| ---------------------------- | ------------------------------------------------------------------- |
| `Search service unavailable` | `hstry service start`                                               |
| `remote test` 失败           | Tailscale 验证 / 改用 LAN `memini-b506`；见 `~/.ssh/config`         |
| push 后 Hub 只剩一台数据     | 见 [`remote-sync.md`](./remote-sync.md)；查 `database_path`、二进制是否最新 |
| push 日志出现 `001_initial_schema` | fetch 失败 → 在空库 merge；修 SSH/SCP 后从备份恢复再推      |
| push 后 source 仍是 `local:*` | 旧版 `hstry.exe`；重编译安装带 `device_id` 的分支版本              |
| push 后 NAS 无数据           | 检查 `database_path` 是否为 `NAS_DB`；`hstry remote sync --direction push -v` |
| `database disk image is malformed` | 停 push；`rm -f hstry.db-wal hstry.db-shm`；必要时从备份恢复 |
| Win/Mac 同时 push 冲突       | 只开一侧 `auto_sync`；见上文「禁止同时 push」                       |
| adapter 解析空               | `js_runtime = "node"`；adapters 目录 `npm install`                  |
| 三个 Cursor source 重复      | `hstry dedup --cross-source`；`hstry source prune-cursor --auto-remove` |
| 编译缺 protoc                | `winget install Google.Protobuf` 或 NAS 上装 protobuf-compiler      |
| `CARGO_TARGET_DIR` 导致旧二进制 | 取消该变量后 `cargo build --release -p hstry-cli` 再复制到 `.cargo\bin` |

---

## 本地旧备份何时可删

确认 NAS 能搜到对应会话后：

- ✅ 可删：`.cursaves/snapshots` 旧备份、手动 export 副本
- ❌ 勿删：Cursor/Codex 正在写入的原始目录

```powershell
hstry search "某条你记得的会话标题" --scope remote --remote nas
# 有结果 → 再删本地 .cursaves 等
hstry source remove cursor-99bcde98   # cursaves source（可选）
```

---

## 交给 AI 的一句话 prompt 模板

```
按 docs/nas-hub-setup.md 在我的环境部署 hstry NAS hub 架构。
变量：NAS_HOST=admin@fnos, NAS_DB_DIR=/vol1/1000/data/hstry,
WIN_DEVICE_ID=win-pc, MAC_DEVICE_ID=macbook,
WIN_STAGING_DB=D:/Data/hstry/staging.db。
执行 Phase 0–4，输出验收结果。
```
