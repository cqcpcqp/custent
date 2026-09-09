# MVP 架构

## 进程与请求链路

```text
React chat UI
  -> POST /api/chat
  -> Next.js Web/API process
       -> demo identity boundary
       -> atomic credit reservation
       -> persist input message + queued or waiting Run
       -> 202 ChatStartResponse

Independent Agent Worker
  -> poll and lease queued Run from PostgreSQL
  -> AgentRuntime (@openai/agents)
       -> Responses API
       -> hosted web_search
       -> hosted code_interpreter (only when OPENAI_CODE_INTERPRETER_ENABLED=true)
       -> save_research_results
       -> create_csv / create_pdf
       -> create_csv_file / create_pdf_file
  -> append Run events to PostgreSQL
  -> persist final message, session, artifacts and usage
  -> settle credit ledger

React chat UI
  -> GET /api/runs/:runId/events with Last-Event-ID
  -> Next.js relays persisted Run events as SSE

Retry
  -> POST /api/runs/:runId/retry
  -> create a new attempt for the same conversation Turn
  -> preserve the source attempt, events and credit ledger

Branch from a completed assistant answer
  -> POST /api/conversations/:conversationId/branches
  -> validate the source against the current selected completed path
  -> copy visible messages and the immutable post-Run context into a new conversation
  -> create no Run and make no provider request

Read-only share
  -> owner PUT /api/conversations/:conversationId/share
  -> snapshot the current selected branch
  -> public GET /share/:publicId reads the stored snapshot
  -> owner GET /api/conversation-shares lists share metadata with keyset pagination
  -> owner DELETE with expected publicId revokes only that exact public ID
```

一个用户回合对应一个 conversation Turn。Turn 首次执行有一个 Run；每次合法重试都会为同一 Turn 新建一个 attempt，因此一个 Turn 可以有多个 Run，旧 attempt 不会被新 attempt 覆盖。每个 Run 可以包含多次模型请求和多次工具调用，积分结算使用该 Run 的聚合 usage，而不是只计算最后一次 Response。

Next.js 请求的生命周期与 Agent 执行生命周期解耦。`POST /api/chat` 在事务内创建 `queued` 或 `waiting` Run 后立即返回；独立 Worker 才会真正调用模型。同一会话只允许一个 `queued` 或 `running` Run，后续 Turn 以 `waiting` 串行排队；不同会话可以并行。Agents SDK tracing 默认关闭；Worker 只向配置的 Responses provider 发起模型请求。Code Interpreter 能力由 `OPENAI_CODE_INTERPRETER_ENABLED` 严格控制，默认 `false`；关闭时 hosted tool 和对应 Agent 指令都不会进入供应商请求。

本地和生产环境都必须分别运行 Web/API 与 Worker：

```text
development: pnpm dev        + pnpm worker:dev
production:  pnpm start      + pnpm worker
```

两个进程使用同一个 PostgreSQL。当前本地文件产物还要求它们能访问同一个 `ARTIFACT_DIR`。

## 模块边界

| 目录 | 职责 |
|---|---|
| `app/` | 页面和 HTTP/SSE 路由 |
| `components/` | 纯前端聊天组件 |
| `lib/agent/` | 被项目封装的 Agents SDK 运行时 |
| `lib/runs/` | Run 队列、租约、事件仓库、取消和 Worker |
| `lib/db/` | PostgreSQL 连接、查询和 Agent Session 持久化边界 |
| `lib/credits/` | 预扣、结算和不可修改账本 |
| `lib/account/` | 当前用户余额与逐 Run 用量的只读账户查询 |
| `lib/custom-instructions/` | 账户自定义指令读取、修订号 CAS 更新与 owner 边界 |
| `lib/research/` | 研究快照、公司、联系人和证据 |
| `lib/artifacts/` | 确定性 CSV/PDF 生成 |
| `lib/library/` | 跨会话研究/文件的只读可达性查询与 keyset 分页 |
| `lib/errors.ts` | API 错误码的唯一枚举与服务端 `AppError` 类型 |
| `lib/contracts.ts` | 前后端固定 API/SSE 契约 |
| `components/api-client.ts` | 严格响应解析、错误 code/status 校验、网络/取消归一化与固定展示文案 |
| `db/migrations/` | 可重复执行的数据库迁移 |
| `scripts/agent-worker.ts` | 独立 Worker 进程入口 |

`lib/agent/` 之外的业务模块不依赖 Agents SDK。未来升级 SDK 或更换经过验证的 Responses-compatible 供应商时，业务数据库和文件格式不需要重写。

## API 错误契约与展示边界

`lib/errors.ts` 的 `APP_ERROR_CODES` 是 API 错误码的唯一枚举，`AppErrorCode`、服务端 `AppError` 和 `lib/contracts.ts` 的 `ApiErrorResponseSchema` 都从它派生。错误响应必须精确符合 `{ error: { code, message } }`：外层和内层 Zod object 都是 `.strict()`，未知 code、额外字段、缺失字段或错误类型都会拒绝解析。服务端 message 是线上的固定字段，但不是前端展示契约。

`components/api-client.ts` 对每个 `AppErrorCode` 穷举其合法 HTTP status，并以类型约束要求每个合法 `code/status` 组合都有固定用户文案。所有 JSON API 客户端先用共享 schema 解析错误 envelope，再在构造 `ApiClientError` 后校验实际 `Response.status`；未知组合直接抛出契约不变量错误。前端不会猜测新错误码、忽略额外字段、把违规响应解析成另一个后端错误或展示服务端 message。显式网络失败统一为不含原始细节的 `ApiNetworkError`，`AbortError` 保持原对象和取消语义；外层界面对普通本地异常或契约断言失败可以呈现固定的意外失败文案，但该文案不读取违规响应，也不是后端 response fallback。

## 会话策略

项目选择 SDK Session，把完整 Agent input/output item 保存到 PostgreSQL；不会同时使用 `previous_response_id` 重放会话。用于界面展示的用户/助手消息单独保存，避免把内部工具调用暴露给用户。

从已完成助手回答创建新对话继续复用严格的 `POST /api/conversations/:conversationId/branches`，请求固定为 `{ requestId, sourceMessageId }`。仓储只接受当前选中路径上的 `completed` 助手回答，复制截至该回答的可见消息和输入附件绑定，并把对应不可变 `post` Session snapshot 写成目标会话的 context seed；目标会话起始时没有 `selectedRunId`、活动 Run 或等待 Run。这个动作不创建 Run，也不调用模型供应商。助手回答只是把既有动作收进 More 菜单，用户消息的分支动作仍保持直接入口；没有为菜单发明第二套分支 API。

