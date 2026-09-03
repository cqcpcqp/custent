# Project instructions

- 永远不要尝试打开浏览器进行测试。DO NOT TRY TO OPEN A BROWSER.
- 后端接口返回字段和字段类型是固定契约；不要为后端接口返回实现兜底。
- 不猜接口，先查询真实文档或现有契约。
- 不臆想业务；会改变产品行为的关键决策需要向用户确认。
- 主动运行非浏览器测试，遵循现有架构并谨慎重构。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
