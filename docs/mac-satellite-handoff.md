# Mac Satellite Handoff（交给 Mac worker）

## 任务

在 Mac 上安装 hstry **satellite**，采集本机 AI 聊天记录并 push 到 NAS Hub。

## 已确认变量

```bash
NAS_SSH="admin@memini-b506.tail76a98f.ts.net"
REMOTE_NAME="nas"
DEVICE_ID="macbook"
HSTRY_VERSION="0.5.21"
STAGING_DB="$HOME/.local/share/hstry/staging.db"
```

---

## Phase 1：安装

```bash
# 依赖
brew install node
# hstry：brew install（若有 tap）或：
# cargo install --git https://github.com/byteowlz/hstry --tag v0.5.21 hstry-cli
hstry -V    # → 0.5.21
```

---

## Phase 2：Adapters

```bash
mkdir -p ~/.config/hstry/adapters
# 从仓库复制或 git clone
git clone --depth 1 --branch v0.5.21 https://github.com/byteowlz/hstry /tmp/hstry
cp -r /tmp/hstry/adapters/* ~/.config/hstry/adapters/
cd ~/.config/hstry/adapters && npm install
```

---

## Phase 3：配置 `~/.config/hstry/config.toml`

> **Mac 与 Windows 一样**：`[[remotes]]` 里必须写 Hub 主库绝对路径，否则会 push 到 NAS 默认的 `~/.local/share/hstry/hstry.db`（不存在）而失败。  
> **Hub 主库**：`/vol1/1000/Code/hstry backup/hstry.db`（路径含空格，引号不能省）

```toml
database = "~/.local/share/hstry/staging.db"
js_runtime = "node"
adapter_paths = ["~/.config/hstry/adapters"]
sources = []
adapters = []
remotes = []

[[remotes]]
name = "nas"
host = "admin@memini-b506.tail76a98f.ts.net"
enabled = true
# 必填 — 与 NAS ~/.config/hstry/config.toml 的 database= 一致
database_path = "/vol1/1000/Code/hstry backup/hstry.db"

[sync]
mode = "satellite"
device_id = "macbook"
hub_remote = "nas"
auto_sync = true
auto_sync_interval_secs = 300

[service]
enabled = true
poll_interval_secs = 600
search_api = true
transport = "tcp"
```

---

## Phase 4：SSH 密钥（免密 push）

```bash
# 若还没有密钥
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""

# 拷公钥到 NAS（会提示输入 NAS 密码，一次即可）
ssh-copy-id admin@memini-b506.tail76a98f.ts.net

# 验证
ssh admin@memini-b506.tail76a98f.ts.net echo OK
```

---

## Phase 4.5：去重（push 前建议）

与 Windows 相同：多个 Cursor source 会重复；旧版 push 前缀是 `local:`，需用 `device_id` 重推。

```bash
hstry dedup --cross-source
hstry source prune-cursor --auto-remove   # 只留 globalStorage 的 cursor source
hstry source list
```

**push 前确认 Windows 没在同时 push**（`auto_sync` 串行），否则 Hub `hstry.db` 会损坏。

---

## Phase 5：数据源 + 启动

```bash
mkdir -p ~/.local/share/hstry

hstry scan

hstry source add ~/Library/Application\ Support/Cursor/User/globalStorage
hstry source add ~/.codex/archived_sessions
hstry source add ~/.claude/projects
hstry source add ~/.local/share/opencode
hstry source add ~/.pi/agent/sessions

hstry source list

hstry service start
hstry sync

hstry remote add nas admin@memini-b506.tail76a98f.ts.net   # 若已存在可跳过
hstry remote test nas
hstry remote sync --remote nas --direction push
```

---

## Phase 6：验收

```bash
hstry service status          # running
hstry stats                   # 本机 staging 有数据
hstry search "test" --scope remote --remote nas --limit 3
```

在 NAS 上应能看到 `macbook:cursor-*` 等 source（`sync.device_id` 作为 push 前缀；旧版误用 `local:` 需在该 Mac 上重推一次）。

```bash
ssh admin@memini-b506.tail76a98f.ts.net hstry stats
```

---

## 日常使用

```bash
hstry service start                                    # 登录后
hstry search "关键词" --scope remote --remote nas
hstry search "关键词" --scope all --remote nas          # staging + NAS
```

---

## 开机自启（可选）

`~/Library/LaunchAgents/com.hstry.service.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.hstry.service</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/hstry</string>
    <string>service</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
```

路径按实际 `which hstry` 调整。

---

## 完整文档

- 个人部署手册：`docs/nas-hub-setup.md`
- 分支 / 上游拆分：`docs/andrew-nas-branch-notes.md`
- 通用 sync 说明（可 PR upstream）：`docs/remote-sync.md`

### SSH 备选（在家）

Tailscale SSH 若要求浏览器验证，可临时把 `[[remotes]].host` 改为局域网别名（`~/.ssh/config` 里已配置 `Host memini-b506` → `192.168.0.102`）。外出再改回 `admin@memini-b506.tail76a98f.ts.net`。

### Push 验收

```bash
ssh admin@memini-b506.tail76a98f.ts.net hstry stats
# 应看到 macbook:* 与 arknights:* 并存
```
