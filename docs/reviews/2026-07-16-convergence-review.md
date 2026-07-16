# Pi Suite 架构与收敛审查

日期：2026-07-16  
范围：`apps/web`、`extensions/loop`、`extensions/weixin`、`extensions/chrome`、browser extension、`protocols/companion-contracts`、Suite release tooling，以及四个原始仓库的所有权关系。

## 结论摘要

Monorepo 方向正确，但迁移尚未完成。当前主要问题不是代码放在四个目录，而是同一事实仍有多个 owner：

1. 原始仓库和 `pi-suite` 都在继续变化，源码所有权双写。
2. `companion-contracts` 只集中了一部分 status schema；真正的控制协议仍通过 `unknown`、`name + args:string` 或两端各自 Schema 传递。
3. Suite 已成为候选归档 owner，但 leaf 中仍保留完整的旧发布实现。
4. 进程内互斥被用来表达跨进程唯一 owner，Loop 和 Weixin 都存在 durable writer 竞争窗口。

建议不是继续增加共享 helper，而是先封闭 P0 不变量，再按“同一生成源”收敛协议与发布 substrate。

## 审查方法与验证

- 按 `/Users/yansir/Downloads/checklist.md` 的 P0-P3 项逐项审查。
- Web、Loop/Weixin、Chrome 三条审查并行完成，主审负责 Suite 和跨仓比较。
- Loop tests：30/30；Weixin tests：56/56；Chrome strict Effect scan：0 findings。
- Effect scanner 明确不证明 runtime behavior 和 architecture boundaries；下列风险来自代码路径与状态转换取证。
- SHA-256 比较确认三套 Pi extension distribution 实现逐字相同。

## P0 Findings

### P0-1 Extension UI 被错误绑定到 Agent RunId

不变量：extension interaction 属于 session/runtime，不属于某次 agent run。

- `runIdRef` 初始为 `null`：[pi-agent-adapter.ts:784](/Users/yansir/code/52/pi-suite/apps/web/src/server/pi-agent-adapter.ts:784)
- Extension UI 全部经过 `publishForRun`，无 run 时直接丢弃：[pi-agent-adapter.ts:831](/Users/yansir/code/52/pi-suite/apps/web/src/server/pi-agent-adapter.ts:831)
- `requestUi` 在发布后无限等待 Deferred：[pi-agent-adapter.ts:851](/Users/yansir/code/52/pi-suite/apps/web/src/server/pi-agent-adapter.ts:851)
- terminal RunId 的事件又会被 reducer 拒绝：[session-ui-state.ts:373](/Users/yansir/code/52/pi-suite/apps/web/src/features/session/session-ui-state.ts:373)
- `/weixin login` 需要二维码 widget 和 input：[weixin.ts:115](/Users/yansir/code/52/pi-suite/extensions/weixin/extensions/weixin.ts:115)

这使新会话和已结束 prompt 的会话都可能丢失交互 UI，并让 command 悬挂为泛化 500。

结构修复：把事件代数拆为 `RunScopedEvent(runId)` 与 `SessionScopedEvent(interactionId/statusKey/widgetKey)`。Extension UI、status、widget 和 extension failure 不携带 RunId。

### P0-2 Non-loopback host capability API 没有身份认证

- CLI 支持任意 hostname：[pi-web.js:59](/Users/yansir/code/52/pi-suite/apps/web/bin/pi-web.js:59)
- 中间件只校验 same-origin/Fetch Metadata，GET 直接放行：[server.ts:130](/Users/yansir/code/52/pi-suite/apps/web/src/api/server.ts:130)
- `validateCwd` 可把调用者提供的任意现存目录加入 allowed roots：[workspace-io.ts:152](/Users/yansir/code/52/pi-suite/apps/web/src/server/workspace-io.ts:152)
- `admitExistingRoot` 只有 containment，没有 admission authority：[file-access-policy.ts:70](/Users/yansir/code/52/pi-suite/apps/web/src/server/file-access-policy.ts:70)

SameOrigin 防 CSRF，不识别用户。LAN 调用者访问自己的 same-origin 页面后可取得 session、文件、bash、模型凭据和包安装能力。