研究快照不是聊天历史。它是可查询的业务事实来源；公司/联系人研究清单使用 `create_csv` / `create_pdf` 从快照确定性导出。当前 SDK Session 已向模型提供完整会话，因此用户要求把会话中已经明确的其他表格或文字制成文件时，模型可把精确内容交给 `create_csv_file` / `create_pdf_file`，不需要创建虚假的研究快照。

两类文件共用同一个 `artifacts` 仓库、Run 租约校验、最终消息原子绑定和鉴权下载链路。研究导出的 `research_snapshot_id` 非空；通用会话文件为 `NULL`。通用 CSV/PDF 工具输入使用固定严格 schema，限制文件名、列/行/单元格或标题/段落以及总字节；CSV 渲染对可能触发表格公式的单元格加前缀保护。

CSV 产物和历史 CSV 输入附件复用同一个只读表格预览。前端只从契约给出的 owner-bound download URL 读取 Blob，再使用严格本地解析器处理可选 BOM、引用单元格、转义双引号以及引用内换行；表头必须非空，每个数据行必须与表头列数完全一致。空文件、空表头、无效或未闭合引号、以及列数不一致只会产生类型化 `invalid_csv` 预览状态：该状态不提供无意义的重试，但继续保留原文件下载。请求或网络失败使用独立的 `unavailable` 状态并允许重新载入。表头和单元格由 React 作为 inert text 输出，不渲染 HTML、链接或公式语义。

历史 XLSX 输入附件使用独立的浏览器端只读 OOXML 预览器，不新增后端接口，也不把输入附件伪装成 artifact。它只读取固定 owner-bound content URL，校验 ZIP 中央目录、本地头、数据描述符、CRC、总展开量、XML 编码/良构性/复杂度、内部关系类型与目标，再显示可见工作表。共享字符串、富文本、内联字符串、数字、布尔值和公式缓存值都只作为 inert text；公式本身、宏、超链接和外部关系从不执行或跟随。预览限制为 32 MiB 包、64 MiB 总展开量、8 MiB/份 XML、50 个可见工作表、单表 1000 行/50 列/20,000 个单元格、全工作簿 100,000 个物化单元格与 2,000,000 个显示字符；工作表顺序解压，重复目标拒绝，关闭窗口会通过同一 `AbortSignal` 停止后续异步解压与解析阶段。无效包进入非重试 `invalid_xlsx` 状态，浏览器缺少 raw-deflate 能力或请求失败进入可重试 `unavailable` 状态，两者始终保留原文件下载。同步 XML parser 只能在调用前后检查取消，因此预览预算仍是主线程卡顿的最终边界，而不是 Web Worker 级硬隔离。

## 自定义指令 v1 与隐私边界

账户设置 API 是 `GET /api/account/custom-instructions` 和 `PUT /api/account/custom-instructions`。两者都只返回固定 envelope `{ customInstructions: { enabled, content, revision, updatedAt } }`；PUT body 固定为 `{ enabled, content, expectedRevision }`。内容最多 4000 字符，启用时 `content.trim()` 必须非空。更新 SQL 使用当前 owner 和 `expectedRevision` 做 compare-and-swap，成功后 revision 恰好加一；旧 revision 返回 `409 CUSTOM_INSTRUCTIONS_REVISION_CONFLICT`。禁用不会删除账户内容，用户可以随后重新启用或在禁用状态下显式清空。

`029_custom_instructions.sql` 在 `users` 保存账户设置，在 `conversations` 增加 `custom_instructions_snapshot` 与整数 revision。历史会话以及设置禁用时创建的会话固定为 `NULL + 0`；设置启用时，新会话保存未经 trim/改写的原始 content 和正 revision。`createConversation` 使用一条 `INSERT ... SELECT FROM users` 在同一个数据库语句快照中读取 owner 设置并创建会话，避免先读后写竞态。数据库 shape CHECK 拒绝其他组合，UPDATE trigger 拒绝创建后改写两个快照字段，因此之后修改或禁用账户设置不会追溯改变旧会话。

Worker claim 在 Run、conversation 与 user owner 一致的 JOIN 中读取快照，并严格映射为 `{ content, revision } | null`。Runtime 只使用该会话快照，不会在每个 Turn 重新读取最新账户值；retry、regenerate 和等待队列因此继续属于创建会话时冻结的同一偏好。Agent 核心规则之后附加明确的低优先级策略，并把 content JSON 序列化为“不可信用户偏好”；内容不能覆盖外贸证据、工具和安全规则。这是提示注入分层，不是对模型输出效果的保证。

隐私边界是“内部执行输入，不是普通产品读取面”：账户原文只由 owner-bound 设置 API 读取；会话快照不进入 Bootstrap、会话详情/列表、分享管理、公开分享、Run event/SSE、消息、产物或活动 UI。快照以明文保存在 PostgreSQL，真实 Agent 执行时会发送给配置的模型供应商，因此数据库运维访问、备份安全和供应商数据政策仍然适用；v1 没有静态加密、Memory、自动学习、临时会话或数据保留管理。provider-free E2E 只能证明所覆盖的持久化和不泄漏读取面，不能证明真实 Worker 已把偏好正确作用于供应商回答。

## 资料库读取模型

资料库不是新的写模型。它直接从 `research_snapshots` 与 `artifacts` 读取当前 owner 可达的数据，不复制快照或文件，也没有 Library 删除接口、收藏关系或成员表。三个固定 API 是：

UI 路由同样由 pathname 驱动：`/library/research` 和 `/library/artifacts` 是两个列表的 canonical URL，`/library` 是 research alias，`/library/research/:snapshotId` 是详情。Tab 导航使用 history push，使刷新与 Back/Forward 恢复精确 surface；这些 leaf page 不挂第二个 workspace，根布局中的唯一 `ResearchWorkspace` 因而继续持有后台 SSE 和事件游标。

| API | 固定行为 |
|---|---|
| `GET /api/library/research` | 独立分页读取研究摘要 |
| `GET /api/library/artifacts` | 独立分页读取 finalized CSV/PDF |
| `GET /api/library/research/:snapshotId` | 在同一只读 repeatable-read 事务内读取研究摘要和完整公司/联系人/证据 |

两个列表只接受可选 `cursor` 和 `limit`；`limit` 默认 `24`，合法范围为 `1..50`，没有 `query` 搜索参数。它们分别使用 `created_at DESC, id DESC` keyset，cursor 是绑定 `research` 或 `artifacts` 列表类型的 opaque token，不能跨列表复用。

研究列表和详情必须同时满足以下数据库可达性条件：

