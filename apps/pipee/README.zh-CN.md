# Pipee

![Pipee 会话工作区](./docs/screenshot2.png)

[Pi coding agent](https://github.com/badlogic/pi-mono) 的浏览器界面。它直接读取 Pi 已有的 `~/.pi/agent` 状态，并在 Web 进程内运行 `AgentSession`；没有额外数据库或常驻 daemon。

[English](./README.md)

## 功能

- 浏览、重命名、删除、导出、fork 和切换 Pi `.jsonl` 会话分支。
- 通过类型化 SSE 流式显示 prompt、tool call、compact、retry、extension UI 与 bash 输出。
- 运行 Pi 原生 `!command` / `!!command`，支持实时输出与终止。
- 管理模型、OAuth/API key、插件、技能、工具与 thinking level。
- 在服务端 allowed-root 策略内浏览和预览文件。
- 创建和删除 Git worktree，脏 worktree 使用结构化 conflict 流程。
- 使用 session-owned 的 pi-chrome attach/assert/detach 事务。
- 管理 `@yansircc/pi-loop` 的多个会话自动化任务，包括倒计时、暂停、立即执行和 interval 编辑。
- 默认中文，并提供可见的语言、主题、声音、草稿和未读状态偏好。

## 环境要求

- Node.js `>=22.19.0`
- 已安装并正常配置 Pi，状态位于标准 `~/.pi/agent` 目录

安装配套扩展后会显示自动化面板：

```bash
pi install npm:@yansircc/pi-loop
```

## 安装与启动

```bash
pnpm add -g @yansircc/pipee
pipee
```

默认地址为 `http://127.0.0.1:30141`。CLI 会等待 `/api/health` ready 后再打开浏览器。

```bash
pipee -p 30200 -H 0.0.0.0
pipee -h
pipee -v
PORT=30200 HOST=127.0.0.1 pipee
PIPEE_OPEN_BROWSER=0 pipee
```

`--port`/`-p` 与 `--hostname`/`-H` 的优先级高于 `PORT` 和 `PIPEE_HOST`/`HOST`。
通用 `HOSTNAME` 会被刻意忽略，避免容器或 shell 元数据在未授权时扩大监听地址。

pipee 当前没有远程认证边界。监听 `0.0.0.0`、`::` 或其他非 loopback 地址，会向所有能访问该地址的客户端暴露 agent 操作和允许范围内的工作区文件。在认证落地前，只应在可信网络中使用非 loopback 监听，或放在带认证的 SSH 隧道之后。

## 开发

仓库只由 pnpm 11.13.1 与 Vite Plus 0.2.4 管理，不得增加第二份 lockfile 或并行的 Vite/Vitest 配置。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm exec vp dev         # 端口 30141
pnpm exec vp check
pnpm exec vp run ci:typecheck
pnpm exec vp test
pnpm effect:scan
pnpm exec vp build
pnpm test:e2e
pnpm test:package
```

`vp check` 负责格式化与普通 lint；独立的 `ci:typecheck` 任务运行由 `@effect/tsgo` patch 的 TypeScript 7 编译器，Effect 诊断仍属于 compiler gate。`pnpm test:e2e` 会在已忽略的 `test-results/` 下创建隔离 HOME 和 Git fixture，不会修改开发者真实的 Pi 状态。`pnpm test:package` 会执行 build → pack，在空 consumer 中安装 tarball，验证打包后的帮助/版本契约，并检查 CLI health、真实浏览器启动、SSE 与 graceful shutdown。

## 架构

```text
Browser / React
  ├─ TanStack Router search.session（当前会话 SSOT）
  ├─ 纯 SessionUiState reducer
  └─ Effect browser controller + 派生 HttpApiClient
                         │
                         ▼
TanStack Start SPA + 唯一 /api/$ 终端路由
                         │
                         ▼
Effect HttpApi（Schema、错误、中间件、SSE）
  ├─ SessionRepository ─────────────── Pi .jsonl 文件
  ├─ SessionRuntimeRegistry ────────── scoped Pi runtime
  ├─ FileAccessPolicy / WorkspaceIo ─ 文件系统与 worktree
  └─ PiAgentAdapter ───────────────── 唯一 Pi SDK import 边界
```

TanStack Start 只拥有 document shell、文件路由、SPA fallback 与 Nitro 构建。Effect V4 拥有 HTTP、校验、I/O、时间、并发、资源 scope 和浏览器 adapter。React 只拥有渲染与 reducer。

API 唯一事实源是 [`src/api/contract.ts`](./src/api/contract.ts)。同一合约派生服务端 handler 与浏览器 client；不存在兼容路由或泛型 command endpoint。

核心不变量：

- 只读浏览 session 不得创建 `AgentSession`。
- registry 状态严格为 `Starting(Deferred) | Active(Handle)`；并发启动共享一个 `Deferred`。
- 每个 handle 独占 `Scope`、idle fiber、Pi runtime、event PubSub 与 pending extension UI。
- fork 成功后立即关闭旧 handle，因为 Pi 会原地修改内部 session identity。
- 每个 run 使用服务端生成的 opaque `RunId`；旧 SSE 与旧 reconciliation 对 reducer 无效。
- prompt 接受早于浏览器 SSE 连接，因此 runtime event 使用有界 sliding delivery 与 replay。
- 所有 mutation 经过 same-origin middleware；文件/worktree 权限由 `FileAccessPolicy` 执行，UI 隐藏不承担授权。
- 内部 adapter 错误只映射为固定公开消息，API key、OAuth code 与 prompt 正文不会反射到响应。

## 目录

```text
src/routes/              TanStack Start document、页面与 /api/$ 终端路由
src/api/                 HttpApi 合约、handler、错误与 middleware
src/server/              Pi adapter、repository、registry、workspace 与 policy Layer
src/browser/             共享 runtime、类型化 API client、preferences 与 DOM adapter
src/features/session/    session controller 与纯 UI reducer
src/components/          React 渲染
src/hooks/               很薄的 React binding
tests/e2e/               隔离的 Playwright acceptance
scripts/                 package/E2E host tooling
bin/pipee.js            打包后的 Nitro CLI adapter
```

npm tarball 只包含 `bin`、`.output`、`public` 和 manifest。`.output/server/node_modules` 被显式排除，Pi 的 native dependency 由 consumer 在自己的平台安装。

## 安全边界

`/api/workspace/files/*` 不是通用文件系统 API。允许根目录只来自 Pi session cwd、解析后的 project root、`~/pi-cwd-*` 和由 cwd/worktree 操作显式加入的位置。所有 mutation 都要求匹配的 origin。认证状态接口永远不返回已存储 secret。

## License

MIT
