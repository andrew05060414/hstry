# Chronicle 记忆系统分工设计：hstry 采集存档，AgentsView 检索查看

> 创建日期：2026-09-27
> 最后更新：2026-09-27
> 版本：2.0
> 关联：andrew05060414/chronicle#61（退役计划）、#65（网页对话导入 AgentsView）

## 1. 结论

> 2.0 修订：经三份调研后，分工改为"AgentsView 读所有 agent 日志；hstry 只管网页对话；原始文件备份交给 restic"。以第 11 节为准，第 4–8 节保留为 1.0 的调研记录。

Chronicle 是整个记忆系统的总称，下面三块各管一段：

- **AgentsView：读取、检索和查看。** 解析各机器的全部 agent 日志，负责搜索（中文分词、语义检索）、会话浏览界面、MCP 接口、recall 提取，以及多机汇总到 NAS 的 PostgreSQL。
- **hstry（瘦身）：网页对话。** 接收浏览器插件抓到的网页对话，保存正本并汇总到 NAS，经 NAS 上的桥送进 AgentsView；另保留冻结的旧档案。网页对话不是本机文件，restic 备份不到，所以这部分只能由 hstry 负责。
- **restic：原始文件备份。** 每台机器备份核心 agent 的原始会话文件，NAS 放主库，再送一份到异地，能恢复回原位。

网页对话从 hstry 转进 AgentsView 的"桥"**只在 NAS 上跑一处**：读 NAS 上的 hstry 汇总库，写进 NAS 上一个专用的可写 AgentsView 实例，再推到 NAS 的 PostgreSQL。这样 Windows 和 Mac 都不用装同步脚本，浏览器插件装在哪台机器，数据都走这一条路。

这修正了 #61 里"逐步退役 hstry 核心"的方向，原因见第 2 节。

## 2. 背景

1. **2026-09-25 评测**：同样 20 个真实问题，按关键词搜，正确会话排第一的次数，AgentsView 是 10、hstry 是 6，AgentsView 还快约 3 倍。hstry 的问题是中文按空格切词、没有语义检索、结果是消息碎片。据此 #61 定下"检索交给 AgentsView，逐步退役 hstry 核心"。
2. **2026-09-27 导入网页对话时发现 AgentsView 的限制**：
   - 没有接收网页对话的通用接口，浏览器插件不能直接写进去（上游也没有插件或相关计划）。
   - 官方 ChatGPT 导入器遇到已导入的对话直接跳过，后续追加的消息进不来。
   - 上游更新频繁。本机是 v0.44.0，NAS 容器是 9 月 10 日的开发版，版本已经对不上。
3. 所以 hstry 不能整体退役：网页对话必须有一个能实时接收、能长期存档的地方，目前只有 hstry 做得到。

## 3. 现状（2026-09-27 实测）

| 机器 | hstry | AgentsView | 其他 |
| --- | --- | --- | --- |
| Windows（Arknights） | 服务 `chronicle`（LocalSystem），读本机 agent 日志、接收插件数据（`127.0.0.1:3000/ingest`），推送到 NAS 汇总库 | 守护进程 `agentsview serve`，读本机 agent 日志；计划任务每 30 分钟 `pg push` 到 NAS | 浏览器插件装在 Chrome 和 Edge，从开发目录加载 |
| Mac | launchd 服务 `hstry` | 不常驻，数据已推到 PG（机器名 MacBook-Pro 等） | 未装浏览器插件 |
| NAS（fnOS，Linux） | systemd 用户服务 `hstry`，汇总库 `hstry-win.db`（2.56 GB，包含全部网页对话） | 容器 `agentsview`：`pg serve` 只读界面（端口 18080）；容器 `agentsview-postgres`：PostgreSQL + pgvector | 夜间备份脚本 `/vol1/1000/docker/backup/backup.sh` |

## 4. 功能对照