- `research_snapshots.user_id` 是当前 owner；snapshot、Run 和 conversation 的 owner/conversation 关系一致。
- conversation 未软删除，Run 为 `completed`。
- `runs.assistant_message_id` 必须指向同 Run、同 conversation 且 role 为 `assistant` 的真实 message。

这会纳入已归档会话，也会纳入所有合法 completed 历史分支、retry 或 regenerate 结果，而不是只追随当前 `selected_run_id`。读取不做业务去重。软删除会话、运行中快照、其他 owner 数据以及缺少最终 assistant message 的不完整历史都会 fail closed。

文件列表只返回满足相同 owner/conversation 可达性的 `artifacts`：Run 必须 `completed`，`artifact.message_id` 必须等于 `run.assistant_message_id`，该 message 必须是同 Run、同 conversation 的最终 assistant message。`research_snapshot_id` 为非空时，还必须能解析到同 owner、同 conversation 的真实 snapshot；它允许属于该会话更早的 Run。`message_id IS NULL` 的未 finalized 工具产物不会出现，用户上传的 `input_attachments` 也不参与查询。

CSV 与 PDF 继续使用 `ArtifactViewer` 和 `/api/artifacts/:artifactId/download`，因此预览、下载文件名与 owner 鉴权沿用聊天中的固定链路。Library API 不增加第二套文件内容接口。

## 同会话队列与重试

每个首次提交的 Run 都有单调递增的 `conversationTurn` 和 `attemptIndex = 1`。同一会话已有活动 Run 或等待链时，继续发送的消息仍会保存并预扣积分，但对应 Run 为 `waiting`，通过 `predecessorRunId` 指向前一 Turn 的最新 attempt。

- `waiting` Run 没有 Worker 租约、开始时间或运行活动，也不会建立前端 SSE 订阅。
- `ConversationSummary.activeRun` 只表示 `queued`/`running` Run；固定的非负整数 `waitingRunCount` 单独表示当前 `waiting` Run 数量，使未加载详情的会话也能严格显示暂停队列并阻止归档或删除。
- 一个 Run 成功完成时，只在同一事务内把直接 `waiting` successor 提升为 `queued`；后续 Turn 仍保持 `waiting`，直到各自的直接前序成功。
- 前序 Run 变为 `failed`、`cancelled` 或 `reconciliation_required` 时不会提升 successor，既有等待链因此暂停。等待项可以取消，积分释放通过幂等账本项保证只发生一次。
- 只有最新的 `failed` 或 `cancelled` attempt 可重试；`reconciliation_required` 不可重试。如果某个直接 successor 已不再是 `waiting`，旧 attempt 也不能再重试，以免分叉已经开始的历史。
- 重试复用同一条用户输入消息，创建新的助手消息和 `attemptIndex + 1` 的 Run，并以 `retryOfRunId` 指向来源 attempt。仍在等待的直接 successor 会在创建重试的事务内改接到新 attempt。
- 来源 attempt 的状态、事件和积分账本保持不变。新 attempt 单独预扣、执行和结算；只有它成功后才提升改接后的直接 successor。

如果重试 attempt 自身的前一 Turn 尚未成功，它也保持 `waiting`，不会绕过 Turn 顺序。

Worker 真正处理一个 Run 前保存的 `pre` Session snapshot 是 retry 上下文的权威来源，已有 snapshot 永远不会被重新推导或覆盖。对于在领取前取消、或在模型调用前失败且缺少 `pre` 的来源 attempt，仓储只允许严格恢复两种上下文：首 Turn 从不可变 conversation context seed 复制（没有 seed 的普通会话严格等价于空数组），其他 Turn 从同 owner、同 conversation、已完成直接前序的不可变 `post` snapshot 复制。前序仍在执行时，retry 先以 `waiting` 持久化，待提升并被 Worker 领取后才执行同一解析；模型已经开始或已完成前序缺少 `post` 时返回 `RUN_CONTEXT_UNAVAILABLE`，不会猜测消息历史。

父 Turn 失败后创建新 attempt 时，改接范围还可包含其直接后继中从未执行的 `cancelled` attempt，以及依赖它们的 `waiting` retry。每个可改接行都必须同时满足 `started_at IS NULL`、`model_started_at IS NULL`、`attempt_count = 0` 且不存在 `pre` snapshot；这样 retry source 与 retry attempt 会在同一 conversation-lock 事务中指向父 Turn 的最新 attempt，同时不会改写任何已经执行过的历史上下文。

## Run 生命周期与租约

### 停止后继续发送

`030` 允许停止后的显式新消息继续同一对话。`cancelled` 与 `reconciliation_required` 不再直接导致 `STALE_PARENT`；只有实际选中分支不匹配才走分支刷新提示。费用待确认仍保留原状态和账本，不伪装成已成功结算的 `completed`。

续聊在原 conversation lock 和新消息预扣事务内物化前序的不可变 `post` 快照：已有 `post` 原样复用，否则使用权威 `pre`、原输入消息及附件引用、按事件 ID 排序的已显示文字与文件记录。中断的助手文本标记为 `incomplete`，不复制未完成的 SDK function call、隐藏推理或待执行工具指令。模型已启动而缺少 `pre` 时严格拒绝；尚未启动就取消的 Run 才能复用既有不可变上下文恢复规则。这个快照只表示可用于续聊的上下文，不证明费用已经结算。

数据库只允许有 `post` 快照的停止/待确认前序承接 `queued` 或 `running` 后继，保留 owner、conversation、相邻 Turn、不可变快照和重试身份约束。Worker 沿用读取前序 `post` 的路径，不恢复中断请求；显式新消息独立执行和结算。已有 `waiting` 队列不会自动提升，需先取消等待项；在已物化停止上下文之后新建的后继也能正常取消、重试。

Run 状态为 `waiting`、`queued`、`running`、`completed`、`failed`、`cancelled` 或 `reconciliation_required`。

1. Web/API 事务创建输入消息、积分预扣记录，以及 `queued` 或 `waiting` Run。
2. Worker 只使用 `FOR UPDATE ... SKIP LOCKED` 领取 `queued` 项，并写入租约 owner、token 和到期时间。
3. Worker 执行期间续租；只有持有当前租约的 Worker 能写研究快照、文件和 Run 事件。
4. 成功完成时，最终消息、SDK Session、usage、积分结算、`done` 事件和直接 successor 的提升在数据库事务中提交。
5. 失败、取消或待对账不会提升 successor；等待链保持暂停，直到合法重试成功或等待项被取消。
6. Worker 意外退出后，未开始调用模型的过期 Run 可以重新排队；可能已经产生供应商成本的 Run 进入待对账，避免错误退款或重复执行。