结构修复：non-loopback 启动必须要求 session secret/认证；root admission 只能来自服务端拥有的 session/project/picker capability，不能来自普通路径字符串。

### P0-3 Loop stale lease takeover 可产生两个 durable writer

stale takeover 是“读旧 owner → 判断 PID → 删除 lock → 再创建”的非原子序列：[repository.ts:146](/Users/yansir/code/52/pi-suite/extensions/loop/src/application/repository.ts:146)、[repository.ts:153](/Users/yansir/code/52/pi-suite/extensions/loop/src/application/repository.ts:153)。

两个 contender 可同时判断 stale，后者删除前者刚创建的新锁，最终两者都认为自己持有 lease，并都可写 durable state：[repository.ts:212](/Users/yansir/code/52/pi-suite/extensions/loop/src/application/repository.ts:212)。

结构修复：使用 OS 持有生命周期的文件锁，释放绑定同一 handle/token；不能用“路径存在”代表 ownership。

### P0-4 Weixin 的唯一 bridge 只在单进程内成立

- State store 只有进程内 `Semaphore`：[state.ts:64](/Users/yansir/code/52/pi-suite/extensions/weixin/src/state.ts:64)
- runtime singleton 也只存在于当前 `globalThis`：[runtime.ts:13](/Users/yansir/code/52/pi-suite/extensions/weixin/src/runtime.ts:13)

两个 pi-web/Pi CLI 进程可同时 poll、read-modify-write 同一 state，并重复转发微信消息。Atomic rename 只防半文件，不防 lost update。

结构修复：Bridge start 前获取 account/state-path 级跨进程 lease；loser 返回 typed ownership conflict，只允许只读状态。

### P0-5 Chrome 在没有证据时投影 `ProtocolCompatible=true`

- 无 connector/binding 时仍投影 compatible：[node-bridge.ts:582](/Users/yansir/code/52/pi-suite/extensions/chrome/src/pi/node-bridge.ts:582)
- Browser extension status 没返回 version/fingerprint evidence：[service-worker.ts:286](/Users/yansir/code/52/pi-suite/extensions/chrome/src/browser/service-worker.ts:286)
- 共享 contract 只有 true/false，无法表达 unknown：[chrome.ts:3](/Users/yansir/code/52/pi-suite/protocols/companion-contracts/src/chrome.ts:3)

`compatible` 同时表示“已验证一致”和“尚未观察”，属于 impossible state。旧插件可先显示 compatible，直到 attach 才失败。

结构修复：compatibility 变为 `verified | incompatible | unknown`，只能从 public connector evidence 推导。

## P1 Findings

### P1-1 原始仓库与 monorepo 双写

README 宣称 Pi Suite 是 source repository：[README.md:3](/Users/yansir/code/52/pi-suite/README.md:3)，但 `release/sources.json` 仍把四个原始仓库记录为来源：[sources.json:4](/Users/yansir/code/52/pi-suite/release/sources.json:4)。

实际 `/Users/yansir/code/52/pi-web` 已从导入 commit `0c36545` 前进到 `7be15b0`，且还有 15 个未提交文件；Suite 的 `apps/web` 已形成另一条实现线。

必须明确：导入后 `pi-suite` 是唯一 writer，原仓库 archived/read-only。不要建设双向同步脚本，它会把所有权冲突自动化。

### P1-2 Web↔browser-extension 协议仍双写，且端口契约矛盾

- Browser extension 手写 request union/type guard：[service-worker.ts:252](/Users/yansir/code/52/pi-suite/extensions/chrome/src/browser/service-worker.ts:252)
- Web 独立定义 response Schema：[chrome-control.ts:48](/Users/yansir/code/52/pi-suite/apps/web/src/lib/chrome-control.ts:48)
- pi-web 支持任意 `--port`：[pi-web.js:76](/Users/yansir/code/52/pi-suite/apps/web/bin/pi-web.js:76)
- Service worker 只接受 `30141`：[service-worker.ts:268](/Users/yansir/code/52/pi-suite/extensions/chrome/src/browser/service-worker.ts:268)

两边可各自 typecheck 通过、运行时才失败。整个 external messaging request/response/error/evidence 应归 `companion-contracts/chrome`。

