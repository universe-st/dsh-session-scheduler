# 会话调度（dsh-session-scheduler）

让一个 agent 会话去调度**别的会话**：在任意项目里新开、发消息、打断、停止、归档、恢复、等它结束。
所有操作都走 Web GUI 本身用的那套 Host 服务（`sessionController` / `workspaceRegistry`），
会话内容与会话日志仍由 DSH 保管，插件不复制、不落盘、不另存状态。

## 七个工具

| 工具 | 作用 |
|---|---|
| `sessions_list` | 列出可见会话与实时状态（running / idle / waiting-approval / waiting-question / queued），可按目录过滤、按 id 前缀或标题定位单个会话 |
| `sessions_create` | 在任意项目目录新开会话（自动创建目录、加入对应工作区），可选立刻发第一条消息 |
| `sessions_send` | 给已停止或正在运行的会话发消息：`mode: "queue"` 排队等当前回合结束（默认），`mode: "steer"` 立即打断当前回合并插入 |
| `sessions_stop` | 停止正在执行的回合（等同 GUI 停止按钮）；`dropQueue: true` 连排队消息一起清空 |
| `sessions_archive` | 归档会话（从列表隐藏、日志保留）；对运行中的会话需显式 `stopIfRunning: true` |
| `sessions_unarchive` | 恢复已归档会话（用完整 id，因为它不会出现在 `sessions_list` 里） |
| `sessions_wait` | 等某个会话这一轮结束（跑完 / 等确认 / 超时）并取回它最后一条答复 |
| `sessions_read` | 只读地看会话内容：默认从结尾；`at: "head"` 从开头；`query` 搜关键字并从命中那条往后读；`fromSeq` 直接从某条事件的序号往后读；可 `includeTools: true` 连工具调用一起看 |

`sessionId` 参数接受三种写法：完整 id、id 前缀、会话标题。候选不唯一时会报错并列出候选，避免打错会话。

## 典型用法

```text
sessions_create  { cwd: "/Users/me/codes/some-project", title: "修构建", message: "…" }
sessions_send    { sessionId: "修构建", text: "顺便把 lint 也过了", mode: "queue" }
sessions_send    { sessionId: "session-1a2b3c4d…", text: "停一下，方向错了", mode: "steer" }
sessions_wait    { sessionId: "修构建", timeoutMs: 300000 }
sessions_stop    { sessionId: "修构建", dropQueue: true }
sessions_archive { sessionId: "修构建" }

sessions_read    { sessionId: "修构建", at: "tail", limit: 20 }
sessions_read    { sessionId: "修构建", at: "head", limit: 20 }
sessions_read    { sessionId: "修构建", query: "迁移脚本" }
sessions_read    { sessionId: "修构建", fromSeq: 512, context: 2 }
```

## 行为与限制

- **上下文不共享**：被调度的会话看不到调用方的上下文，消息要自包含。
- **列表不含自己**：`sessions_list` 默认隐藏空白会话、子代理会话和**调用者自己**，避免把自己当成调度目标。
- **`total` 与 `shown`**：`total` 是符合筛选条件的会话总数，`shown` 是本页返回的行数；`runningOnly: true` 会在这批会话里扫描出正在跑的，行数受 `limit` 约束。
- **停止不等于清空**：`sessions_stop` 默认只中止当前回合，队列里的消息仍会在之后开始新回合；要彻底停下用 `dropQueue: true`。
- **不能对本会话动手**：`sessions_stop` / `sessions_archive` 指向本会话自己会直接报错。
- **归档是隐藏而非删除**：归档后不在 `sessions_list` 里，只能用完整 id 恢复；归档会顺带丢掉置顶状态。
- **等待有上限**：`sessions_wait` 单次默认 180 秒、最多 600 秒；更久就再等一次。
- **读是只读的**：`sessions_read` 不会让会话跑起来，也不会改变它的队列；默认只列用户与助手消息，工具调用要显式 `includeTools: true`。
- **注入内容有标记**：DSH 自己塞进会话的上下文（记忆块、时间与提醒）在日志里也是用户消息，读出来会标成 `context:<来源>`，不会冒充用户说的话。
- **读是按页向前回溯的**：一次最多回溯 40 页（每页最多 300 条消息），所以超长会话的"从头读"可能只到某个中间位置，返回里的 `more_before: true` 就是这个意思；`query` 取的是**最近的一次**命中。
- **只作用于本机本 profile**：工具只能调度当前 DSH 进程可见的会话。

## 配置（`config`）

| 字段 | 默认 | 含义 |
|---|---|---|
| `defaultWaitMs` | `180000` | `sessions_wait` 不传 `timeoutMs` 时的等待时长 |
| `maxWaitMs` | `600000` | 单次等待上限 |
| `maxTailChars` | `12000` | 返回的最后一条答复长度上限 |
| `agentPreset` | 部署默认 | `sessions_create` 未指定 `agentPreset` 时新会话用的预设 |

## 安装

需要 DSH `>= 0.2.2-rc.3`。

从仓库安装（本地目录或 git 源都行，装完重启/重载后在新会话里可见）：

```text
plugin_manager install_bundle { target: "github:universe-st/dsh-session-scheduler" }
plugin_manager install_bundle { target: "<克隆下来的本目录绝对路径>" }
```

停用本插件后工具消失；已经投递的消息与已归档的状态保持不变。

## 开发与测试

八个工具不需要 DSH 也能冒烟测试：`test/smoke.mjs` 用一个假 Host（伪造 `sessionController` / `workspaceRegistry`）挂载插件，覆盖头/尾/关键字/序号读取、越界、注入内容标记、工具行开关，以及列表/创建/发送/停止/等待的基本契约。

```text
node test/smoke.mjs   # 或 npm test
```

改完代码要重载插件行才生效（link 安装不会自动重载）：`plugin_manager set_plugin { target: "include:sessionScheduler", enabled: false }` 再 `true`。

## 许可

[MIT](LICENSE) © universe-st