| 功能 | hstry | AgentsView | 分工后归谁 |
| --- | --- | --- | --- |
| 接收网页对话（插件） | ✅ `/ingest`，ChatGPT、Claude 实时；Gemini、Grok 可选 | ❌ | **hstry** |
| 导入官方导出文件 | ✅ 自动识别 Downloads 等目录 | ✅ 仅 ChatGPT、Claude、Gemini Takeout | hstry（正本），AgentsView 经桥获得 |
| 读取本机 agent 日志 | ✅ 约 40 个 TypeScript 适配器，靠 node 子进程 | ✅ Go 内建 20 多种，含 cursor-ide | 两边都读；检索用 AgentsView |
| 搜索 | 关键词，中文效果差 | 全文 + 中文分词 + 语义混合检索 | **AgentsView** |
| 查看界面 | 终端界面 `chronicle tui` | 网页界面，会话浏览、健康度、用量 | **AgentsView** |
| MCP | ✅ | ✅ 默认排除当前会话 | AgentsView 为主 |
| 多机汇总 | SSH 推增量库到 NAS 汇总库 | `pg push` 到 NAS PostgreSQL | 两条并存：hstry 汇总存档，PG 汇总检索 |
| 3-2-1 备份 | ✅ `chronicle backup`：NAS + Oracle + Google Drive；原始会话文件 restic 备份（#57） | ❌ 自身不备份 | **hstry**；PG 由 NAS 夜间 `pg_dump` 备份 |
| 在另一个 agent 里续聊 | ✅ `chronicle resume` | ❌ | hstry |
| 导出成其他格式 | ✅ `chronicle export` | 仅导出自己的数据 | hstry（桥依赖它） |
| 记忆提炼 | `mmry` / recall（闲置） | `recall extract`（在用） | AgentsView |
| 用量、成本、健康分析 | ❌ | ✅ | AgentsView |
| 现有依赖方 | NAS 上 AstrBot 桥调用 `hstry search/read`；history 技能 `chronicle search`；worklog 日同步 | 你本人看界面 | 迁移入口时要一起改 |

**结论：**
- 读本机 agent 日志这一项，两边重复。检索和查看已经可以全交给 AgentsView。
- hstry 独有的是：网页采集、存档、备份、续聊、导出。
- hstry 是否继续自己解析 agent 日志，等 restic 原始文件备份稳定后再定（第 8 节第 5 阶段）。

## 5. 后台内存

2026-09-27 实测：Windows 取工作集，括号内为提交内存；Mac 和 NAS 取常驻内存（RSS）或容器内存。

| 机器 | 进程 | 内存 |
| --- | --- | --- |
| Windows | hstry 服务 `chronicle.exe` | 28 MB |
| Windows | AgentsView 守护进程 | 150 MB（提交 721 MB） |
| Windows | AgentsView `pg push`（计划任务，每 30 分钟起一次） | 约 63 MB，跑完退出 |
| Windows | Ollama（AgentsView 语义检索用 bge-m3） | 空闲 58 MB；算向量时会加载模型，峰值本次没测到 |
| Mac | hstry 服务 | 18 MB |
| NAS | hstry 服务 | 54 MB |
| NAS | AgentsView 只读界面容器 | 184 MB |
| NAS | PostgreSQL 容器 | 185 MB |
| NAS | 新增：可写 AgentsView 实例（临时容器实测） | 空闲约 35 MB |

- **两者都没有 WebView。** 都是后台服务，界面在浏览器里打开。本机那些 `msedgewebview2` 进程分别属于 GameViewer、闪电说、系统搜索、bageshuo、cockpit-tools，与 hstry、AgentsView 无关。
- **AgentsView 是较重的一方**：3.7 GB 的库、向量索引和 recall 提取都在守护进程里。hstry 常驻很轻，只在同步时临时起 node 子进程跑适配器，这部分峰值本次没测。
- 内存不是舍弃 hstry 的理由。NAS 上新增的桥实例约 35 MB，NAS 目前还有约 7.9 GB 可用内存。

## 6. 目标架构

```
[各机器]
  浏览器插件（Windows、Mac 的 Chrome/Edge） ──> 本机 hstry 服务 /ingest
  agent 日志 ──> 本机 hstry（存档）
             └─> 本机 AgentsView 守护进程 ──pg push──┐
  本机 hstry ──SSH 增量──> NAS hstry 汇总库             │
                                                       ▼
[NAS]                                          PostgreSQL（检索汇总）
  hstry 汇总库（网页对话正本） ──> 桥 ──> 可写 AgentsView 实例 "chronicle-web" ──pg push──┘
                                                       │
  只读界面 pg serve（:18080）<─────────────────────────┘
  夜间备份：pg_dump + hstry 库 ──> 本机副本 ──> Oracle / Google Drive
```

