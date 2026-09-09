# Custent

Custent 是一个面向国内工厂的外贸研究 Agent MVP。用户可以像使用聊天助手一样描述产品和目标市场，Agent 会通过 OpenAI Responses API 的 Web Search 检索公开网页、保留来源，并把结构化研究结果生成 CSV 或 PDF。

当前版本由一个 Next.js Web/API 进程、一个独立 Agent Worker、一个独立 Run Reaper、一个附件回收 Worker 和一个 PostgreSQL 数据库组成。它不自动发送开发信，也不会猜测联系人或邮箱。

下列内容是已经实现并验证的产品切片，不表示 Custent 已经完整复刻 ChatGPT 网页版。真实认证、付费与账户安全、Memory/临时会话、管理员对账、Canvas、定时任务、Projects、Connectors 和图像生成等能力仍在范围之外；完整基线与剩余清单以 [docs/chatgpt-parity.md](docs/chatgpt-parity.md) 为准。

## 已包含的能力

- ChatGPT 风格的流式聊天界面
- 本轮聊天视觉节奏统一到 `760px` 对话中轴：正文、历史/归档/附件恢复提示与输入框对齐；顶栏改为单行标题和弱化状态，用户气泡与输入框使用更轻的边框、阴影和圆角，桌面/移动端轮次间距及移动字号同步收敛。这只是当前已验证的视觉改进，不是整体 ChatGPT 视觉对齐声明
- 基准桌面会话侧栏收敛为 `264px` 高密度扁平布局：使用纯色背景和中性行状态，不再叠加装饰渐变；新建、资料库、搜索、任务和会话行采用紧凑的 `36px` 节奏，把剩余高度留给独立滚动的会话列表。窄桌面继续响应式收窄，移动端交互目标仍保持至少 `44px`
- 消息复制、赞同/不赞同、代码块复制、用户消息编辑分支、重新生成和回答版本切换；已完成助手回答的“在新对话中分支”收进尾部“更多回答操作”菜单，用户消息的同名动作仍保留直接入口。重新生成具备永久资格但暂时受运行中、归档或会话修改阻止时，入口保持可见并显示准确的禁用原因
- 助手回答 More 菜单使用固定定位 portal 和稳定触发器：点击或 `ArrowDown`/`ArrowUp` 打开并聚焦首项/末项，菜单内支持方向键、`Home`、`End`，`Tab`/`Shift+Tab` 按触发器所在页面顺序离开；`Escape` 关闭并把焦点还给触发器，外点关闭但保留外部目标取得的焦点。只有真实滚动导致触发器几何位置变化或视口缩放时才关闭；同位置的延迟 scroll 事件不会让菜单自闭合。不可用分支项保持可聚焦并通过 `aria-disabled` 暴露准确原因，分支提交期间菜单关闭且稳定触发器禁用
- 支持标题与消息内容搜索、键盘快速选择、置顶、归档/恢复、重命名和删除会话
- 支持 `⌘/Ctrl+Shift+O` 新建研究、`Shift+Esc` 聚焦研究输入框、`⌘/Ctrl+K` 搜索对话和 `⌘/Ctrl+/` 查看真实快捷键契约；输入法组合、按键长按和打开模态框时不会误触发工作区动作
- 支持把当前选中分支发布为只读分享快照；链接不会自动同步后续消息，可显式更新或撤销
- 会话侧栏按 cursor 自动加载更早记录；加载失败保留已有列表并可原地重试
- 新对话和每个已有会话分别保存文本草稿；已上传未发送的附件也按用户和草稿作用域持久，刷新或切换会话后经服务器 staged 状态校验再恢复
- 设置界面支持浅色、深色、跟随系统，以及桌面侧边栏展开/收起；这些界面偏好只保存在当前浏览器，“数据控制”可集中管理账户共享链接、归档所有对话和删除所有对话
- “设置 → 个性化 → 自定义指令”提供账户级 v1 设置；启用后只由以后新建的会话原子捕获当时的原始内容和修订号，修改设置不会改写已有会话
- 可跨会话持续执行的后台 Agent Run
- 输入框提供“标准研究”和“Pro 深度研究”两档执行模式；模式按会话分别记忆，新 Run 在提交事务中固化模型、推理、工具与计费配置，之后的部署配置变化不会改写它
- 后台任务中心可分页查看最近终态 Run，按全部、完成、失败、停止、待对账筛选，并打开指定 Run 的完整活动；跨会话详情载入明确区分 loading/failed，失败可原地重试且关闭后恢复到稳定焦点；历史加载错误只按网络错误或精确 API code/status 映射为固定文案，不向界面透传后端或内部异常消息
- 可在设置中显式开启浏览器完成通知；系统通知跨标签页去重，站内完成提示始终保留
- 同一会话运行中可继续发送消息，并按顺序进入持久化等待队列
- 失败或取消后以新 attempt 重试，不覆盖旧记录
- 每条 Run 消息内可展开最近 4 项分析摘要、网页搜索和本地工具活动，并可继续打开保留完整记录的活动面板；只展示供应商明确返回的 reasoning summary，不展示隐藏思维链
- OpenAI Agents SDK 单 Agent 运行循环
- Responses API 托管 Web Search
- 默认关闭的 Code Interpreter 初始链路：启用后通过 Agents SDK hosted tool 请求执行输出，严格持久化和回放 Python 阶段、代码、日志与生成图像链接，并在消息内活动和完整活动面板中类型化展示；独立 session 积分计价和 container 生成文件的 owner-bound 转存尚未完成
- 会话与 Agent 完整历史持久化
- 公司、联系人和证据的结构化研究快照
- 跨会话只读资料库，分别浏览所有可达研究和已 finalized 的 CSV/PDF 文件
- 对话触发 CSV/PDF 生成和鉴权下载；既支持研究快照导出，也支持把当前会话中已明确的表格/文字直接制成文件；CSV 使用严格的只读表格预览，单元格只作为 inert text 呈现
- 支持把 UTF-8 TXT/CSV/Markdown/JSON、PDF、DOCX/XLSX/PPTX，以及 PNG/JPEG/WebP/单帧 GIF 作为用户消息附件；CSV 复用严格表格预览，TXT、Markdown 和 JSON 可在带焦点管理的源码预览模态框中查看，JSON 源码会格式化展示；历史 XLSX 可在只读表格预览中切换可见工作表，显示共享/内联字符串、数字、布尔值和公式缓存值，但绝不执行公式、宏或外部关系
- 生成文件、输入图片和输入文本预览统一使用可叠层的模态焦点协议：只有顶层响应 `Escape` 和键盘循环，背景变为 `inert`，关闭后焦点返回触发器；搜索/归档、分享、完整活动和资料库详情补齐稳定的 dialog/listbox 关联、准确的 `aria-expanded`/`aria-controls` 以及进入详情和返回列表时的焦点恢复
- 原子积分预扣、按 usage 结算、幂等运行记录
- 只读账户用量 API，分别返回可用、预留、冻结积分以及逐 Run 的计费与 token/搜索用量
- 固定且严格解析的 API 与 SSE 事件契约；API 错误 envelope 拒绝未知字段和未知错误码，客户端在展示前穷举校验 `code/status` 组合并丢弃服务端 message，契约漂移直接作为不变量错误暴露，不实现后端响应兜底
- 无浏览器的类型检查、单元测试和构建验证，以及隔离数据库、禁止供应商请求的正式 Playwright E2E 回归；自动 fixture 监听初始页和 popup 的 `console.error` 与未捕获 `pageerror`，任一运行时错误都会让对应 E2E 失败
- 默认关闭 Agents SDK tracing，避免自定义供应商场景产生额外数据出站

