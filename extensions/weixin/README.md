# pi-weixin

Agent-first Weixin bridge tools for Pi. One Weixin account is connected globally to Pi Web. An
unquoted message enters the configured default Pi session; quoting a Pi-originated Weixin message
routes back to the exact session that sent it.

## Tools

- `weixin_connect`: ensure the global account is logged in and running. The first caller becomes the
  default session when none exists.
- `weixin_set_default`: make the current Pi session the target for unquoted messages.
- `weixin_send`: send a text report from the current Pi session. Quoted replies return here.
- `weixin_disconnect`: stop polling while retaining credentials, default session, and routes.
- `weixin_logout`: clear credentials, cursor, and send context while retaining the default session.
- `weixin_status`: read the global account, default session, connection, and send readiness.

`weixin_connect` is the only path that may require temporary user interaction. When credentials are
missing or expired, it shows the QR widget and waits for the scan. Existing credentials connect
without a prompt.

Proactive send becomes ready after the connected user has sent at least one inbound message, which
provides the iLink context token. Pi Web renders one global-account Weixin Web Surface from the multiplexed
Bridge projections. Scan/re-scan, pause/resume, logout, default-session selection, and test send are finite
typed actions against the single Bridge owner. Default-session selection names the exact existing Session;
it does not create a second account or routing owner.

## Development

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm build
```

`pnpm verify` 依次执行格式与 lint、Effect language service 类型检查、测试、锁定版本的 `effect-scan` 语义检查、自包含构建、tarball 内容检查，以及零安装目录中的 Pi extension loader 验收。Pi Runtime 的唯一入口是 `dist/pi/extension.js`；浏览器页面从归档内 `dist/web` 加载。

## 分发

需要发布 Weixin 时，在 `release/changes/` 下提交 JSON changeset，指定 `@yansircc/pi-weixin` 与 `patch`、`minor` 或 `major`。没有 Weixin changeset 的推送不会修改或发布它的版本。版本、release commit、package tag 与归档只由 CI 生成；同一份归档会在 Linux、macOS、Windows 上解包并通过真实 Pi loader 验证后，使用 npm Trusted Publishing 发布并附带 provenance。

生成可直接交付的压缩包：

```bash
pnpm pack:plugin
```
