# zeroY Pipee 连接配对开发计划（实施跟踪）

目标：把 zeroY 从"启动时手工拼 ZEROY_SITES"改成可持久化、可复用的站点连接体验。

## 阶段划分与状态

### P0：协议与 owner
- [x] P0.1 protocols/companion-contracts: connection-registry.ts（连接/secret capability + 授权协议 schema）
- [x] P0.2 packages/host-runtime: 实现 connection registry capability provider
- [x] P0.3 apps/pipee: 持久化连接库 + secret store + 授权 callback 路由
- [x] P0.4 extensions/zeroy: session 零连接启动 + 动态 registry 投影；工具读投影
- [x] P0.5 wordpress-plugin: 授权 intent/grant 表 + 独立 client grant 认证

### P1：主流程
- [x] P1.1 Pipee zeroY 连接管理页面（站点列表 + 添加）
- [x] P1.2 浏览器授权流程：URL -> WordPress 授权页 -> callback -> exchange
- [x] P1.3 连接后刷新所有已运行 session（共享 registry 单例 + capability 订阅）
- [x] P1.4 zeroY 工具全部改读 registry projection

### P2：管理与备用
- [x] P2.1 WordPress 连接管理页（客户端列表、撤销）
- [x] P2.2 Pipee 撤销、重新授权、错误恢复
- [x] P2.3 WordPress 发起入口（"连接到 Pipee"按钮）
- [x] P2.4 短期配对码备用流程

### P3：发布体验
- [x] P3.1 zeroY extension 构建产物纳入 Pipee 安装包（release/pipee.config.json 已含 zeroy，prepareScript pi:build，bundle 只外部化 Node builtins）
- [x] P3.2 pipee 启动不要求任何 zeroY 环境变量（零连接启动 + 空投影）
- [x] P3.3 安装包验收不执行仓库 build 命令（发布管道使用已构建产物）
- [x] P3.4 headless/CI 文档单独说明 ZEROY_SITES

## 核心不变量
- 一次授权建立一个可撤销的 Pipee 连接；连接属于 Pipee 实例
- WordPress 只存 grant 的不可逆 hash；Pipee 只存 credentialRef（secret 进安全存储）
- 生产路径不从 ZEROY_SITES 读取；ZEROY_SITES 仅 headless/CI 专用
- session 不拥有连接事实，只消费 registry projection
- 硬切：不兼容旧字段、不双写同步、旧连接全部重新授权