默认配置如下：

| 配置 | 默认值 | 作用 |
|---|---:|---|
| `RUN_WORKER_CONCURRENCY` | `2` | 单个 Worker 的并行执行数 |
| `RUN_WORKER_POLL_MS` | `250` | 空闲 Worker 查询队列的毫秒间隔 |
| `RUN_LEASE_MS` | `30000` | Run 租约时长；最小允许 `10000` |
| `RUN_EVENT_POLL_MS` | `250` | SSE 中继查询新事件的毫秒间隔 |
| `OPENAI_REASONING_MODE_ENABLED` | `false` | Worker 是否支持向供应商发送 `reasoning.mode` |
| `OPENAI_CODE_INTERPRETER_ENABLED` | `false` | 是否注册 Code Interpreter hosted tool 并加入 Python 指令 |

租约续期和取消检查间隔为 `min(1000ms, RUN_LEASE_MS / 3)`，默认约一秒。

Run 创建事务同时写入一行不可变 `run_execution_configs`。新建 snapshot v2 固化执行模式、供应商、Base URL、模型、reasoning mode/effort/summary、是否实际发送 `reasoning.mode`、全部工具开关、最大 Agent 轮数和计费政策；这些字段共同参与请求幂等指纹。retry 与 regenerate 逐字段复制来源快照，不能使用重试时的部署环境重新解析。Worker 领取 SQL 同时匹配 provider、Base URL、reasoning mode 能力和工具能力，因此不兼容 Run 不会先调用供应商再降级重试。历史 snapshot v1 固定表示曾发送 `reasoning.mode`，`legacy_unknown` 只用于不可执行的迁移历史。

## SSE 与活动历史

Run 活动先写入 `run_events`，再由 `GET /api/runs/:runId/events` 中继，因此 SSE 不是任务执行的所有者。

- 当前可见会话使用唯一的 `foreground_follow`：完整事件按 animation frame 批量提交到 React，终态立即提交。切到后台或页面隐藏会中止该查看连接，不会影响 Worker。
- 所有后台 Run 共用一个 settle 后再调度的轻量 Bootstrap 观察循环；它只合并固定会话摘要、attention 和积分，不恢复侧栏分页深度、不改 cursor、也不主动下载各 Run 的完整活动。完整 revalidation 可以抢占尚未开始的后台轮询，运行中的请求不会重叠。
- 重新打开会话时从界面最后已提交的事件游标使用 `Last-Event-ID` 补播缺口；终态历史的 `replay_once` 完整且有限，不会转成持续连接。
- 页面关闭或 SSE 断开只会停止查看，不会向 Worker 发送取消信号。
- 网络恢复或页面重新打开后，前端使用 `Last-Event-ID` 继续读取，服务端按持久事件 ID 严格重放。
- `waiting` Run 尚未执行，不产生运行活动，前端不为其建立 SSE 订阅；提升为 `queued` 后才进入正常的活动订阅流程。
- 加载会话时，当前 `selectedRunId` 对应的终态 Run 会自动执行一次 `replay_once`，让正文活动统计在硬刷新后直接恢复；其他未选中的历史终态 Run 仍留到用户打开活动面板时回放。已加载或正在回放的 Run 不会重复订阅。
- 只有 `POST /api/runs/:runId/cancel` 表示用户明确要求停止。已排队或尚未调用模型的 Run 可释放预扣；已调用模型且成本未知时进入待对账。
- `AgentRun.cancelRequestedAt` 严格映射持久化的 `runs.cancel_requested_at`。因此取消接口返回、会话详情和刷新后的前端都能一致展示“正在停止”，不会只依赖发起取消的单个页面内存状态。

公开活动包括状态、模型提供的 reasoning summary、网页搜索动作、Code Interpreter 的代码/执行阶段/日志与生成图像 URL、本地工具输入/输出、生成文件和终态。界面不展示或伪造隐藏思维链。

Code Interpreter 当前是默认关闭的初始链路。只有 `OPENAI_CODE_INTERPRETER_ENABLED=true` 时，Runtime 才注册 Agents SDK hosted tool（`includeOutputs: true`）并把 Python 使用规则加入 Agent 指令。Runtime 严格映射固定的 `in_progress`、code delta、code done、`interpreting`、`completed` 事件与包含 `code_interpreter_call.outputs` 的最终 item；Worker 把它们转换为三类固定 Run event 落库，前端再按 `callId` 和严格递增的 provider sequence 聚合。消息内最近活动和完整活动面板都有类型化 Python 卡片：代码与日志以文本展示；生成图像只接受 HTTP(S) URL，并只提供由用户主动打开的链接，页面不会自动加载远程图像。

这条事件/UI 链路不等于可生产放量的 Code Interpreter。当前没有执行会产生真实用量的供应商能力 probe；积分 usage 与结算只包含输入 token、输出 token 和 Web Search 次数，没有 Code Interpreter session 的独立产品计价字段；container 生成文件也没有复制进 owner-bound artifact storage。项目不会猜测 session 价格或供应商支持度，因此在付费 probe、计费契约和生成文件转存完成前，开关保持默认 `false`。

## 后台任务历史与完成通知

`GET /api/runs/history` 是后台任务中心的严格只读历史接口。它只接受 `status`、`cursor` 和 `limit`：`status` 默认为 `all`，固定可选值为 `all`、`completed`、`failed`、`cancelled`、`reconciliation_required`；`limit` 默认为 `20`，合法范围为 `1..50`。响应只包含当前用户拥有、原会话未软删除且已经进入上述四种终态的 Run；查询同时约束 `run.user_id`、`conversation.user_id` 及二者关系，不把其他 owner 或已软删除会话暴露到任务中心。

历史按 `finished_at DESC, run.id DESC` 使用 keyset 分页。opaque cursor 保存 microsecond 精度的 `finishedAt`、`runId`、版本、列表类型和当前 `status` 筛选；非 canonical base64url、错误版本、其他列表的 cursor，或把一个筛选的 cursor 用到另一个筛选，都会固定返回 `INVALID_REQUEST`。UI 分别呈现首屏加载、首屏失败重试、空结果、加载更多和加载更多失败重试；历史列表按 Run ID 排除上方仍显示为 active 或未读 attention 的同一项，整页被排除时自动继续 keyset 分页，避免假空态。任务面板打开期间使用已有 Bootstrap 变更 revision 取消旧请求并重载当前筛选，因此跨标签删除、已读或新完成不会长期留下陈旧历史。选择任一历史项会打开对应会话的指定 Run 活动，而不是只跳到该会话当前选中的回答。

