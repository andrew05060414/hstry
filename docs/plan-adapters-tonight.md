# Tonight plan: qclaw / workbuddy / antigravity adapters

**Date:** 2026-07-25  
**Scope:** 三个新 adapter（**不做** Gemini；**Zcode 延后**）  
**Goal:** 本机可 `source add` + `sync`，并通过 adapter 级 + 端到端冒烟测试。

---

## 0. 难度对比（vs Cursor）

| Adapter | 相对 Cursor | 预估 | 依据（本机实测） |
|---------|-------------|------|------------------|
| **cursor**（基准） | 1.0× | — | SQLite WAL 拷贝、`composerData`/`bubbleId`/`composerHeaders`、workspace 分裂、cursaves 多源；`adapter.ts` ~24KB |
| **qclaw** | **~0.15×** | 0.5–2h | 与 **Pi 同款 JSONL**（`type:session/message/model_change`）；~98 文件、3960 message；仅需新 canonical root `~\.qclaw\agents` |
| **workbuddy** | **~0.35×** | 2–4h | 独立 JSONL（~36 会话）；`message` + `function_call`/`function_call_result` + `reasoning`；像精简版 Codex/Responses，**不是** Pi |
| **antigravity** | **~0.4×（先做 CLI）** | 2–4h | 真聊天在 `~\.gemini\tmp\*\chats\session-*.jsonl`（21 文件；user 13 / gemini 130）；IDE `state.vscdb` 的 `chat.ChatSessionStore.index` **为空**，agent 状态是 protobuf——**今晚不做 IDE 深挖** |
| **zcode**（延后） | **≥0.8× / 不明** | 调研日+ | `tasks-index` 只有 7 条元数据；rollout `model-io-*.jsonl` 是 API dump；另有 `cli/db/db.sqlite` 未摸清。比 Cursor 不一定更难，但**不确定性高** |

**结论：** 今晚三个都比 Cursor **容易一个数量级（qclaw）到半级（workbuddy / antigravity CLI）**。最难的 Cursor 坑（多 hash workspace、bubble 分片、WAL）这三个都没有。

---

## 1. 本机数据快照（验收基准）

| 源 | 根路径 | 规模 | 验收期望 |
|----|--------|------|----------|
| qclaw | `C:\Users\Andrew\.qclaw\agents` | ~98 jsonl（排除 trajectory/checkpoint） | sync 后会话数 ≈ 98（或略少空会话） |
| workbuddy | `C:\Users\Andrew\.workbuddy\projects` | ~36 主 jsonl（不含 subagents 可先跳过或标 metadata） | ≥30 会话有 user/assistant 文本 |
| antigravity CLI | `C:\Users\Andrew\.gemini\tmp` | 21 `session-*.jsonl` | ≥10 会话；至少能抽出 user+gemini 文本（忽略 `$set`/warning 噪音） |

OpenCode / Pi / Cursor 等已有源：**回归** `hstry sync` 不坏即可。

---

## 2. 实施顺序（今晚）

### A. `adapters/qclaw/`（先做，30–90min）

1. 从 `adapters/pi/adapter.ts` **复制**为起点（不要改 pi 的 canonical root）。
2. `info.name = 'qclaw'`，`defaultPaths = [join(homedir(), '.qclaw', 'agents')]`。
3. `detect`/`parse`：`isUnderCanonicalRoot(..., DEFAULT_QCLAW_PATH)`。
4. 跳过 `*.trajectory.jsonl`、`*.checkpoint.*.jsonl`。
5. 消息：已确认 `message.message.content` 为 `text|toolCall|thinking|image`——对齐 pi 的 part 映射即可。
6. `just update-adapters` →  
   `hstry source add C:\Users\Andrew\.qclaw\agents -a qclaw` → `hstry sync --source <id>`。

### B. `adapters/workbuddy/`（第二）

1. 新建 adapter（可参考 `codex` 的 JSONL 事件流，**不要**硬套 pi）。
2. 根：`~\.workbuddy\projects`（每文件一会话；`sessionId`/`cwd`/`ai-title` 做标题）。
3. 映射：
   - `message` + `role` + `content[]` 的 `input_text`/`output_text` → user/assistant text
   - `function_call` / `function_call_result` → toolCall / toolResult
   - `reasoning` → thinking（可选）
   - `file-history-snapshot` → 忽略或 metadata
4. 默认 **跳过** `**/subagents/**`（v1）；需要时再加。
5. 同上 source add + sync。

