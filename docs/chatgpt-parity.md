# ChatGPT Web parity baseline

This document tracks the product goal of matching the ChatGPT web experience
for the foreign-trade Agent. Voice is explicitly out of scope. The verified
core below is evidence of completed slices, not a narrower definition of the
overall goal.
It must not be read as a claim that overall ChatGPT web parity is complete.
An item is complete only when its fixed backend contract, frontend behavior,
non-browser tests, and browser regression are all verified.

## Verified core workflow

| Area | Current evidence |
|---|---|
| Durable conversations | Chat submission only enqueues a persisted Run; the independent Agent Worker owns execution. Switching conversations, closing an SSE connection, or reloading the page does not cancel the Run. A separately supervised Run Reaper immediately and periodically applies the existing fenced recovery rules to malformed queued or abandoned running Runs without contacting the provider; the Agent Worker retains the same recovery check as compatibility protection. Only the visible conversation owns a follow SSE; one lightweight Bootstrap loop observes all background Runs without downloading their event histories. |
| Cross-conversation work | Different conversations can run concurrently. Later turns in one conversation form a persisted `waiting` chain. Cancelling an unstarted queued/waiting attempt no longer creates a dead retry button: a new attempt either runs from a strictly reconstructed immutable pre-context or remains waiting behind its unfinished predecessor, and parent retries safely rewire only descendants proven never to have started. |
| Execution modes | Standard research and Pro deep research resolve to complete immutable per-Run snapshots of provider, Base URL, model, reasoning settings, tools, maximum turns, and billing. Retry/regenerate copy the source snapshot exactly. Provider support for `reasoning.mode` is explicit in snapshot v2 and Worker capability matching; there is no error-triggered fallback retry. |
| Activity | Persisted provider-supplied reasoning summaries, Web Search actions, Code Interpreter status/code/results, local tool calls, attachments, artifacts, and terminal events can be replayed through `Last-Event-ID`; hidden chain-of-thought is not exposed. Each Run message has an expandable view of its latest four analysis/search/tool items, while “查看完整活动” opens the full persisted activity panel. The current Run activity panel and the cross-conversation background-task center remain separate controls. Opening another conversation's activity has explicit loading/failed/retry detail states and stable focus recovery rather than rendering a false empty history. |
| Code Interpreter foundation | A capability-gated Agents SDK hosted tool requests outputs only when `OPENAI_CODE_INTERPRETER_ENABLED=true`. Strict runtime mapping, durable Run events, SSE replay, and typed inline/full-activity cards cover Python phases, code, logs, and user-opened generated-image links. This is a provider-free initial integration, not a production-readiness claim; the flag defaults to `false`. |
| Background task history | The task center includes durable terminal Run history, filters for completed, failed, cancelled, and reconciliation-required outcomes, cursor pagination, explicit loading/error states, and Run-ID deduplication against unread attention. Selecting an item opens that Run's persisted activity. History failures map only an explicit network error or exact API code/status pairs to fixed user-facing text; unknown errors and backend/internal messages are never rendered verbatim. |
| Strict API errors | `APP_ERROR_CODES` is the single shared error-code enum. The API error envelope rejects unknown codes and extra fields at both object levels, and the client exhaustively maps every legal code to its allowed HTTP statuses and fixed presentation text. A mismatched status or response-shape drift raises an invariant violation instead of being interpreted as another backend error; an outer surface may show only its fixed unexpected-failure copy. The wire `message` is discarded for presentation, and network failures are normalized without changing `AbortError` cancellation semantics. |
| Completion notifications | In-app completion toasts remain available. Browser notifications are an explicit user preference, request permission only from the settings action, coordinate across tabs with Web Locks and a local delivery ledger, and commit a delivered identity only after the system notification is constructed successfully. |
| Custom instructions v1 | The owner-bound settings surface uses a strict GET/PUT envelope and optimistic revision checks. Each newly created conversation atomically freezes the enabled raw content and revision; disabled and historical conversations use `NULL + 0`, and a database trigger prevents later mutation. The Worker claims that conversation snapshot and treats it as untrusted, lower-priority user preference. The snapshot is excluded from normal conversation/bootstrap/activity/share surfaces; it is plaintext server data and is sent to the configured provider during a real Agent run, not a browser-local or provider-private preference. |
| Messages | Copy, feedback, edit-to-branch, retry, regenerate, answer-version navigation, user-message branch navigation, and branch-to-new-conversation are implemented. The completed-assistant branch action now lives in a trailing “更多回答操作” menu while the user-message branch action remains direct. A permanently eligible regenerate action remains visible with an exact disabled reason while an outstanding Run, archive state, or conversation mutation temporarily blocks it; permanent contract failures remain hidden. |
| Files and sources | Strict input attachments, inline citations, source details, CSV/PDF artifacts, previews, downloads, and a cross-conversation library are implemented. CSV artifacts and historical CSV attachments use a strict typed table preview: malformed or empty input becomes the non-retryable `invalid_csv` state while the original download remains available, and all headers/cells render as inert text rather than HTML, links, or formulas. TXT, Markdown, and JSON input attachments open in a source-preview dialog; untrusted text is displayed as source rather than rendered HTML, and JSON is formatted as source. Historical XLSX attachments open in a bounded read-only multi-sheet preview that validates ZIP/OOXML structure, displays cached values as inert text, never executes formulas/macros or follows external relationships, and preserves the original download on invalid-file or unavailable-browser states. Uploaded composer attachments persist per user and draft scope, restore only after owner-bound staged metadata validation, and are removed on expiry, submission, explicit removal, or conversation deletion. |
| Conversation management | Search, cursor pagination, pin, rename, archive/restore, delete, immutable share snapshots, centralized shared-link management, and per-conversation drafts are implemented. Sidebar status signals are limited to active queued/running work, a waiting queue, or unread terminal attention; read historical terminal Runs do not leave permanent completion/failure dots. |
| Account conversation controls | Settings implements account-wide archive-all and delete-all beside centralized shared-link management. The strict collection contract returns the exact action, affected conversation count, and completion time. Any target with a `waiting`, `queued`, or `running` Run atomically rejects the entire operation with `409 ACTIVE_RUN`. Delete-all soft-deletes active and archived conversations and revokes their shares in the same transaction; bound attachments become unreachable but their rows and bytes are not physically erased. Conversation-scoped local drafts are cleared after delete-all while the independent new-conversation draft is retained. This is not account export, account deletion, or a physical-erasure claim. |
| Keyboard workflow | `Command/Control+Shift+O` reuses the existing new-conversation action, `Shift+Escape` reuses the guarded composer-focus protocol, `Command/Control+K` opens conversation search, and `Command/Control+/` opens the truthful shortcut dialog. New-conversation and focus shortcuts reject IME composition, repeats, already-handled events, invalid modifiers, and open modal layers; scoped conversation and new-chat drafts remain independent. The assistant More trigger also supports click and Up/Down opening, first/last focus, Arrow/Home/End navigation, Tab exit anchored to the persistent trigger, Escape return-focus, and outside-pointer close without stealing the outside target's focus. |
| Visual rhythm and responsive shell | The current pass aligns message content, historical/archive/recovery notices, and the composer on a shared `760px` measure; simplifies the header, user bubble, and composer chrome; tightens desktop/mobile turn spacing; and raises the mobile title/message type scale. The base desktop sidebar is now a `264px` high-density flat surface with solid background, compact `36px` rows/actions, neutral hover/focus/active states, and the remaining height reserved for its scrolling conversation list; narrower desktop widths still respond, and mobile targets remain at least `44px`. Artifact, image, and text-preview dialogs now share the stacked `useModalFocus` contract with top-layer-only Escape/Tab handling, inert background content, and return-focus recovery. Search/archive, share, full-activity, and assistant More triggers expose stable relationships and accurate expanded state; Library detail navigation restores the originating card or current tab. The committed Playwright suite additionally exercises a `390×844` conversation sidebar, nested settings and account-usage dialogs, activity dialog, attachment source-preview dialog, and task-center dialog. This verified pass is not an overall visual-parity claim. |