任务历史错误展示不读取异常自身的 message。显式 `ApiNetworkError` 映射为固定网络文案；`400 INVALID_REQUEST` 和 `500 INTERNAL_ERROR` 使用固定的任务历史文案。未知 API code、额外字段或 code/status 不匹配会在 API 边界被判定为契约违规，不会被猜成另一个 API 响应；随后外层 catch 与普通本地 `Error` 一样只允许显示固定的意外失败文案，因此后端 SQL、URL、供应商细节或内部英文错误不会透传到界面。

站内完成 toast 与浏览器系统通知是两条独立呈现链路。站内 toast 始终保留；系统通知默认关闭，用户只能从设置中显式开启，首次开启动作才请求浏览器权限。完成、失败、停止和待对账终态都使用同一套 Run identity。浏览器通知要求 Notification API、Web Locks 和可写的 `localStorage`：Web Lock 串行化同源标签页，版本化 ledger 以 `conversationId + runId` 去重且不截断仍需去重的 identity。启用通知时，只有系统 `Notification` 成功构造后才提交该 identity；构造失败或页面卸载不会提前留下“已送达”记录。ledger 写入失败时会撤回刚构造的通知并保持未提交；存储不可用时设置页通过实际写探针显示明确的不可用状态且不发送系统通知。初始 Bootstrap 已存在的 attention 是本页面的通知基线，不会在后续聚焦重校验时补发；手动关闭的站内 toast 以页面会话内 dismissed Run ID 保持关闭，但不会擅自把后端 attention 标成已读。用户点击通知会打开对应 Run 的活动。

## 只读对话分享

分享是用户主动创建的持久化快照，不是对 owner 对话接口的公开代理。创建或更新时，服务端在事务内锁定对话，拒绝空对话以及仍有 `waiting`、`queued` 或 `running` Run 的对话，并只遍历当前 `selected_run_id` 对应的分支。更新已有分享会保留原 `public_id`；撤销后再次创建会生成新的随机 UUID。

公开快照严格只包含标题、消息正文、引用、时间和文件元数据。输入附件与 artifact 只保留名称、MIME 类型和大小，不保存资源 ID、私有下载 URL 或文件内容，因此公开页面不会绕过既有 owner 鉴权下载路由。公开读取同时要求原对话未删除；撤销分享或软删除原对话都会让链接立即返回 404。软删除会话时，同一事务还会删除对应 `conversation_shares` 行，不保留 owner 已无法触达的残留链接。

设置中的“数据控制 → 共享链接”使用固定的 `GET /api/conversation-shares?cursor=<opaque>&limit=<1..50>`，默认每页 `30` 项。接口只返回当前 owner、未软删除会话的分享元数据，不读取或发送快照消息体；已归档会话仍然可见。结果按 `updatedAt DESC, conversationId DESC` keyset 分页，cursor 保存 PostgreSQL microsecond 精度并绑定 `conversation_shares` 列表类型。打开操作直接使用固定 `publicPath`；撤销继续调用 per-conversation share 路由，但请求必须携带 `expected publicId`，仓储同时匹配 conversation 与 public identity，因而旧标签页不能误删另一标签页后来重建的新链接。

## 账户级批量对话数据控制

“设置 → 数据控制”在共享链接之外提供归档所有对话和删除所有对话。两项操作复用既有 collection route，不创建第二套会话接口：

| 方法 | 固定请求 | 固定成功响应 |
|---|---|---|
| `PATCH /api/conversations` | 严格 JSON body `{ action: "archive_all" }` | `{ mutation: { action: "archive_all", conversationCount, completedAt } }` |
| `DELETE /api/conversations` | 无请求 body | `{ mutation: { action: "delete_all", conversationCount, completedAt } }` |

请求和响应都由 strict schema 解析；`conversationCount` 是非负安全整数，`completedAt` 是数据库事务内取得的 ISO datetime。归档目标严格是当前 owner 的 `deleted_at IS NULL AND archived_at IS NULL` 对话；删除目标是当前 owner 全部 `deleted_at IS NULL` 对话，因此包含已归档项但不重复计算此前已软删除项。空目标集合仍成功并返回 `conversationCount: 0`。

仓储先按稳定 ID 顺序 `FOR UPDATE` 锁定完整目标集，再检查其中是否存在 `waiting`、`queued` 或 `running` Run。只要命中一项，整个事务固定以 `409 ACTIVE_RUN` 拒绝，任何目标都不会被部分修改。归档在同一事务把完整目标集写为已归档；删除在同一事务撤销目标集的全部 `conversation_shares` 后写入 `deleted_at`。append、retry 和 regenerate 创建 Run 的入口也要求持有尚未归档、尚未删除的 conversation lock，所以不能在归档提交之后为该会话补建 Run。

批量删除沿用单会话软删除的附件边界，而不是物理擦除：已绑定输入附件的数据库行和文件字节保留，也不写 `input_attachment_deletions` tombstone；所有 owner-bound 附件读取都要求原 conversation 未删除，因此这些附件随软删除对话变为不可达。归档不会撤销分享，也不会改变已绑定附件可达性。

前端确认层在设置模态之上使用既有叠层焦点协议，删除确认使用 `alertdialog`；初始焦点落在取消动作，提交期间禁止取消、Escape 和 backdrop 关闭，结束后焦点回到触发按钮。成功后工作区推进 observation revision、终止旧详情/分页/Run 订阅并重置会话缓存，再导航到 `/` 和触发完整 Bootstrap 重校验。只有 `delete_all` 会清理浏览器中 conversation 作用域的文本草稿、执行模式草稿和未发送附件草稿，并尝试回收对应 staged 附件；独立的 new-conversation 草稿与其 staged 附件保留。`archive_all` 保留两类本地草稿。

## Bootstrap、会话分页与草稿

`GET /api/bootstrap` 使用与会话搜索相同的 keyset cursor 契约，只返回 30 条 active 会话首屏和必填的 nullable `nextCursor`。侧栏在自身滚动容器接近底部时串行请求 `GET /api/conversations`，迟到页面必须同时通过请求 controller、列表 generation、请求 cursor 和会话 observation revision 围栏后才能合并；因此旧页面不会覆盖实时 Run/attention，也不会复活请求期间已删除或归档的摘要。后台轮询复用同一个固定响应契约，但使用轻量 commit，不取消或伪造用户已加载的分页窗口。