公开分享只保存消息、引用和文件元数据，不包含输入附件或生成文件的私有 ID、下载地址与文件内容。撤销链接或删除原对话后，公开页面立即不可访问。

“设置 → 数据控制 → 共享链接”通过严格的 `GET /api/conversation-shares` keyset 接口集中列出当前用户仍有效的分享；已归档会话包含在内，软删除会话不包含。撤销请求必须同时携带列表返回的 `conversationId` 和 `publicId`，只会删除用户确认的具体链接；软删除原对话也会在同一数据库事务内清理对应 share 行。

账户级批量对话操作复用 `/api/conversations`：归档使用严格的 `PATCH` body `{ action: "archive_all" }`，删除使用无 body 的 `DELETE`；成功响应固定为 `{ mutation: { action, conversationCount, completedAt } }`。归档只处理当前用户尚未归档且未删除的对话，删除则软删除当前用户全部未删除对话（包括已归档项）。任一目标对话仍有 `waiting`、`queued` 或 `running` Run 时，整笔操作固定返回 `409 ACTIVE_RUN`，不会部分归档或部分删除；空集合成功返回 `conversationCount: 0`。

删除所有对话会在软删除事务中撤销这些对话的全部分享链接，并让已绑定输入附件随原对话一起变为不可读取；它不会删除已绑定附件的数据库行或物理文件，也不会创建附件删除 tombstone，因此不等同于账户数据物理擦除。前端会清理 conversation 作用域的文本、执行模式和未发送附件草稿，并保留独立的“新对话”草稿；归档所有不会清理这些草稿、分享或已绑定附件。

自定义指令不是浏览器本地设置：账户内容和每个新会话捕获的不可变快照以明文保存在 PostgreSQL，真实 Agent 执行时会把该会话快照作为低优先级、不可信的用户偏好发送给配置的模型供应商。它不会进入 Bootstrap、普通会话详情、Run 活动/SSE、分享管理或公开分享快照，也不会在 UI 活动中展示；这项边界不等于静态加密，也不表示数据库运维人员或模型供应商不可见。禁用设置会保留账户内容供以后重新启用，但禁用期间新建的会话固定保存 `NULL + 0`，历史会话也保持 `NULL + 0`。

## 本地启动

需要 Node.js 24、pnpm 11、Docker，以及一个可用的 Responses API Key。

先准备环境和数据库：