**3-2-1 备份：**
- 第 1 份：NAS 上的活数据，即 hstry 汇总库和 PostgreSQL。
- 第 2 份：Windows 本机的 hstry 库和各机器原始会话文件。
- 第 3 份：异地，Oracle 和 Google Drive，已由 `chronicle backup` 负责。
- AgentsView 的数据理论上可以从原始数据重建。但 recall、标星、洞察等只存在它自己的库里，所以 PostgreSQL 仍然要 `pg_dump`，NAS 夜间已在做。

## 7. 两个风险的核实结果

### 风险 1：同一对话从两台机器推到 PostgreSQL，会不会重复

- **不会出现两行**：`agentsview.sessions` 的主键只有 `id`。
- **但有归属保护**：先推送的那台机器占有这条会话，其他机器再推同一个 `id` 会被跳过，计入冲突，不报错。依据是上游 `internal/postgres/push.go` 的 `sameSessionOwner` 检查。
- **现状**：今天导入的 1164 个网页对话（ChatGPT 365、Claude 66、Gemini 733）在 PostgreSQL 里都归 Windows 这台机器。
- **影响**：NAS 桥上线后，这 1164 个对话的更新推不上去，会被跳过。要么过渡期保持由 Windows 导入，要么切换时把归属交给 NAS 实例。切换方案见第 8 节第 3 阶段，其中删除数据需要 Andrew 批准。

### 风险 2：NAS 能不能再跑一个可写的 AgentsView 实例

- **可以。** 2026-09-27 在 NAS 上用临时容器实测：
  - 镜像同 `ghcr.io/kenn-io/agentsview`，独立数据目录，参数 `serve --no-sync`。
  - Claude 导入 2/2 成功，Gemini 原生文件识别成功，空闲约 35 MB。
  - 测试容器和临时目录已删除。
- **正式部署要注意三点**：
  - 机器名默认是容器 ID，要固定主机名或 `[pg] machine`，例如 `chronicle-web`。
  - 从容器外访问要带 `--public-url`。
  - 数据目录放在 `/vol1` 下，并纳入夜间备份。

### 附带发现：NAS 夜间备份的 hstry 是旧库

- `backup.sh` 备份的是 `/vol1/1000/Code/hstry backup/hstry.db`：195 MB，最后修改 2026-08-16。
- NAS 上 hstry 实际在用的是同目录的 `hstry-win.db`：2.56 GB。
- 结果是夜间日志每天显示 `OK hstry`，但备份的都是 8 月的旧数据。
- 活数据目前靠 Windows 的 `chronicle backup` 另有异地副本（Oracle、Google Drive），所以没有丢数据风险，但 NAS 这一份是失效的。修复只需要改一行路径，属于改 NAS 配置，等 Andrew 批准。

## 8. 实施计划

每个阶段做完都有验收，前一阶段通过才进入下一阶段。

### 第 0 阶段（已完成）

- 网页对话已一次性导入 Windows 本机 AgentsView，并推到 PostgreSQL（#65）。
- #65 暂不合并。其中的格式转换代码留给第 1 阶段复用；PowerShell 脚本保留为 Windows 手动工具。

### 第 1 阶段：修备份缺口（小，先做）

- NAS `backup.sh` 的 hstry 路径改为 `hstry-win.db`。备份活库要用 SQLite 在线备份，不能直接复制文件。
- **验收**：次日备份文件大小约 2.5 GB，能打开，会话数与活库一致。

### 第 2 阶段：把桥改成 NAS 上能跑的正式组件

- 做成 `chronicle` 的子命令（暂定 `chronicle agentsview sync`），用 Rust 实现，复用 hstry 已有的导出和适配器。
  - 选这个方案的理由：NAS、Windows、Mac 都已经部署了 `chronicle`，NAS 上有 node 可以跑适配器。不需要新增运行时，也不引入 PowerShell。
  - 行为沿用 #65 验证过的做法：按来源去重、按内容指纹增量、ChatGPT 打 zip 包、Claude 直接导入、Gemini 和 Grok 写原生文件后同步一次再按 ID 确认、首次写入前备份。