分页窗口缺失不表示会话已删除。当前直接路由到窗口之外的会话继续通过既有详情接口加载；只有详情接口明确返回 `NOT_FOUND` 才会移除当前会话并导航。Bootstrap 的 `trackedConversations` 独立列出所有存在 queued/running Run、waiting 队列或未读终态 attention 的 active 会话，不受侧栏分页限制，用于驱动后台摘要观察、任务中心和完成通知。

文本草稿保存在浏览器的版本化 v1 envelope 中，新对话与每个 conversation ID 使用互不重叠的 key。提交得到服务端确认或会话确认删除后才清理。

已完成上传、尚未发送的 composer 附件使用独立的版本化 v1 envelope；key 同时包含当前 `userId`、草稿 scope 和 `attachmentId`，每个附件一条记录，因此两个标签页同时添加不会整组覆盖。记录严格保存 POST 返回的 `InputAttachmentSummary`、数据库返回的真实 `expiresAt` 和稳定顺序 token；不保存本地 `File`、上传中状态或 blob URL，也不在客户端推算 24 小时 TTL。

进入或刷新 scope 时，客户端先剔除明确过期记录，再对每个剩余 ID 调用 `GET /api/input-attachments/:attachmentId`。该资源只在附件属于当前用户、`attached_at IS NULL` 且 `expires_at > now()` 时返回严格的 `{ attachment, expiresAt }`，其他 owner、已绑定、已过期或已删除状态统一为 404。404 会移除本地引用；网络/5xx 会保留记录、暂停发送并给出重试或显式放弃操作，避免只发送文字而漏掉附件。浏览器存储不可访问时会明确提示，不会伪装成已持久化。Storage Event 让当前 scope 在其他标签页添加、删除或发送后重新走同一权威校验。

消息提交成功只删除本次请求实际使用的附件记录；手动移除及会话确认删除会清理对应 scope 并尝试 DELETE staged 文件，失败的物理回收仍由既有 TTL/outbox Worker 兜底。刷新发生在上传响应返回前时，浏览器尚不知道 attachment ID，也不能恢复原始 `File`；该边界由 TTL 回收，不假装成可恢复上传。

## 积分与用量读取模型

`GET /api/account/usage` 是只读账户接口，只读取可选的 opaque `cursor` 和 `limit`。`limit` 默认 `30`、范围 `1..50`；Run 使用 `created_at DESC, id DESC` keyset。游标以 microsecond 精度保存创建时间并绑定 `account_usage` 类型，非 canonical base64url、错误版本或其他列表的游标都会固定返回 `INVALID_REQUEST`。

侧栏余额是该读取模型的入口。前端打开“积分与用量”模态后严格解析固定响应，分别显示三类余额，并按 cursor 追加逐 Run 明细；预留积分与最终实扣始终分列，数据库中的 `NULL` usage/结束时间直接显示为未确定，不在客户端推断。

路由在同一个 `REPEATABLE READ READ ONLY` 事务中读取用户余额和当前页，因此 `available`、`reserved`、`frozen` 三列与该次 Run 页面属于同一数据库快照。明细直接来自 `runs`，并用 `run.user_id = 当前用户`、`conversation.user_id = run.user_id` 和 `conversation.user_id = 当前用户` 同时封闭 owner 边界；不会读取或聚合 `credit_ledger`，所以同一 Run 的预扣与结算账本项不会形成两条消费记录。

每个 Run 返回一项，状态沿用数据库固定的 `waiting`、`queued`、`running`、`completed`、`failed`、`cancelled`、`reconciliation_required`。`charged_credits`、三类 usage 与 `finished_at` 直接映射数据库 nullable 字段，不在 API 层推断或补值。账务历史刻意包含软删除 conversation 并保留其 title；归档和当前选中分支同样不影响可见性。该读取模型复用现有 `runs_user_created_idx` 的 owner/创建时间顺序，不修改积分写路径、账本或 schema。

## 积分一致性

1. 使用 request ID 建立幂等 Run。
2. 数据库事务锁定积分账户并预扣。
3. Worker 完成后汇总输入 token、输出 token 和 Web Search 次数。
4. 成本不超过预扣时，结算实际积分并释放剩余积分。
5. 成本未知或超过预扣上限时，运行进入待对账状态，预扣不自动释放。

积分账本只追加，不修改历史记录。

当前 policy v1 是产品积分费率，而非美元账单：分别对输入/输出 token 按千 token 费率向上取整，再加 Web Search 次数费用。代码没有供应商美元实扣字段或美元兑积分配置。中断可能拿不到完整 usage，故只能保留预扣为费用待确认；这不能等同于最终消费，也不能据此禁止用户在原对话发起新一轮。真实美元计费需要另行确定供应商费用凭据、换算比例及幂等的后台结算契约，本次续聊修复不变更历史或新 Run 的计费率。

上述结算模型尚未计入 Code Interpreter session 用量；这也是 `OPENAI_CODE_INTERPRETER_ENABLED` 默认关闭的生产边界，不得把 token 计费误当成已覆盖 Python session 成本。

## Provider-free 浏览器回归边界

正式 `pnpm e2e` 在一次性 PostgreSQL 数据库和隔离 production build 上串行执行 11 条 Chromium 场景。自动 `browserRuntimeErrors` fixture 在 browser context 的既有页面和后续 Page（包括 popup）上统一注册 `console` 与 `pageerror` 监听；任意 `console.error` 或未捕获页面异常都会记录页面 URL，并尽量附加 console 源位置或异常 stack，在场景 teardown 失败。监听器按 Page 去重，在场景主体完成后显式解绑并断言累计记录为空，防止跨场景污染。

当前数据库终态断言仍固定为 16 个 Run：12 个 `completed`、2 个 `cancelled`、1 个 `failed`、1 个 `reconciliation_required`，且没有 `waiting`、`queued` 或 `running`。唯一的 `model_started_at` 由夹具直接标记，用于验证待对账状态而非供应商调用。其中 8 个 Run 验证跨会话后台观察与有限活动回放；同一场景随后在真实已完成助手回答上打开 More 菜单，验证首项焦点、`Escape` 返回稳定触发器和外点关闭，再通过真实 `POST /api/conversations/:conversationId/branches` 严格解析请求与响应，确认新对话没有 Run、包含复制回答、进入 canonical 路由且 composer 获得焦点。这个分支新增一个独立对话但不改变 Run 总量。另有 1 个附件 Run 验证在同一消息上传 TXT 与双工作表 XLSX、源码预览、停止 Run、刷新后从历史消息打开 XLSX、切换工作表、鉴权下载及焦点恢复，2 个 Run 验证两个新会话分别冻结不同 revision 的自定义指令，另 5 个 Run 验证同会话三 Turn waiting 链：等待中取消、active predecessor 下重试仍为 waiting、只提升直接后继、失败后新 attempt 不覆盖旧 Run、后续 Run 进入待对账，以及任务中心和完整活动面板的可见性。独立的无 Run 移动叠层场景验证侧栏内设置与积分窗口只有顶层可交互、焦点环、逐层关闭、逐层焦点恢复，以及不存在 disabled + expanded 控件。

