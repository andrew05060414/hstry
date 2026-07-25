# `andrew-nas` branch — upstream vs fork

> **Fork-only doc.** Documents what on this branch is intended for `byteowlz/hstry` (upstream) vs what stays in Andrew’s fork.

Last verified: **2026-07-25** — Hub merge OK: **2154** conversations, **20** sources (`macbook:*` + `arknights:*`).

---

## Upstream PR candidates (byteowlz/hstry)

These are **generic product fixes/features** — open PRs against `main` (ideally split into focused PRs).

| Area | Branch commit / path | PR title (suggested) | Notes |
|------|----------------------|----------------------|-------|
| **Adapters** | `df94445` — `adapters/qclaw`, `workbuddy`, `antigravity` | `feat(adapters): add qclaw, workbuddy, antigravity` | + README adapter table |
| **Adapters** | `8e0fb83` — path separator normalization | `fix(adapters): normalize Windows path separators in canonical roots` | |
| **Sync** | `2f354a3` — `device_namespace()` | `feat(sync): namespace satellite push with sync.device_id` | Replaces hardcoded `local:` |
| **Remote** | `9e5f832` + pending — `remote.rs` | `fix(remote): quote spaced hub paths for SSH file checks` | SSH `test -f` / `eval echo` |
| **Remote** | pending — `remote.rs` | `fix(remote): Windows SCP paths with spaces; abort on tiny fetch` | SCP must not use `host:'/path'` on Windows |
| **Docs** | `docs/remote-sync.md` | `docs: add remote sync troubleshooting guide` | No Andrew-specific hosts |

### Suggested PR split

1. **Adapters only** — easiest to review, no sync risk.
2. **`device_id` namespace** — behavior change; mention migration from `local:*` → re-push once.
3. **Remote path fixes** — one PR combining SSH quote + Windows SCP + fetch size guard + tests.

---

## Fork-only (do not upstream as-is)

Personal environment, handoffs, and planning notes. Keep on `fork/andrew-nas` or move to a private dotfiles repo.

| Path | Why fork-only |
|------|----------------|
| `docs/nas-hub-setup.md` | Andrew 变量表、主机名、staging 路径、adapter 今晚进度 |
| `docs/nas-hub-handoff.md` | NAS worker handoff，`memini-b506`、Tailscale FQDN |
| `docs/mac-satellite-handoff.md` | Mac 一键 handoff，Andrew SSH / device_id |
| `docs/plan-adapters-tonight.md` | 一次性执行计划、本机路径快照 |
| `docs/windows-support-handoff.md` | 若含个人路径则 fork-only（通用手册可摘一段 upstream） |
| `docs/andrew-nas-branch-notes.md` | 本文件 |

### Optional later

- Extract a **generic** `docs/nas-hub-setup.example.md` for upstream (placeholder variables, no Andrew hosts).
- `mmry` cron on NAS — document in fork until upstream agrees on hub mmry pipeline.

---

## Andrew environment snapshot

| Item | Value |
|------|--------|
| Hub DB | `/vol1/1000/Code/hstry backup/hstry.db` |
| Win `device_id` | `arknights` |
| Mac `device_id` | `macbook` |
| Win staging | `D:/Data/hstry/staging.db` |
| Tailscale SSH | `admin@memini-b506.tail76a98f.ts.net` (may need browser check) |
| LAN SSH | `memini-b506` → `192.168.0.102` (`~/.ssh/config`) |
| hstry version | `0.5.21` (build from this branch, not crates.io) |

### SSH tip

When Tailscale SSH blocks automation, temporarily set:

```toml
# [[remotes]]
host = "memini-b506"   # LAN; see ~/.ssh/config
```

Restore Tailscale FQDN when off-LAN.

---

## Related docs

- Deploy runbook: [`nas-hub-setup.md`](./nas-hub-setup.md)
- Generic sync reference (upstream): [`remote-sync.md`](./remote-sync.md)
- Mac worker: [`mac-satellite-handoff.md`](./mac-satellite-handoff.md)