### P1-3 Companion contract 仍可被 `unknown` 和 string transport 绕过

- HTTP extension command 是任意 `{name, args:string}`：[contract.ts:1076](/Users/yansir/code/52/pi-suite/apps/web/src/api/contract.ts:1076)
- Loop typed request 被 JSON stringify 后塞回 generic transport：[useAgentSession.ts:996](/Users/yansir/code/52/pi-suite/apps/web/src/hooks/useAgentSession.ts:996)
- Extension statuses 的 transport 仍是 `JsonValue`：[contract.ts:251](/Users/yansir/code/52/pi-suite/apps/web/src/api/contract.ts:251)
- Browser hook 再用类型断言恢复状态：[useAgentSession.ts:169](/Users/yansir/code/52/pi-suite/apps/web/src/hooks/useAgentSession.ts:169)

最危险的 illusion 是“已有 shared schema，所以 extension control 已类型安全”。Schema 只覆盖局部 payload，没有覆盖 capability endpoint 和 lifecycle。

### P1-4 `pi/runtime-lease` 有两个 Schema owner

- Loop owner：[status.ts:20](/Users/yansir/code/52/pi-suite/extensions/loop/src/pi/status.ts:20)
- Web owner：[runtime-lease.ts:4](/Users/yansir/code/52/pi-suite/apps/web/src/lib/runtime-lease.ts:4)
- Workspace gate 只检查三种 status literal，遗漏 lease：[verify-workspace.mjs:75](/Users/yansir/code/52/pi-suite/tooling/release/verify-workspace.mjs:75)

该协议决定 web 是否保持 automation runtime；任一侧独立改变都会静默关闭活跃 runtime。

### P1-5 Session operation busy check 不是原子状态机

`compact`/`bash` 先读 snapshot 判断 busy，再启动 fiber：[session-runtime-registry.ts:367](/Users/yansir/code/52/pi-suite/apps/web/src/server/session-runtime-registry.ts:367)、[session-runtime-registry.ts:404](/Users/yansir/code/52/pi-suite/apps/web/src/server/session-runtime-registry.ts:404)。两个请求可同时观察 idle；后者覆盖 `activeBash`，但两个 fiber 都继续执行。

结构修复：handle 内只有一个 `OperationSlot = Idle | Starting(kind,id) | Active(kind,id)`，mutation 在同一同步原语中执行 CAS；snapshot 只是投影，不参与授权。

### P1-6 任一 session shutdown 可取消另一 session 的全局 Weixin login

每个 extension session shutdown 都调用 process-global `bridge.cancelLogin`：[weixin.ts:188](/Users/yansir/code/52/pi-suite/extensions/weixin/extensions/weixin.ts:188)。Global login fiber 没有 session/owner identity：[bridge.ts:568](/Users/yansir/code/52/pi-suite/extensions/weixin/src/bridge.ts:568)。

Session shutdown 只能释放自己的 subscription；global login cancellation 必须核对 owner token，或只允许显式 stop/logout。

### P1-7 Chrome upgrade fixture 是空证明

唯一 fixture 是 `{"version":1,"bindings":[]}`：[pi-chrome-session-bindings-v1.json:1](/Users/yansir/code/52/pi-suite/tests/upgrade-fixtures/pi-chrome-session-bindings-v1.json:1)，测试只证明空数组仍为空：[connector-binding.test.ts:72](/Users/yansir/code/52/pi-suite/extensions/chrome/test-suite/unit/connector-binding.test.ts:72)。

Chrome 实际持久化 profile binding、credential、browser identity、command journal、targets 和 authorization ledger。当前 gate 不能证明真实用户升级后保留 binding、授权和未决命令语义。

### P1-8 Root verify 没有代表 release acceptance

Root `verify` 只跑 workspace shape 和 upgrade tests：[package.json:18](/Users/yansir/code/52/pi-suite/package.json:18)。它不包含 package verify、candidate build、candidate integrity、consumer checks，也没有真实 browser extension attach/mismatch 流程。

不要让 `pnpm verify` 表达“全部完成”，除非它真的拥有 release acceptance；否则应改名为 `verify:source`。