资料库场景不创建额外 Run：夹具在既有 detailed Run 的有效租约下复用正式 research/artifact repository，保存恰好 1 份研究快照和 1 个 CSV，并在完成事务中校验文件精确绑定该 Run 的最终 assistant message；浏览器随后验证 `/library/research`、研究详情、`/library/artifacts`、严格 CSV 表格预览、鉴权下载、焦点恢复和窄屏无横向溢出。自定义指令场景除逐一检查普通 Bootstrap/会话/分享 API、公开分享 HTML、Run SSE、持久 Run event、分享消息快照和活动 UI 不包含私密 marker 外，还验证分享创建、保留同一 public ID 的快照更新、撤销、公开页面和撤销后 404。账户用量场景验证固定余额、严格 cursor 分页，以及 UI 恰好显示 16 条 Run ID 唯一的用量记录。最后一条 serial 场景不创建 Run，先归档再删除全部账户对话，验证严格 archive/delete 请求与响应、分页得到的精确 mutation count、active/archived UI 和 API、嵌套确认层的焦点与 pending 锁、归档阶段仍有效而删除后失效的分享，以及只清理 conversation 作用域本地草稿。该场景结束后 16-Run 数据库不变量保持不变。

该套件故意不启动 Agent Worker。数据库夹具通过正式 repository claim Run、核对 claim 中的自定义指令快照、按正式上下文契约物化 retry source、写入确定性事件，并通过 repository 驱动完成、失败、取消和待对账；本地 provider tripwire 的成功条件是恰好零请求。因此它是 Web/API、迁移后 PostgreSQL、SSE replay 和浏览器 UI 的组合证据，不是 Agents SDK、真实模型、Web Search、Code Interpreter 或自定义指令影响回答的供应商证据。

`CUSTENT_E2E_INSPECT_MS` 只接受 `0..600000` 内的 canonical 十进制整数。非零时，它在 Playwright 断言和固定 16-Run 校验之后继续保留隔离 production server，专供只读视觉检查；保留期间不应提交消息或改写隔离数据。provider tripwire 会继续计数，并在停止服务和清理资源的阶段最终断言恰好 0 次请求。

## 前端视觉、模态层与焦点协议

聊天正文、历史回答提示、归档提示、附件草稿恢复提示和 composer 共用 `--conversation-measure: 760px`，形成同一阅读中轴。顶栏使用单行主标题和弱化状态标签；用户消息使用无边框、无阴影的轻背景圆角气泡；composer 使用更轻的阴影与聚焦态。基准桌面侧栏固定为 `264px`，以纯色 `var(--sidebar)` 取代装饰渐变和伪元素，主要导航动作与会话行使用紧凑的 `36px` 高度、中性 hover/focus/active 填充，并让会话列表占用剩余高度独立滚动；在 `720px` 高桌面验证模型中，固定 chrome 后仍为列表保留 `397px`。窄桌面继续按断点收窄，移动端则保持至少 `44px` 交互目标，不把桌面高密度尺寸套到触摸界面。桌面和移动端分别固定轮次间距，移动端标题、用户消息和助手正文不再使用原先的 12px 小字号。暗色主题使用同一套轻量层级。这些是静态布局与视觉节奏约束，不改变业务状态或 API 行为，也不等于完成整体 ChatGPT 视觉对齐。

生成文件预览、输入图片预览和输入文本预览共用 `useModalFocus`：打开时把 backdrop 之外的 body sibling 设为 `inert`，只让顶层模态响应 `Escape` 与 `Tab`/`Shift+Tab` 焦点循环，关闭后清理状态并把焦点返回原触发器。搜索/归档入口与搜索 dialog、分享按钮与分享 dialog、完整活动触发器与活动面板都使用稳定 ID 和准确的 `aria-haspopup`、`aria-controls`、`aria-expanded`；搜索 combobox 指向始终挂载的 listbox。分享撤销确认有明确的进入/取消/成功焦点目标，资料库详情进入时聚焦返回动作，返回列表时优先恢复原快照卡、卡片不存在时恢复当前 Tab。分支切换在处理中通过 `aria-disabled` 报告不可用。backdrop 的 pointer 关闭路径先阻止默认聚焦，避免关闭瞬间把焦点交给背景元素。

已完成助手回答的“在新对话中分支”位于尾部 `AssistantMessageMoreMenu`；用户消息仍使用直接分支按钮。More 触发器持久挂载并精确设置 `aria-haspopup="menu"`、`aria-controls` 与 `aria-expanded`，菜单本体以 `position: fixed` portal 挂到 `document.body`，按视口边缘选择触发器上方或下方并做 gutter clamp。点击或 `ArrowDown`/`ArrowUp` 打开时分别聚焦首项或末项；菜单内 `ArrowDown`、`ArrowUp`、`Home`、`End` 循环导航，`Tab`/`Shift+Tab` 以持久触发器为锚移动到页面下一个或上一个合法 tab stop。`Escape` 关闭并恢复触发器焦点；外部 pointer 只关闭菜单，让被点击的外部目标自然取得焦点。scroll 监听会比较触发器相对打开时的几何位置：只有真实移动才关闭陈旧定位，同位置的延迟 scroll 事件会被忽略；resize 仍关闭菜单。不可用分支菜单项使用可聚焦的 `aria-disabled` 和精确原因，不伪装成可执行；分支提交开始后菜单关闭、触发器禁用并发布 pending 状态。执行菜单项时传给既有分支回调的是仍连接文档的 More 触发器，而不是即将卸载的 portal 菜单项，因此失败路径仍能使用原工作区协议恢复焦点；成功路径进入新对话并聚焦 composer。

## 队列、历史关联、通用产物、读取索引、事件与个性化迁移部署约束

`009_run_turn_queue.sql` 会回填并强制 `conversation_turn`，增加 attempt/predecessor/retry 关系约束，调整输入消息唯一索引，并把 `waiting` 加入 Run 状态契约。`010_retry_predecessor_integrity.sql` 随后强化 retry 前序完整性，并在安装约束时校验已有 Run。`011_legacy_run_message_links.sql` 在锁定相关表的事务内修复旧 Run 的消息关联：只接受同一会话中落在 `[Run.created_at, 下一 Run.created_at)` 且唯一的用户消息，同时把该消息的 `run_id` 绑定到首个 attempt；retry 必须继续复用首个 attempt 的输入。候选缺失、候选歧义、候选已属于其他 Run、缺字段的 retry/non-terminal Run，都会让迁移整体回滚。