```bash
cp .env.example .env
docker compose up -d db
pnpm db:migrate
```

全新数据库可直接执行上述命令。已有数据库升级到当前 schema 时必须安排同一个停写维护窗口：先停止 Web/API、Agent Worker 和附件回收 Worker，确认旧版本进程已经退出并完成数据库备份，再执行 `pnpm db:migrate`，部署当前版本后统一重启。`009` 增加了旧版本不会写入的必填 Turn 字段和 `waiting` 状态，`010` 强化 retry 前序完整性，`011` 严格修复旧 Run 的输入/助手消息关联并校验完整时间线，`012` 允许不依赖研究快照的会话生成文件，`016` 引入不可变会话分支和共享附件关系，`017` 扩展并严格约束输入附件 MIME 与 file/image kind，`018` 为后台会话追踪增加候选发现索引，`021` 为资料库的研究与文件 keyset 分页增加 owner/时间/ID 索引，`024` 为后台终态 Run 的 `finishedAt + runId` keyset 历史增加 owner/终态 partial 索引，`025` 为设置中的共享链接管理增加 `updatedAt + conversationId` keyset 索引，`026` 把三类 Code Interpreter 活动加入数据库固定 Run event 类型约束并继续拒绝未知类型，`027` 为每个 Run 建立不可变的模型、推理、工具和计费快照，`028` 再把是否发送 `reasoning.mode` 固化为显式供应商能力，`029` 增加账户自定义指令与会话级不可变快照并把所有历史会话回填为 `NULL + 0`；旧应用不能与新 schema 滚动混跑。`018`、`021`、`024` 和 `025` 都使用普通 `CREATE INDEX`，因此也必须在上述停写窗口内执行。若旧 Run 的时间窗内没有唯一用户消息、候选已属于其他 Run，或已完成 Run 仍有可能恢复的回答证据，`011` 会回滚并要求人工处理，不会猜测或覆盖历史数据。`027` 会拒绝配置无法恢复的未完成旧 Run；`028` 把已有 v1 快照严格回填为“发送 mode”，新建 v2 快照则保存当前能力开关，不从部署环境推断历史行为。`029` 不从历史记录猜测偏好；升级后只有当前版本创建的新会话才会捕获当时的账户设置。

在 `.env` 中设置 `OPENAI_API_KEY` 后，需要同时启动四个长期运行的进程。

终端 1 启动 Next.js 页面和 API：

```bash
pnpm dev
```

终端 2 启动独立 Agent Worker：

```bash
pnpm worker:dev
```

终端 3 启动输入附件回收 Worker：

```bash
pnpm attachments:worker
```

终端 4 启动独立 Run Reaper：

```bash
pnpm runs:reaper
```

附件回收 Worker 会删除已过期的未发送附件，并重试此前未能完成的物理文件删除。逻辑删除和文件删除通过 PostgreSQL outbox 衔接，因此文件系统暂时失败不会让删除接口变成不可重试的 500/404 状态。Worker 还会严格识别本项目的小写 UUID 正式文件和 `.<附件UUID>.<随机UUID>.tmp` 临时文件：临时文件只有超过 stale 安全龄才会回收；正式文件只有超过独立 orphan 安全龄，并且 PostgreSQL 同时确认附件表和删除 tombstone 都不存在该路径时才会删除。其他名字、目录和符号链接不会被目录对账处理。

Run Reaper 启动后会立即处理一批缺失持久输入或租约已废弃的 Run，之后按 `RUN_RECOVERY_INTERVAL_MS` 周期扫描，每轮最多处理 `RUN_RECOVERY_BATCH_SIZE` 项。它只复用既有的原子恢复和积分冻结/退回规则，不执行 queued Run，也不调用模型供应商。Agent Worker 仍保留同一恢复检查作为兼容保护；两者通过行锁和 `SKIP LOCKED` 安全并发。

`pnpm dev` 不会代替 Agent Worker 执行 Run，也不会代替 Run Reaper 做独立恢复。若只启动 Next.js，聊天请求可以成功进入 `queued`，但会一直等待 Agent Worker。`worker:dev` 适合本地开发；不需要监听代码变化时使用 `pnpm worker`。

首次迁移会创建一个带初始积分的演示用户；首版尚未接入真实登录系统。

如果本机的 `5432` 端口已被占用，把 `.env` 中的 `CUSTENT_DB_PORT` 和 `DATABASE_URL` 端口一起改成其他值（例如 `55432`），再启动数据库。

如果 PDF 需要完整的中文字体，可在 `PDF_FONT_PATH` 中配置一个 PDFKit 支持的字体文件绝对路径。项目也包含 Noto Sans SC 字体资源供默认配置使用。

### 运行与会话切换