Primary implementation surfaces are `components/research-workspace.tsx`,
`components/message-branch-action.tsx`, `components/conversation-sidebar.tsx`,
`components/run-activity.tsx`, `components/background-run-center.tsx`,
`components/settings-dialog.tsx`, `app/globals.css`,
`e2e/specs/workspace.e2e.ts`, `lib/db/conversations.ts`,
`lib/runs/worker.ts`, `lib/runs/reaper.ts`, and `lib/contracts.ts`.

## Committed browser regression

`pnpm e2e` is the formal Playwright entry point. It creates and migrates a
one-time local PostgreSQL database, makes an isolated production build, starts
a temporary Next.js production server, and runs eleven serial Chromium
scenarios.
An automatic fixture attaches to every existing and newly created context Page,
including popups, and fails the scenario when it observes `console.error` or an
uncaught `pageerror`. Diagnostics retain the page URL and, when available, the
console source location or exception stack; listeners are deduplicated per Page
and removed during teardown.
They cover desktop geometry; the new-conversation/composer-focus keyboard flow
with scoped draft preservation and modal suppression; eight Runs completing
after a conversation switch with zero background event streams, at most one
foreground follow stream, non-overlapping Bootstrap requests, completion
notifications, task-center inspection, and finite activity replay; TXT
upload/source preview plus a persisted two-sheet XLSX preview, sheet switching,
download, and focus recovery; the general mobile modal/accessibility flow; a nested
mobile sidebar → settings/account modal stack with top-only dismissal, focus
trapping and return-focus recovery; and two new conversations freezing two
different custom-instruction revisions while private markers remain absent from
normal APIs, SSE, persisted Run events, share snapshots, and activity UI. That
scenario also verifies share creation, an update that preserves the public ID,
the public snapshot, revocation, and the resulting public 404. Another scenario
uses the formal repositories inside an existing Run lease to save and finalize
exactly one research snapshot and CSV, then verifies canonical Library routes,
research detail, strict CSV preview/download, focus restoration, and mobile
overflow. The background-Run scenario also opens the completed assistant
answer's real More menu, verifies initial item focus, Escape return-focus and
outside-pointer close, then submits the existing strict branch request through
`POST /api/conversations/:conversationId/branches`. It parses the real request
and response, confirms the target is a distinct no-Run conversation containing
the copied answer, navigates to its canonical route, and focuses its composer.
The queue scenario verifies a three-Turn same-conversation queue:
cancelling a waiting Turn, retrying it while its predecessor is active,
promoting only that
retry after the predecessor completes, preserving the cancelled and failed
attempts as separate answer versions, rewiring the direct waiting successor on
each retry, and surfacing a simulated post-model `reconciliation_required`
result in both the task center and full activity panel. The account-usage
scenario verifies fixed balances, cursor pagination, and exactly 16 unique Run
rows in the UI. The final serial data-control scenario creates no Run: it
archives and then deletes every account conversation, verifies exact paginated
counts and strict mutation envelopes, active/archived UI and APIs, nested
confirmation focus/pending behavior, share revocation, and scoped local-draft
cleanup while retaining the new-conversation draft. The real branch action adds
one standalone conversation but no Run; these added scenarios therefore create
no additional Run. The suite has
an exact total of 16 Runs: 12 complete, two cancelled, one failed, one
reconciliation-required, and no outstanding Run. Exactly one Run
has `model_started_at`, set directly by the fixture to exercise reconciliation;
it is not evidence of a provider call. A local provider tripwire is installed
for the whole run and the suite fails unless it observes exactly zero provider
requests.