`012_generic_artifacts.sql` 只把 `artifacts.research_snapshot_id` 改为可空并保留原外键：已有研究导出不变，新的通用会话文件用 `NULL` 明确表示没有研究快照来源。`db/assertions/012_generic_artifacts.sql` 可重复验证列、外键以及 artifact/run/conversation/snapshot 的既有关联一致性。

`021_library_indexes.sql` 不改变任何行或可见性规则，只增加两个普通 btree 索引：`research_snapshots (user_id, created_at DESC, id DESC)`，以及带 `message_id IS NOT NULL` predicate 的 `artifacts (user_id, created_at DESC, id DESC)`。它们服务于两个彼此独立的 Library keyset 列表。`db/assertions/021_library_indexes.sql` 会在始终回滚的事务里精确检查索引方法、key 顺序、DESC options、predicate、valid/ready 与 non-unique 属性；该 assertion 由迁移集成测试显式执行，不是 `pnpm db:migrate` 的隐式步骤。

`024_background_run_history_index.sql` 不改变 Run 状态或历史可见性规则；它增加普通 partial btree 索引 `runs (user_id, finished_at DESC, id DESC)`，predicate 固定覆盖 `completed`、`failed`、`cancelled` 和 `reconciliation_required`，服务于后台任务历史的 owner/终态/keyset 查询。`db/assertions/024_background_run_history_index.sql` 同样在回滚事务内严格检查索引方法、key 顺序、DESC options、predicate、valid/ready 与 non-unique 属性。

`026_code_interpreter_run_events.sql` 只更新 `run_events.event_type` 的固定 CHECK：加入 `code_interpreter_status`、`code_interpreter_code` 和 `code_interpreter_result`，保留原有事件类型并继续拒绝未知类型。`db/assertions/026_code_interpreter_run_events.sql` 与 `tests/code-interpreter-run-events-migration.integration.test.ts` 分别验证约束文本以及迁移前拒绝、迁移后 append/replay、未知类型仍拒绝的真实 PostgreSQL 行为。

`027_run_execution_configs.sql` 要求升级时不存在仍可能执行的 legacy Run，然后为每个 Run 建立恰好一行不可变执行配置；历史终态只记录 `legacy_unknown`，不会从当前环境补造模型或价格。`028_reasoning_mode_capability.sql` 增加 nullable `reasoning_mode_enabled`：captured v1 严格回填 `TRUE` 以保留旧执行语义，legacy 保持 `NULL`，新 captured v2 明确保存 `TRUE/FALSE`。两次迁移都通过延迟完整性触发器约束 Run/config 一对一、预扣一致性以及 retry/regenerate 全字段相等。

`029_custom_instructions.sql` 新增账户 setting 和会话快照列；所有既有会话保持 `NULL + 0`，不会从消息或当前环境推断历史偏好。用户 setting 约束内容长度、启用时的非空白内容与非负 revision；conversation shape CHECK 要求快照存在时 revision 为正，不存在时 revision 恰好为零。永久 trigger 只允许创建时写入快照，之后的 UPDATE 会 fail closed。`db/assertions/029_custom_instructions.sql` 可重复核对列类型/default/nullability、稳定 constraint/trigger/function 以及所有持久行的形状；`tests/custom-instructions.integration.test.ts` 只在显式 `TEST_DATABASE_URL` 上创建和清理隔离 schema，验证迁移、CAS 竞争、原子捕获、不可变性和 claim 映射。

对于缺少助手消息 ID 的历史终态，`011` 给失败、取消和待对账 Run 补充未落消息的 planned UUID。只有在同会话不存在助手消息和助手 session item，且当前 Run 没有活动事件、研究快照或产物时，才会把缺失回答的 completed Run 判定为不可恢复，并插入明确标注为“系统迁移说明、并非模型回答”的助手消息；说明消息沿用 Run 的历史终态时间且不会推进 `conversation.updated_at`。任何可能恢复回答的证据都会让迁移停止，交由人工处理。迁移结尾对所有现有 Run、首 attempt、retry 复用关系、`messages.run_id` 和 completed 助手消息执行全量严格校验。

这不是可以让旧应用与新 schema 并存的滚动升级：旧版本不会写入必填 Turn 字段，也不认识新的固定状态与响应字段。

已有数据库升级时必须使用停写维护窗口：

1. 停止 Web/API、Agent Worker 和附件回收 Worker，确认所有旧版本进程已经退出，并先完成数据库备份。
2. 执行一次 `pnpm db:migrate`，让迁移器按文件名顺序应用所有尚未安装的 migration，包括 `021_library_indexes.sql`、`024_background_run_history_index.sql`、`026_code_interpreter_run_events.sql`、`027_run_execution_configs.sql`、`028_reasoning_mode_capability.sql` 和 `029_custom_instructions.sql`；每个 migration 及其 `schema_migrations` 记录分别在自己的事务中提交。`021` 与 `024` 都使用普通 `CREATE INDEX`，不要在仍有应用写流量时执行。若 `011` 或 `027` fail closed，保持服务停止，人工核对异常 Run 后再重新执行，不要绕过断言。
3. 部署当前版本的 Web/API 与 Worker，再统一恢复服务。

`pnpm dev`、`pnpm start` 和 Worker 不会代替上述命令迁移数据库。迁移器使用 PostgreSQL advisory lock 串行化执行，并校验已记录 migration 的 checksum；不要修改已经应用过的 migration 文件。需要验证 `021` 时，应对指定测试数据库运行 `tests/library-indexes-migration.integration.test.ts` 与 `tests/library-repository.integration.test.ts`；需要验证 `024` 时运行 `tests/background-run-history-index-migration.integration.test.ts`；需要验证 `026` 时运行 `tests/code-interpreter-run-events-migration.integration.test.ts`；需要验证 `029` 时运行 `tests/custom-instructions.integration.test.ts`。测试会创建并清理隔离 schema，不应把 `TEST_DATABASE_URL` 指向未经授权的数据库。

不要在迁移完成后继续运行旧应用，也不要采用先迁 schema、再逐台替换旧实例的滚动混跑方式。

## MVP 之外

真实上线前仍需增加：正式认证、生产级队列或 Worker 编排、对象存储、管理员对账、限流、数据保留策略、联系人合规流程和离线质量评测。自动外联不在本版本范围内。