### C. `adapters/antigravity/`（第三，CLI-only v1）

1. 根：`~\.gemini\tmp`（或更窄 `** /chats`）。
2. 文件：`session-*.jsonl`。
3. 解析：
   - 首行 `kind:main` + `sessionId` → conversation header
   - `type:user` / `type:gemini` → messages（content 可能是 string 或 `[{text}]`）
   - 忽略 `$set`、`warning`/`info`/`error`（可放 metadata 计数）
4. **不**在 v1 解析 Antigravity IDE `state.vscdb`（ChatSessionStore 空；protobuf 另开 issue）。
5. source add + sync。

### D. Zcode / Gemini

- **Gemini：** 不做。
- **Zcode：** 记入 backlog；下次先 dump `cli/db/db.sqlite` schema + 把 `model-io` 能否还原成对话写 spike 笔记。

---

## 3. 测试计划（必须多轮，适配器入库前）

### 3.1 Adapter 单测 / 直接探针（每个 adapter ≥2 轮）

对每个新 adapter：

```powershell
# detect
$env:HSTRY_REQUEST='{"method":"detect","params":{"path":"<ROOT>"}}'
bun run $env:APPDATA\hstry\adapters\<name>\adapter.ts

# parse limit
$env:HSTRY_REQUEST='{"method":"parse","params":{"path":"<ROOT>","opts":{"limit":2}}}'
bun run $env:APPDATA\hstry\adapters\<name>\adapter.ts
```

检查清单：

- [ ] `detect` 在正确 root 上 ≥0.9；在错误路径（如 `~\.pi\...`）为 null
- [ ] `created_at` / 时间戳为 **整数 ms**（禁止 float）
- [ ] `messages[].role` 仅预期集合；至少 1 条 user 文本非空
- [ ] tool 轮次不丢成空 assistant（qclaw/workbuddy）
- [ ] 故意喂错目录：不抛未捕获异常

### 3.2 CLI 端到端（每个源 ≥2 次 sync）

```powershell
just update-adapters   # 或 update-adapters-windows
hstry import <ROOT> --adapter <name> --dry-run -v
hstry source add <ROOT> -a <name>
hstry sync --source <id> -v
hstry stats
hstry list --source <id>   # 若 CLI 支持过滤；否则 list + 目测
hstry show <某 conversation id>
```

- [ ] dry-run 数量与探测规模同量级
- [ ] 第二次 sync：**增量 / up to date**，不翻倍会话
- [ ] `verify`（若可用）或 spot-check 2–3 长会话全文可读
- [ ] 不影响已有 cursor/opencode/pi 源计数异常飙升

### 3.3 回归

```powershell
hstry scan --json
hstry sync -v   # 全源或至少旧源
```

- [ ] scan 仍能认出旧源
- [ ] qclaw **不会**再被误检成 cursor（根路径勿指向含 cursor 痕迹的上层）

### 3.4 失败即停

- timestamps float → 修 adapter 再测  
- canonical root 拒收预期路径 → 修 `defaultPaths` / registry  
- 空消息会话爆炸 → 过滤空 session  

---

## 4. 交付物

- [ ] `adapters/qclaw/adapter.ts`（+ 必要时 `package`/`README` 一行）
- [ ] `adapters/workbuddy/adapter.ts`
- [ ] `adapters/antigravity/adapter.ts`
- [ ] `docs/nas-hub-setup.md` backlog 状态更新为 ✅/CLI-only
- [ ] 本机三个 source 已 add 并至少 sync 成功一次
- [ ]（可选）`trx create` 三条 task；Zcode 单独 chore

---

## 5. 风险与非目标

| 风险 | 缓解 |
|------|------|
| qclaw 与 pi 重复维护 | 接受短期复制；后续再抽 `jsonl-pi-family` 共享模块 |
| workbuddy subagents 丢 | v1 明确文档跳过 |
| antigravity IDE 对话以后出现在 ChatSessionStore | v1 只承诺 CLI jsonl；IDE 另开 |
| zcode 今晚硬做 | **禁止**——格式未闭合 |

**非目标：** NAS remote push、agentmemory importer、Cursor workspace rebind、Gemini。

---

## 6. 一句话给执行者

> 今晚按 **qclaw（拷 pi）→ workbuddy（新 JSONL）→ antigravity CLI** 做三个 adapter；每个都要 detect/parse + sync **至少两轮**；难度远低于 Cursor；Zcode/Gemini 不动。