For bounded read-only visual inspection, `CUSTENT_E2E_INSPECT_MS` accepts only
a canonical decimal integer from `0` through `600000`. A nonzero value keeps the
isolated production server available after the Playwright assertions and exact
16-Run database check. The provider tripwire continues counting during this
window and must still be exactly zero during final cleanup; the inspection
window must not be used to submit messages or mutate the isolated data.

This is intentionally a provider-free, database-driven UI replay. The fixture
claims the queued Run through the repository contract, appends deterministic
persisted reasoning/search/Code Interpreter/tool events, and drives completion,
failure, cancellation, retry, promotion, and reconciliation through repository
contracts against the isolated database. It validates the production Web/API
build,
persistence contracts, SSE replay, typed Python activity UI, custom-instruction
snapshot isolation, and the browser UI working together. It does **not** start
the real Agent Worker or independent Run Reaper and is not evidence
that the Agents SDK, configured model provider,
real Web Search execution loop, or model application of custom instructions
succeeds. Those paths require separately
authorized live-provider verification and must not be inferred from this suite.

## Remaining parity work

### P0 — platform and execution contracts

- Replace the fixed demo identity with real authenticated sessions and strict
  per-user credit, conversation, file, and share ownership.
- Keep Code Interpreter disabled in production until the configured provider
  passes a separately authorized, paid capability probe. The initial hosted-tool,
  event, replay, and activity-card path is implemented, but no paid provider
  probe has been run for this integration. Add an explicit Code Interpreter
  session product-credit rate to reservation/settlement, and copy generated
  container files into owner-bound artifact storage before enabling it.