## P2 不必要复杂度与可删除代码

### P2-1 三份完全相同的 Pi distribution substrate

三包以下文件 SHA-256 完全相同：

- `scripts/pi-extension/build.mjs`
- `scripts/pi-extension/distribution-contract.mjs`
- `scripts/pi-extension/verify-distribution.mjs`

每包 474 行，共 1422 行；唯一变化轴是 `config.mjs`。例如 [distribution-contract.mjs:29](/Users/yansir/code/52/pi-suite/extensions/loop/scripts/pi-extension/distribution-contract.mjs:29) 和 [verify-distribution.mjs:27](/Users/yansir/code/52/pi-suite/extensions/loop/scripts/pi-extension/verify-distribution.mjs:27)。

应收敛为 root-owned `pi-extension-release-tooling`，leaf 只保留 config/薄入口。发布 tgz 不包含 tooling dependency。

### P2-2 四份旧 release algebra 已无调用方

Web/Loop/Weixin/Chrome 的 `scripts/release/prepare.mjs` 与 `version.mjs` 逐字相同，约 528 行；monorepo 没有 workflow 或 package script 引用它们。Suite 已有独立 candidate/consumer owner。

这批代码应删除，不应再抽象。抽象 dead code 只会保留第二发布 owner。

### P2-3 Mega modules 聚合多个变化轴

- `pi-agent-adapter.ts` 约 2318 行：session normalize、HTML export patch、runtime bridge、extension UI、models、auth、packages、skills。
- `useAgentSession.ts` 约 1210 行：session lifecycle、Chrome、Loop、slash command、bash、branch 和 UI projection。

“只有一个文件 import Pi SDK”不等于“所有 Pi 能力必须在一个文件”。可保留 SDK import 单点，同时在转换后拆 narrow capability modules。

### P2-4 没有 exporter 的 OTel dependency closure

Weixin 安装完整 `@effect/opentelemetry` peer closure：[package.json:45](/Users/yansir/code/52/pi-suite/extensions/weixin/package.json:45)，但 runtime Layer 没有 exporter/processor：[runtime.ts:7](/Users/yansir/code/52/pi-suite/extensions/weixin/src/runtime.ts:7)。Span 不会被导出，制造“已可观测”假象。

没有 owned exporter 时应删除；未来 exporter、配置、shutdown、redaction 和 acceptance test 必须一起引入。

### P2-5 Pi host compatibility range 不一致

Loop peer 是 `*`：[loop package.json:56](/Users/yansir/code/52/pi-suite/extensions/loop/package.json:56)，Weixin 是 `^0.80.6`：[weixin package.json:68](/Users/yansir/code/52/pi-suite/extensions/weixin/package.json:68)。两包由同一 Suite 兼容性集合验证，host range 应由 Suite compatibility owner 生成或校验。

### P2-6 Public error redaction 正确，但内部诊断也被抹掉

客户端统一返回 `Pi operation failed` 是正确安全边界：[server.ts:112](/Users/yansir/code/52/pi-suite/apps/web/src/api/server.ts:112)。但内部没有 correlation-aware operation/session/request 日志，background failure 又被 ignore，导致现场无法还原。

## 真共性：应收敛

1. **External companion protocols**：status、runtime lease、typed controls、Chrome web-run request/response/error/evidence。
2. **Pi extension release substrate**：build、distribution contract、archive loader、registration assertions。
3. **Suite release ownership**：版本组合、候选归档、SHA-512、consumer acceptance、host compatibility matrix。
4. **跨进程 lease primitive**：可共享安全 lock/owner-token 能力，但 Loop/Weixin policy 各自拥有。
5. **Atomic file replacement primitive**：可共享 staging/permission/rename substrate，但 migration 和 domain commit semantics 不共享。

## 偶然相似：不应合并

1. Loop temporal automaton 与 Weixin inbound-image automaton。
2. Loop session-owned scheduler 与 Weixin process-owned account bridge lifecycle。
3. 三个 extension 的 command router/domain actions。
4. 各 domain status 内容；只共享 transport/schema owner。
5. 各 persistence repository；只共享底层原子写/lease capability。
6. Chrome operation graph 与 Loop schedule graph；两者都叫“operation”不代表同一变化原因。

