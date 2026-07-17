# pi-weixin

Agent-first Weixin bridge tools for Pi. The agent connects, disconnects, logs out, and inspects
status directly; there is no `/weixin` command or Web control button.

## Tools

- `weixin_connect`: ensure login, bind the current Pi session, and start the bridge.
- `weixin_disconnect`: stop the bridge while retaining credentials and binding.
- `weixin_logout`: stop and clear credentials, cursor, and binding.
- `weixin_status`: read account, binding, and connection state.

`weixin_connect` is the only path that may require temporary user interaction. When credentials are
missing or expired, it shows the QR widget and waits for the scan. Existing credentials connect
without a prompt.

Pi Web renders the structured Weixin projection as read-only status. All mutations go through the
typed Agent tools.

## Development

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm build
```

`pnpm verify` 依次执行格式与 lint、Effect language service 类型检查、测试、锁定版本的 `effect-scan` 语义检查、自包含构建、tarball 内容检查，以及零安装目录中的 Pi extension loader 验收。Pi 加载的唯一构建入口是 `dist/pi/extension.js`。

## 分发

需要发布 Weixin 时，在 `release/changes/` 下提交 JSON changeset，指定 `@yansircc/pi-weixin` 与 `patch`、`minor` 或 `major`。没有 Weixin changeset 的推送不会修改或发布它的版本。版本、release commit、package tag 与归档只由 CI 生成；同一份归档会在 Linux、macOS、Windows 上解包并通过真实 Pi loader 验证后，使用 npm Trusted Publishing 发布并附带 provenance。

生成可直接交付的压缩包：

```bash
pnpm pack:plugin
```
