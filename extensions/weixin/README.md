# pi-weixin

通过腾讯 iLink 把一个微信账号绑定到一个由 pi-web 托管的 Pi session。微信和 Web 写入同一份 Pi session 文件。当前连接层以腾讯 `@tencent-weixin/openclaw-weixin@2.4.6` 的 iLink wire contract 为兼容基线。

## 安装

通过 npm 安装公开 Pi package：

```bash
pi install npm:@yansircc/pi-weixin
```

开发态也可从 pi-web 的插件设置安装本地目录：

```text
/Users/yansir/code/52/pi-weixin
```

安装后 reload 当前 session，然后执行：

```text
/weixin login
```

扫描二维码后，当前 Pi session 会成为微信消息的目标。默认通过 address-family-neutral 的 `http://localhost:30141` 连接本机 pi-web，由运行时选择可用的 IPv4/IPv6 loopback；可用 `PI_WEB_BASE_URL` 显式覆盖。

## 开发

仓库使用 pnpm、Vite+、TypeScript 和 Effect v4：

```bash
pnpm install
pnpm test
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

产物为 `pi-weixin-<version>.tgz`。`effect`、`@effect/platform-node`、`qrcode` 和项目源码均已收进单文件 bundle；发布包没有普通 `dependencies`，运行时只允许依赖 Node 内建模块和 Pi 宿主 API。

接收方不需要执行 `npm install` 或 `pnpm install`：

```bash
mkdir -p "$HOME/pi-plugins/pi-weixin"
tar -xzf pi-weixin-0.0.2.tgz \
  -C "$HOME/pi-plugins/pi-weixin" \
  --strip-components=1
```

然后在 pi-web 插件设置中填入：

```text
~/pi-plugins/pi-weixin
```

发布包只包含 `package.json`、`README.md`、`LICENSE` 和 `dist/pi/extension.js`。

## 命令

- `/weixin login`：扫码登录，并绑定当前 session。
- `/weixin bind`：把已登录的微信账号改绑到当前 session。
- `/weixin start`：启动已配置的桥接。
- `/weixin stop`：停止桥接，保留登录和绑定。
- `/weixin status`：显示脱敏状态。
- `/weixin logout`：停止并清除 token、cursor 和绑定。

状态保存在 `~/.pi/agent/pi-weixin/state.json`，文件权限为 `0600`。入站消息优先使用 iLink `message_id` 去重，缺失协议身份时才派生规范化消息哈希；同一身份同时作为 pi-web 的幂等 `requestId`。Pi 使用工具时会发送结构化进度消息；工具进度和最终回复都按原消息身份生成确定性的 iLink `client_id`。最终回复按 4000 个 Unicode 标量分片。

单独发送图片后，bridge 会持久等待 30 秒；期间每张新图片都会重置截止时间。用户发送文字或微信已提供转写的语音时，累计图片与描述会作为一个请求立即提交。截止前没有描述时，单图使用“请分析图片。”，多图使用“请分析这些图片。”。收集与提交状态会在 extension 重启后继续恢复。

连接层支持区域节点重定向、配对码登录、已绑定账号复用、输入中状态、在线状态通知和失效 token 检测。网络故障使用带抖动的指数退避；`errcode: -14` 会停止轮询、清除失效凭证并提示重新登录。

## MVP 边界

- 处理绑定微信用户发来的文本、引用文本、图片和服务端已有的语音转写。
- 语音默认使用微信返回的转写文本；微信未返回转写时会提示用户重发语音或改发文字。
- pi-web 进程必须运行；服务重启后，需要任意 Pi session 加载该 extension 才会自动恢复轮询。
- 一个微信账号只绑定一个 Pi session。
- 还没有原始语音转写、文件、微信侧交互审批和独立 daemon。
- 在支持多个写入宿主前，必须把 session registry 抽成唯一 `PiSessionHost`；不得让 extension 自行创建第二个 `AgentSession`。