## Checklist 必须结论

### Top 3 架构风险

1. Host capability API 在 non-loopback 模式无用户认证，且路径 admission 由调用方扩张。
2. Session-scoped extension interaction 被塞进 run-scoped event model。
3. Loop/Weixin 的单 writer/单 poller 不变量在多进程下不成立。

### Top 3 不必要复杂度

1. 1422 行逐字相同的 Pi distribution substrate。
2. 约 528 行无人调用的旧 leaf release algebra。
3. Generic extension command + `unknown` status 迫使 typed DTO stringify/cast/decode。

### 最危险的 illusion

“Monorepo + companion contracts 已经提供一个类型安全、兼容性可证明的产品单元。”

实际仍有：双写源码、双写 external message schema、generic string command、重复 runtime lease schema，以及没有 evidence 时的 `ProtocolCompatible=true`。

### 最应该重画的边界

`Session runtime event + companion capability`：

```text
SessionEvent
├─ RunScopedEvent(runId)
└─ SessionScopedEvent(interactionId/statusKey/widgetKey)

CompanionCapability
├─ LoopControl
├─ WeixinControl
└─ ChromeWebRun
```

HttpApi 和 browser extension external messaging 只能承载这些 typed capabilities，不能承载任意 extension command string。

### 最应该删除或合并的代码

1. 删除四份未引用的 leaf `scripts/release/*`。
2. 合并三套 `scripts/pi-extension/{build,distribution-contract,verify-distribution}`。
3. 删除 generic structured-control 的 `extensionCommand` 路径；保留明确的 terminal slash-command 能力时必须单独建 failure model。
4. 删除 runtime lease 和 Chrome web-run 的 schema 副本。
5. 删除无 exporter 的 OTel dependency closure。

### 最值得保留的设计

- Runtime registry 的 `Starting(Deferred) | Active(handle)` exact-slot cleanup。
- Scope-owned runtime shutdown、SSE bounded replay 和 stale RunId rejection。
- Loop tagged temporal states、纯 transition algebra、persist-before-occurrence。
- Weixin persisted `Collecting/Dispatching` 与 deterministic request identity。
- Chrome operation-contract 驱动 fingerprint/deadline/registration。
- Chrome authorization fail-closed poison ledger 与 connector generation/claim 校验。
- Public error redaction 和 realpath containment。
- Suite exact tgz consumer verification与 SHA-512 记录。

## 一个最小但高杠杆的重构

先只修 **Extension UI event ownership**：

1. 从 `RuntimeEvent` 提取 `SessionScopedEvent`。
2. `ExtensionUiRequested` 不再需要 RunId。
3. Adapter 直接发布 session event，不经 `publishForRun`。
4. Reducer 在 session 层接收，不执行 active/terminal RunId gate。
5. Scope close 统一取消 pending interaction Deferred。

这是当前 `/weixin login` 失败类的结构修复，也为 OAuth、select、input、custom widget 建立正确 substrate。

## 验证方法

1. 新建从未 prompt 的 session，确认 `runId === null`。
2. 调用 typed Weixin login control。
3. SSE 必须收到二维码 widget 与 input session event。
4. 在 terminal session 重复，不能制造 synthetic RunId，也不能 hanging。
5. 并行验证旧 run replay 仍不能覆盖新 run state。
6. 随机端口启动候选 pi-web，加载候选 browser extension，跑完整 `status → prepare → attach → complete → assert → status`。
7. 匹配组合最终为 `verified + ready`；mismatch 为 `incompatible`；无 evidence 为 `unknown`。
8. 两进程竞争 Loop stale lease 和 Weixin account lease，重复数百次，任何时刻恰好一个 owner。

## 推荐顺序

1. P0 安全和 event ownership。
2. Loop/Weixin 跨进程 ownership。
3. Chrome compatibility 三态与 web-run shared protocol。
4. 冻结原始仓库，Pi Suite 成为唯一 source owner。
5. 收敛 release tooling并删除 dead leaf release code。
6. 扩充真实 upgrade fixtures 与 candidate browser-extension E2E。