- 补一份运行文档：部署、配置、排错、恢复。
- **验收**：在一个临时的 AgentsView 实例上，用 NAS 汇总库的真实数据跑通；数量与 hstry 去重结果一致；重跑时 `changed=0`。

### 第 3 阶段：NAS 部署并切换归属

- 在 `/vol1/1000/docker/agentsview/docker-compose.yaml` 里新增服务 `agentsview-web`：
  - 可写实例，参数 `serve --no-sync`。
  - 固定机器名 `chronicle-web`，锁定镜像版本，配置 PostgreSQL 推送。
  - 专用目录挂载给 Gemini 和 Grok 使用。
- 桥由 NAS 上的 hstry 服务定时触发，或用 systemd 计时器，每 15 到 30 分钟跑一次。
- **切换归属，需要 Andrew 批准，因为要删数据**：
  1. 先备份 PostgreSQL 和 Windows 本机的 AgentsView 库。
  2. 删除 Windows 本机 AgentsView 里 `chatgpt.com`、`claude.ai`、`gemini_web` 三个项目的会话。
  3. 删除 PostgreSQL 里对应的行。
  4. 用 NAS 桥全量导入，由 `chronicle-web` 重新占有。
  - 替代方案：先查清 `agentsview db adopt-machine` 能否直接转移归属，能的话就不用删。
- 同时把 Windows 上 AgentsView 配置里给 Gemini、Grok 加的专用目录撤掉，Windows 不再做网页导入。
- **验收**：
  - PostgreSQL 里网页对话数量与 hstry 去重结果一致，机器名是 `chronicle-web`。
  - 在网页上新聊一段，30 分钟内能在 NAS 界面（18080）搜到。
  - `pg push` 的冲突计数为 0。

### 第 4 阶段：浏览器插件

- 在 chronicle 仓库里把插件更名为"Chronicle 网页采集"。
- 浏览器改为从一个稳定目录加载，由 main 分支更新到这个目录，不再用开发目录。
- 打开 Gemini 采集；Grok 在稳定目录更新到 main 后可用，按需打开。
- Mac 上安装插件。
- **验收**：Gemini、Grok 在 hstry 里有新对话进来，并经桥出现在 AgentsView。

### 第 5 阶段：入口与收尾（以后再定）

- `chronicle search` 和 history 技能改为转发到 AgentsView。NAS 上的 AstrBot 桥也要一起改。
- 各机器和 NAS 统一 AgentsView 版本，按计划升级；升级前先用临时实例跑一遍桥的回归测试。
- 等 restic 原始文件备份稳定后，再决定 hstry 是否停止解析 agent 日志、只保留网页采集和存档。

## 9. 待 Andrew 决定

1. 第 1 阶段：是否批准修改 NAS 备份脚本的 hstry 路径。
2. 第 2 阶段：桥做成 `chronicle` 的 Rust 子命令（推荐），还是另写一个 Python 服务。
3. 第 3 阶段：归属切换是否采用"删除后由 NAS 重新导入"。执行前会再确认一次。
4. 插件重命名是否现在就做，还是放到第 4 阶段一起做。

## 10. 未知和待核实

- `agentsview db adopt-machine` 能否把会话归属从一台机器转给另一台：未验证。
- hstry 同步时 node 子进程的峰值内存，以及 Ollama 加载 bge-m3 时的峰值：未测。
- PostgreSQL 汇总库的中文检索效果：本机 SQLite 有中文分词插件，PostgreSQL 不加载它，这一项沿用 #61 的待测。
- 已知限制：ChatGPT 已导入的对话后续追加的消息进不了 AgentsView。要解决，只能向上游提需求，而且需要 Andrew 先同意。

## 11. 2.0 修订：最终分工与优先级（2026-09-27）

### 11.1 三份调研的结论