- 提交消息后，Next.js 只负责原子预扣积分、保存输入并创建后台 Run，然后立即返回 `202`。
- Worker 从 PostgreSQL 领取 Run 并独立执行。切换到另一个会话不会停止原会话的 Run。
- SSE 连接只负责查看持久化活动，并且只为当前可见会话保留一条 `foreground_follow`；后台 Run 由工作区唯一的轻量 Bootstrap 观察循环统一发现状态和终态，不为每个 Run 下载完整事件。中间活动留在持久存储，切回后从界面已提交的 `Last-Event-ID` 有限补播；硬刷新已完成会话时，当前选中终态 Run 也会自动回放一次。关闭页面、切换会话、网络闪断或 SSE 断开都不会取消 Run。
- 助手消息中的 Run 卡片在 `queued`/`running` 时默认展开、终态时默认折叠，可直接查看最近 4 项分析摘要、网页搜索和本地工具活动；“查看完整活动”打开该 Run 的完整持久活动面板。界面只呈现供应商明确提供的 reasoning summary，不声称展示模型隐藏思维链。
- `⌘/Ctrl+Shift+O` 与现有“新建研究”按钮复用同一前端动作，不会提前创建后端会话；原会话与新研究草稿仍按各自作用域保存。`Shift+Esc` 复用输入框焦点协议，只在当前输入框可用且没有模态框时聚焦，并把光标放到草稿末尾而不滚动页面。
- 同一会话已有 `queued` 或 `running` Run 时，输入框仍可继续发送；后续消息和积分预扣会立即持久化，其 Run 以 `waiting` 状态按 Turn 顺序排队。
- `waiting` Run 不会被 Worker 领取，也没有租约或运行活动；前端不会为它建立 SSE 订阅。前序 Run 成功时，只把它的直接后继在同一事务中提升为 `queued`，更后面的 Turn 仍继续等待。
- 前序 Run 失败、取消或进入待对账时，已经排在后面的 `waiting` Run 不会自动启动，并显示为队列已暂停。用户可以取消等待项；取消会幂等地释放该 Run 的预扣积分。
- 最新的 `failed` 或 `cancelled` attempt 可以重试；待对账 Run 不能重试。重试会复用原用户输入，新建同一 Turn 的下一次 attempt 和新的助手消息，并把仍在等待的直接后继改接到新 attempt。
- 尚未开始执行就失败或取消的 attempt 可能还没有 `pre` Session 快照。重试只会在 `model_started_at`、开始时间、attempt count 和既有 `pre` 快照都能证明该 Run 从未执行时恢复上下文：首 Turn 使用不可变的会话 context seed（普通新会话严格为 `[]`），后续 Turn 使用已完成直接前序的不可变 `post` 快照。前序仍未完成时，新 attempt 保持 `waiting`，由 Worker 在它被合法提升后再物化上下文；缺少所需 `post` 或已有模型调用痕迹时固定拒绝，不猜测历史。
- 重试不会修改旧 attempt、旧事件或旧积分账本；新 attempt 有独立的 Run、活动、预扣和结算记录。只有新 attempt 成功后，它的直接后继才会继续执行。
- 只有界面里明确的“停止生成”或“取消等待”操作会调用取消接口。已开始调用模型的 Run 若无法确定实际成本，相关预扣积分会进入待对账状态。
- 已发出的停止请求会持久化在 Run 契约中；页面刷新或其他标签页重新载入后仍会显示“正在停止”，直到 Worker 写入终态。
- 停止结束后可在同一对话发送“继续”或新的要求。新消息创建新 Turn，不恢复旧模型请求，也不重试旧工具调用；系统以原 `pre` 快照、原用户输入及附件引用、已持久化的可见文本和文件记录构造不可变的续聊 `post` 快照。旧 Run 的费用待确认状态及账本保持不变，不再被误报为“对话分支已更新”。已有等待队列仍需先取消等待项，不会因费用确认而自动执行。
- `030_interrupted_run_continuation.sql` 放宽终态续聊快照和前序约束：只有 `cancelled` 或 `reconciliation_required` 且有不可变 `post` 快照的前序，才能承接可执行的新 Turn。升级需沿用停写、备份、迁移、统一重启流程；不要与旧版 Worker 混跑。
- 当前积分按配置的输入 token、输出 token 和 Web Search 次数计算，不是供应商美元账单换算。费用未知时保留预扣，不伪造实扣或退款；用户无需执行“对账”。按真实美元费用结算仍需供应商费用凭据、美元兑积分比例和后台结算流程。
- Bootstrap 只返回会话侧栏首屏和严格的下一页 cursor；另行返回所有存在活动 Run、等待队列或未读终态的会话摘要，所以大量历史记录不会扩大首屏列表，同时后台观察不会漏掉分页之外的运行。
- “任务”入口即使没有未读项也可打开。它通过严格的 `GET /api/runs/history?status=<filter>&cursor=<opaque>&limit=<1..50>` 分页读取当前用户、未删除会话中的终态 Run；默认每页 `20` 项，按 `finishedAt DESC, runId DESC` 排序，cursor 与当前筛选绑定。上方正在处理/未读 attention 与下方历史按 Run ID 去重；若整页都已显示在上方，前端会继续读取下一页而不会制造假空态。点击历史项会打开该 Run 的持久活动，任务面板打开期间也会随 Bootstrap 重校验刷新。网络失败、`400 INVALID_REQUEST` 和 `500 INTERNAL_ERROR` 分别映射为固定安全文案；服务端 message 永不进入展示。未知 API code、额外响应字段或 code/status 不匹配会让严格解析或断言抛出契约违规，而不是被猜成某个后端错误；外层界面即使显示固定的意外失败文案，也不会读取或解释违规响应中的字段。
- 浏览器系统通知默认关闭，只能在设置中显式开启，首次开启时才请求权限。多个同源标签页使用 Web Locks 和本地 ledger 对同一 Run 去重；启用状态下只有系统通知成功构造后才提交已送达记录。页面初次载入时已有的未读结果只作为通知基线，不会在之后聚焦时补发成“新完成”；用户手动关闭的站内 toast 在本页面生命周期内也不会复活。浏览器不支持所需 API、阻止权限或本地存储不可用时，设置界面会明确显示不可用/被阻止状态；这些情况不影响站内完成 toast。