- Define stopped partial-answer semantics that can be displayed and used as
  later context. Today a post-model cancellation with unknown cost correctly
  enters `reconciliation_required` instead of pretending to be a normal
  ChatGPT-style stopped response.
- Add a provider-response recovery and administrator reconciliation path for
  Worker loss after model start. The independent Run Reaper only applies the
  existing conservative recovery/freeze rules; it does not reconstruct an
  unknown provider response or perform administrator reconciliation.
- Complete the remaining account data controls: export, account deletion, and
  privacy preferences. Centralized shared-link management and account-wide
  archive/delete are implemented.
- Add memory and memory management, richer personalization beyond the current
  conversation-frozen custom-instructions v1, and temporary conversations
  through explicit persistence and privacy contracts.
- Add subscription/recharge/payment and account-security surfaces needed for a
  real multi-user product; the current points view is read-only usage data.

### P1 — user-visible completeness

- Extend the current typed Python code/log/generated-image-link activity cards
  with owner-bound generated files and durable previews. Future hosted-tool
  outputs must also receive fixed contracts and typed renderers; raw JSON
  belongs behind a secondary disclosure.
- Expand negative-feedback reasons and optional text through a fixed backend
  contract.
- Add a separately authorized live Worker/provider smoke path. The committed
  provider-free suite now covers share, Library, account-usage, and bulk
  conversation-data-control flows, but it cannot validate real Worker/provider
  execution.
- Add Canvas or an equivalent editable collaboration surface. A generated
  artifact preview is not an editable Canvas.
- Distinguish scheduled/recurring tasks from the existing Run history center;
  scheduling, timezone, recurrence, pause/edit, and delivery are not present.

### P2 — visual and ecosystem polish

- Continue requirement-by-requirement visual comparison beyond the completed
  `760px` measure, lighter header/bubble/composer chrome, `264px` high-density
  flat desktop sidebar, assistant More menu, mobile type-scale, and focus/ARIA
  pass. Long replies, dense activity timelines, error/empty states, and
  still-unimplemented ChatGPT surfaces require separate evidence; this pass
  does not establish overall visual parity.
- Add richer previews for the remaining supported Office attachments. XLSX now
  has a bounded multi-sheet table preview; DOCX and PPTX still download only.
  TXT, Markdown, and JSON have safe source previews, but Markdown is not a
  rendered document preview.
- Add Projects, connectors, custom Agents, image generation/editing, and
  public-share continuation only with real contracts and provider capability;
  none may be represented by a UI control before that implementation exists.
- Add organization/workspace membership, roles, invitations, shared resources,
  and audit history for the foreign-trade company use case.

## Verification rules

- Backend responses are fixed contracts. Frontend fallback parsing is
  prohibited. Unknown error codes, extra error-envelope fields, and invalid
  code/status pairs must fail the shared contract rather than render a guessed
  fallback.
- Provider capability scripts are probes, not proof that the application has
  integrated the capability.
- Provider incompatibility is modeled before execution. A `400` response must
  never trigger a second request with silently removed reasoning or tool fields.
- The current Code Interpreter integration has not run a paid provider probe;
  its provider-free tests do not justify changing the default-disabled flag.
- Tests that run in Vitest's Node environment do not substitute for browser
  validation.
- The committed browser gate treats every `console.error` and uncaught
  `pageerror` from the exercised initial pages or popups as an E2E failure; a
  clean gate still proves only those exercised scenarios.
- The provider-free Playwright suite proves only the database-driven production
  UI path it exercises; it is not a real Worker or provider execution test.
- The custom-instructions browser scenario proves atomic snapshot versions and
  absence from the enumerated product surfaces. With zero provider requests it
  cannot prove prompt influence, model behavior, or provider-side privacy.
- Browser screenshots and DOM snapshots prove only the state actually
  exercised. A broad parity claim requires requirement-by-requirement evidence.