1. **谁来读 agent 日志：AgentsView。**
   - 实测 hstry 的 `tool_calls` 表是 0 行，4117 个会话里只有 18 个有 token 记录；Claude Code 子 agent 被跳过，Cursor 按 2 万字截断。
   - AgentsView 同一批数据有 36.7 万条工具调用、5.8 万条用量记录。
   - 让 hstry 补到同等粒度再喂给 AgentsView，需要为每种 agent 反向生成原生文件，工程量估计数千行，而且会两次有损转换。结论：不做。
2. **hstry fork 的去留：只保留网页对话相关部分。**
   - 原始文件备份 `chronicle native`（约 5.1k 行）实际没有运行：
     - 没有定时任务，只在 2026-09-22 手动跑过一次；
     - Mac 没有部署，也没有异地副本；
     - 恢复只能解压到隔离目录，不能放回原位；
     - Cursor 只备了投影，Antigravity 漏了 `brain` 目录；
     - 每次都整份复制且不清理，10 个快照已占 12.6 GB；
     - restic 密码文件和数据放在同一台机器上。
   - 改为直接用 restic（或 Kopia）加定时任务。
   - agent 日志适配器、hub 检索、TUI、hstry-mcp、recall/mmry、skills 代理，逐步冻结或删除。
3. **网页对话：保留自研扩展，不改成 AgentsView 插件。**
   - 市面上没有同时满足"多站点、后台自动增量、落本地、能进 AgentsView"的开源项目。最接近的 egroup-labs/kept 只输出 Markdown。
   - AgentsView 没有数据源插件机制。它的 CORS 白名单只接受 http/https 来源，扩展请求默认会被拒。
   - 扩展直连 AgentsView 还有几个问题：ChatGPT 追加的消息会丢；Gemini 和 Grok 没有导入接口；多台机器之间会发生会话归属冲突。
4. **检索：不新增记忆引擎。**
   - 需求是找回原始会话，Mem0、AgentMemory、Zep 这类引擎解决的是事实提炼。
   - 最新 C 集 153 题 `semantic --pg` 的成绩是 R@5 58、R@30 73，有 80 题连前 30 都没进，所以问题主要在召回，不在排序。
   - 重排和向量模型的测试已单独开会话进行。

### 11.2 扩展已知缺陷

以下按代码推断，待修复会话逐条核实：

- ChatGPT 只遍历 `/backend-api/conversations`，很可能漏掉项目会话和归档会话。与官方导出对比，扩展运行期间新建的 93 个会话没有抓到。
- Claude 按数组顺序平铺消息，编辑或重新生成过的会话，多个分支可能混在一起。
- 附件和图片基本没有保存。
- Gemini 的时间戳用的是会话级时间，而且遇到 429 不退避；Perplexity 单个会话最多取 100 条。
- 如果某个会话一直失败，增量进度会被卡住。

### 11.3 执行顺序

| 顺序 | 事项 | 执行方式 | 需要 Andrew |
| --- | --- | --- | --- |
| 1 | restic 原始文件备份：每台机器覆盖 Claude Code、Codex、Antigravity（含 `brain`）、Grok、Cursor（完整 `state.vscdb` 和 `workspaceStorage`）；每小时一次；NAS 主库，外加异地副本；设保留策略；每个 agent 做一次恢复演练 | 独立会话 | 自己设置密码；方案确认 |
| 2 | 小修：NAS `backup.sh` 的 hstry 路径改为 `hstry-win.db` 并用在线备份；查 NAS checkpoint 为何 9-08 之后停了；`chronicle backup` 打开加密；Mac Time Machine 报错 | 本会话 | 批准配置变更 |
| 3 | 修扩展：ChatGPT 项目会话和归档会话、Claude 分支、Gemini 和 Perplexity 的缺陷、卡住的进度；浏览器改从稳定目录加载；打开 Gemini 和 Grok；在 Mac 上安装 | 独立会话 | 在浏览器里操作 |
| 4 | NAS 桥：`chronicle` 子命令加可写 AgentsView 实例 `chronicle-web`；网页会话的归属从 Windows 移交给 NAS | 本会话或后续会话 | 删除旧归属前批准 |
| 5 | 入口迁到 AgentsView；统一各机器的 AgentsView 版本；各机器停用 hstry 的 agent 数据源 | 后续 | — |