### 资料库

资料库 v1 是已有研究快照和生成文件的只读跨会话视图，不会复制业务数据，也不维护单独的“收藏/资料库成员”关系。

前端使用 `/library/research` 和 `/library/artifacts` 作为两个列表的 canonical URL，因此刷新、分享链接以及浏览器 Back/Forward 都会恢复精确 Tab；`/library` 继续作为研究列表的兼容入口，快照详情沿用 `/library/research/:snapshotId`。

| 方法 | 固定路由 | 用途 |
|---|---|---|
| `GET` | `/api/library/research?cursor=<opaque>&limit=<1..50>` | 独立分页读取研究；`limit` 默认 `24` |
| `GET` | `/api/library/artifacts?cursor=<opaque>&limit=<1..50>` | 独立分页读取文件；`limit` 默认 `24` |
| `GET` | `/api/library/research/:snapshotId` | 读取一份研究及其公司、联系人和证据 |

两个列表按 `createdAt DESC, id DESC` 使用彼此独立、绑定列表类型的 opaque keyset cursor；当前没有 `query` 搜索参数。固定可见性语义如下：

- 研究必须属于当前用户、原会话未软删除、来源 Run 已 `completed`，并且 `run.assistant_message_id` 指向同 Run、同会话的真实 assistant message。
- 文件必须属于当前用户和未软删除会话，来源 Run 已 `completed`，且 `artifact.message_id` 与该 Run 的最终 assistant message 完全一致。非空 `researchSnapshotId` 还必须指向同一用户、同一会话的真实研究快照，但可以来自该会话更早的 Run。
- 资料库读取所有满足上述条件的合法 completed 分支，不只读取当前 `selected_run_id`，也不按标题、文件名或内容去重。
- 已归档会话仍然可见；软删除会话不可见。用户上传的 input attachments 不属于生成文件，哪怕上传的是 CSV 或 PDF 也不会进入文件列表。
- v1 没有 Library `POST`、`PATCH` 或 `DELETE` 接口。研究详情只读；文件卡片复用聊天中的 CSV/PDF 预览器以及既有 `/api/artifacts/:artifactId/download` owner 鉴权下载路由，不另建预览、导出或下载协议。CSV 下载内容由前端严格解析为带表头的等宽表格，支持引用单元格、转义双引号和引用内换行；空文件、空表头、无效或未闭合引号、以及数据行列数不一致都会进入固定的 `invalid_csv` 状态。该状态不可重试但始终保留原文件下载；网络或下载失败才提供重新载入。所有表头和单元格只作为文本呈现，不赋予 HTML、链接或公式执行语义。

### 积分与用量 API

侧栏的积分余额按钮会打开“积分与用量”界面；前端严格调用只读接口 `GET /api/account/usage?cursor=<opaque>&limit=<1..50>`，首屏和后续分页的 `limit` 都是 `30`。响应固定包含三类独立余额 `available`、`reserved`、`frozen`，以及按 `runs.created_at DESC, runs.id DESC` keyset 分页的 Run 明细。

每个 Run 恰好返回一项，包括会话 ID/标题、七种真实 Run 状态、预扣积分、实际扣除积分、输入/输出 token、Web Search 次数、创建与结束时间。未完成或无法确定成本的字段按固定契约返回 `null`；接口不把同一 Run 的 `reserve`、`settle`、`release` 或 `freeze` 账本项展开成多条消费，因此不会重复计数。查询只读取当前用户拥有的 Run，并再次联查 conversation owner；会话软删除后账务明细和原标题仍保留。

### 生产方式

单台服务器的 GitHub Actions / GHCR / Docker Compose 受限测试部署见 [部署文档](docs/deployment.md)。该方案保留独立 Worker、停写备份与迁移流程，不开放未经认证的公网访问。

先完成一次构建：

```bash
pnpm build
```

然后把 Web/API、Agent Worker、Run Reaper 和附件回收 Worker 作为四个独立的长期进程运行，并连接同一个 PostgreSQL。

进程 1：

```bash
pnpm start
```

进程 2：

```bash
pnpm worker
```

进程 3：

```bash
pnpm attachments:worker
```

进程 4：

```bash
pnpm runs:reaper
```

四个进程需要由不同终端或进程管理器分别托管。当前 MVP 的文件产物保存在 `ARTIFACT_DIR`；如果 Web/API 与 Agent Worker 不在同一台机器，需要改为共享存储或对象存储。

## 常用命令

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e
pnpm build
pnpm worker
pnpm worker:dev
pnpm runs:reaper
```

`pnpm check` 仍只执行无浏览器的 lint、类型检查和 Vitest。`pnpm e2e` 是独立的正式 Playwright 流程：它要求本机 PostgreSQL，创建并迁移一次性数据库，完成隔离的 production build，启动临时 Next.js production server，再串行运行 11 条 Chromium 场景。自动 fixture 对 browser context 已存在和后续创建的每个 Page（包括 popup）监听 `console.error` 与未捕获 `pageerror`；错误记录包含页面 URL，并在可用时包含 console 源位置或异常 stack，测试 teardown 统一断言记录必须为空。当前固定总量仍是 16 个 Run（12 个完成、2 个取消、1 个失败、1 个待对账，最终没有未完成 Run；唯一的 `model_started_at` 由夹具直接标记以验证待对账 UI）：覆盖桌面布局、全局新建/聚焦快捷键及分作用域草稿、8 个跨会话后台 Run 的统一观察与完成通知、后台零事件流、前台单事件流、有限活动回放、数据库夹具驱动的 Python 代码/日志活动卡片、同一条消息中的 TXT 源码预览与双工作表 XLSX 历史只读预览/切换/下载、`390×844` 下的侧栏/活动/源码预览/任务中心模态框与焦点/溢出、移动侧栏内设置和积分窗口的顶层 inert/焦点环/逐层关闭与焦点恢复、两个新会话分别冻结两版自定义指令且私密 marker 不进入普通 API/SSE/持久 Run 活动/分享快照，以及同会话 waiting 链在取消、重试、失败、直接后继提升和待对账后的持久版本与活动可见性。跨会话场景还在同一条已完成助手回答上验证 More 菜单的首项焦点、`Escape` 返回焦点和外点关闭语义，再通过真实 `POST /api/conversations/:conversationId/branches` 校验严格请求/响应、无 Run 的新会话摘要、复制回答、路由切换和 composer 焦点。新增覆盖还包括：用正式仓储在既有 Run 中生成并最终绑定 1 份合法研究快照和 1 个 CSV，验证资料库 canonical 路由、研究详情、CSV 严格表格预览与下载；验证分享创建、同 public ID 更新、撤销、公开页和撤销后 404；验证账户固定余额、cursor 分页以及界面中的 16 条唯一 Run 用量记录；在最后一条无新增 Run 的场景中先归档再删除账户全部对话，验证严格请求/响应、精确分页计数、active/archived 界面与 API、嵌套确认层、分享失效，以及 conversation 作用域本地草稿清理而“新对话”草稿保留。真实分支会新增一个独立对话但不创建 Run；这些场景因此不改变固定 16-Run 总量，本地供应商 tripwire 最终必须保持 0 次请求。

需要人工或外部浏览器复核 production 页面时，可设置 `CUSTENT_E2E_INSPECT_MS=<毫秒>`。它只接受 `0..600000` 内的 canonical 十进制整数；在 Playwright 断言和 16-Run 数据库校验通过后，隔离服务器会按指定时长继续监听并在日志中打印 URL，最长 10 分钟。保留期只用于只读视觉检查，不应提交消息或改写隔离数据。供应商 tripwire 在保留期继续计数，并在清理阶段最终要求恰好 0 次请求；随后同一流程停止服务并删除一次性数据库、构建目录、附件和产物目录。该选项不会启动 Agent Worker 或 Run Reaper。

这套 E2E 明确是 provider-free 的数据库驱动 UI replay：测试夹具直接领取 Run、断言 claim 取得正确的会话自定义指令快照、写入确定性持久活动并完成 Run，供应商 tripwire 必须保持零请求。它验证 Web/API、数据库契约和浏览器界面的组合行为，但不会启动真实 Agent Worker 或 Run Reaper，也不证明 Agents SDK、模型供应商、真实 Web Search 或自定义指令实际影响模型回答的运行循环；真实供应商能力仍只能通过单独、显式且会产生用量的契约检查验证。

## 核心环境变量

| 变量 | 含义 |
|---|---|
| `CUSTENT_DB_PORT` | Docker PostgreSQL 暴露到本机的端口 |
| `DATABASE_URL` | PostgreSQL 连接串 |
| `OPENAI_API_KEY` | 后端正式 API Key |
| `OPENAI_PROVIDER` | `openai` 或带严格流式适配的 `sharesub` |
| `OPENAI_BASE_URL` | Responses-compatible 服务地址，默认 OpenAI |
| `OPENAI_MODEL` | 明确使用的模型名 |
| `OPENAI_REASONING_MODE_ENABLED` | 供应商是否接受 `reasoning.mode`；能力会固化到每个新 Run，默认 `false` |
| `OPENAI_CODE_INTERPRETER_ENABLED` | 是否向模型注册 Code Interpreter hosted tool 并加入对应指令，默认 `false` |
| `RUN_RESERVATION_CREDITS` | 每次运行预扣的产品积分 |
| `RUN_WORKER_CONCURRENCY` | 单个 Worker 同时执行的 Run 数，默认 `2` |
| `RUN_WORKER_POLL_MS` | Worker 空闲时轮询队列的间隔，默认 `250ms` |
| `RUN_LEASE_MS` | Worker 持有 Run 的租约时长，默认 `30000ms`，最小 `10000ms` |
| `RUN_RECOVERY_INTERVAL_MS` | Run Reaper 两轮恢复扫描之间的间隔，默认 `5000ms`，最小 `1000ms` |
| `RUN_RECOVERY_BATCH_SIZE` | Run Reaper 单轮最多处理的 Run 数，默认 `100`，范围 `1..1000` |
| `RUN_EVENT_POLL_MS` | SSE 中继查询持久事件的间隔，默认 `250ms` |
| `CREDITS_PER_1K_INPUT_TOKENS` | 每千输入 token 的产品积分 |
| `CREDITS_PER_1K_OUTPUT_TOKENS` | 每千输出 token 的产品积分 |
| `CREDITS_PER_WEB_SEARCH` | 每次 Web Search 的产品积分 |
| `ARTIFACT_DIR` | CSV/PDF 的本地保存目录 |
| `INPUT_ATTACHMENT_DIR` | 用户输入附件的本地保存目录，默认 `.data/input-attachments` |
| `INPUT_ATTACHMENT_MAX_BYTES` | 单个输入附件字节上限，默认 `10485760`（10 MiB） |
| `INPUT_ATTACHMENT_MAX_PER_MESSAGE` | 单条消息附件数上限，默认且最高为 `5` |
| `INPUT_ATTACHMENT_MAX_TOTAL_BYTES` | 单条消息所有附件总字节上限，默认 `20971520`（20 MiB） |
| `INPUT_ATTACHMENT_STAGED_TTL_HOURS` | 未发送附件的暂存有效期，默认 `24` 小时 |
| `INPUT_ATTACHMENT_SWEEP_INTERVAL_MS` | 附件回收 Worker 的扫描间隔，默认 `60000ms` |
| `INPUT_ATTACHMENT_DELETE_RETRY_MS` | 物理删除失败后的重试间隔，默认 `30000ms` |
| `INPUT_ATTACHMENT_SWEEP_BATCH_SIZE` | 单轮最多回收的附件数，默认 `100` |
| `INPUT_ATTACHMENT_ORPHAN_MIN_AGE_MS` | 正式 UUID 文件进入孤儿对账前的独立安全龄，最小 `300000ms`，默认 `3600000ms` |
| `INPUT_ATTACHMENT_TEMP_STALE_AGE_MS` | 本项目格式临时文件判定为 stale 的安全龄，最小 `300000ms`，默认 `3600000ms` |

这些积分参数是平台自己的计价策略，不是 OpenAI 官方价格。正式上线前需要根据实际供应商账单重新配置。

`OPENAI_CODE_INTERPRETER_ENABLED=false` 时，Worker 不会向供应商发送 Code Interpreter 工具定义，Agent 指令也不会要求使用 Python。改成 `true` 只会启用当前的初始事件与 UI 链路，不代表生产契约已经完成：本次实现没有执行会产生真实用量的供应商能力 probe；积分预扣与结算还没有 Code Interpreter session 的独立产品计价；container 生成文件也没有复制进现有 owner-bound artifact storage。项目不猜测 session 价格，在这三项完成前应保持默认关闭。

默认租约为 30 秒。Agent Worker 会以 `min(1 秒, 租约时长 / 3)` 的间隔续租并检查取消请求，因此默认大约每秒检查一次。Run Reaper 默认每 5 秒独立扫描最多 100 个废弃 Run，因此即使没有兼容的 Agent Worker 正在轮询，已过期租约也能进入既有恢复或对账流程；Reaper 不会把能力不匹配的 queued Run 擅自改为其他配置。`RUN_WORKER_CONCURRENCY=2` 只表示单个 Agent Worker 进程最多同时处理两个 Run；同一会话仍只允许一个活动 Run。

## ShareSub 配置

ShareSub 使用 Responses wire API，但它的流式终止事件固定不重复携带完整 `output`；完整 item 位于 `response.output_item.done`。项目只在显式配置 `OPENAI_PROVIDER=sharesub` 时启用严格的事件重组，不会自动猜测供应商或静默兼容其他返回结构。

```dotenv
OPENAI_PROVIDER=sharesub
OPENAI_BASE_URL=https://share.underelay.com
OPENAI_MODEL=gpt-5.6-sol
OPENAI_REASONING_MODE_ENABLED=false
OPENAI_CODE_INTERPRETER_ENABLED=false
```

当前配置模型会返回 reasoning summary，但明确拒绝 `reasoning.mode`，因此能力开关保持 `false`。标准/Pro 仍分别固化各自的 reasoning effort 与最大 Agent 轮数；Runtime 只在 Run 快照声明能力为 `true` 时发送 `mode`，不会先发出不兼容请求再删字段重试。Worker 也只领取与自身供应商、Base URL、reasoning mode 和工具能力完全兼容的 Run。

填好本地 `.env` 的 Key 后，可运行一次真实契约检查：

```bash
pnpm provider:verify
```

该命令会产生一次真实 Web Search 用量，并检查 Responses SSE、搜索调用、URL 引用和 usage；输出不会包含 Key 或模型正文。

其他 OpenAI 工具能力必须逐项验证，不能根据 `/v1/responses` 可用就推断支持。以下命令一次只接受一个 capability，也支持 pnpm 常用的前导 `--`：

```bash
pnpm provider:verify-tools -- code_interpreter
pnpm provider:verify-tools -- code_interpreter_container_lifecycle
pnpm provider:verify-tools -- file_input
pnpm provider:verify-tools -- inline_file_input
pnpm provider:verify-tools -- pdf_input
pnpm provider:verify-tools -- image_input
pnpm provider:verify-tools -- image_generation
```

这些都是会产生真实供应商请求或工具用量的显式检查，不会由测试或应用启动流程自动执行。`code_interpreter_container_lifecycle` 会创建显式 container，逐项检查 container 文件上传、列表、metadata、content，要求 Responses 在同一 container 内读取输入并生成文件，再以 Responses 文件 annotation 的 `file_id` 与执行前后 container 文件列表的新增项做唯一关联，下载校验后在 `finally` 中删除 container；删除严格按 SDK 的 `void` 与原始 HTTP 204 空响应检查，不臆造 JSON 删除结果。`file_input` 会检查 Files API 上传、Responses `file_id` 输入和文件清理；`inline_file_input` 则独立检查 Responses 的 `filename + file_data` 内联文本文件输入，不依赖 Files API；`pdf_input` 使用 `probe.pdf` 和 `data:application/pdf;base64,...` 独立检查内联 PDF 输入，同样不会调用 Files API，也没有文件清理步骤。命令只输出契约统计，不输出 Key、模型正文、生成文件内容或生成图片。

当前实现没有执行上述付费 Code Interpreter probe，因此不能仅凭 Responses endpoint 或本地事件/UI 测试推断 ShareSub 已支持该能力，也不应据此把开关改为 `true`。

## 设计边界

- 公司研究必须实际使用 Web Search，不能只依赖模型记忆。
- 关键公司和联系人事实必须带公开来源。
- 不根据姓名和公司域名猜邮箱。
- 用户要求的数量超过可靠结果时，返回真实数量并说明限制。
- 公司/联系人研究清单的 CSV、PDF 与聊天结果来自同一份结构化研究快照；用户也可以把当前会话中已经明确的其他表格或文字直接生成 CSV/PDF，通用文件不会伪造或绑定研究快照。
- 通用 CSV 限制列数、行数、单元格和总字节，并防护表格公式注入；通用 PDF 限制标题、段落和总字节。下载文件名拒绝路径、控制字符、双向文本控制符和平台保留名。
- 输入附件严格匹配 MIME、大小写不敏感的固定扩展名与文件结构：浏览器仅在 MIME 为空或为 `application/octet-stream` 时按扩展名映射；文本必须是无 NUL 的有效 UTF-8，JSON 还必须语法有效；图片核验真实格式并完整解码，GIF 只接受单帧；DOCX/XLSX/PPTX 会校验全部 ZIP 条目的展开预算、路径、CRC 和必要 OOXML 命名空间标记。旧版二进制 DOC/XLS/PPT、TSV、SVG 和动画 GIF 当前不在固定契约内。
- 运行失败且实际成本无法确定时，预扣积分保持冻结，等待对账。
- 同一会话同一时间只允许一个 `queued` 或 `running` Agent Run；运行中继续发送的消息以 `waiting` 顺序串联，避免会话历史产生并发分叉。不同会话可以并行。
- 自定义指令最多 4000 字符；启用时去除首尾空白后必须非空。更新使用 `expectedRevision` 乐观并发，旧 revision 返回固定 `409 CUSTOM_INSTRUCTIONS_REVISION_CONFLICT`，不会覆盖其他页面已保存的版本。它只影响以后新建的会话，不是跨会话自动学习的 Memory。
- `OPENAI_BASE_URL` 兼容性必须通过契约测试确认；项目不会为不符合 Responses 协议的返回添加字段兜底。

## 参考

- [OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents)
- [Agents SDK Quickstart](https://developers.openai.com/api/docs/guides/agents/quickstart)
- [Web Search 与引用](https://developers.openai.com/api/docs/guides/tools-web-search)

更详细的数据流见 [docs/architecture.md](docs/architecture.md)。
ChatGPT 网页版功能对齐的已验证基线与剩余清单见
[docs/chatgpt-parity.md](docs/chatgpt-parity.md)。
