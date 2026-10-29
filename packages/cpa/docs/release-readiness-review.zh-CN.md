# 正式版发布前审查报告

审查日期：2026-10-26。基线：`b9f5470`，包版本 `0.0.1-alpha-3`，固定 CPA `v8.0.43`。

**结论：接近可以结束 alpha，但建议先修复进程退出清理、补齐发布门禁，并处理下面几项已复现的资源清理问题，再发布候选版。** 核心正常路径已经有不错的验证基础；目前的主要风险集中在异常路径和发布流程，暂时没有证据表明需要重构整个项目。

本次只审查和运行验证，没有修改实现。优先级是本次发布建议，不代表这些问题均为安全漏洞。

## 验证结果与边界

| 检查 | 结果 |
| --- | --- |
| `pnpm lint` | 通过，有 1 条 `noPrototypeBuiltins` 警告，位于 `src/server/config.ts:32` |
| `pnpm typecheck` | 通过 |
| `pnpm run build` | 通过 |
| `pnpm format:check` | 通过，但当前只实际检查 5 个文件，不能代表全仓格式一致 |
| `pnpm test:coverage` | 4 个文件、82 项测试全部通过 |
| 真实 CPA E2E | 使用已有 `linux-x64-musl` 二进制，3 个文件、37 项测试全部通过 |
| 补充最小复现 | 确认 SIGTERM 子进程遗留、OAuth 监听器残留和取消错误类型不一致、启动参数错误导致临时目录遗留、原始 Response 监听器残留 |

本地运行环境为 Linux / Node `v26.8.1`。首次测试因沙箱不允许监听端口而失败，在放开测试所需限制后通过；这些首次失败不计为产品缺陷。

覆盖率输出为行覆盖率 93.88%、分支覆盖率 87.47%，但配置只统计 client resources 和 server，**不包含 `src/client/transport.ts`**，不能表述为整个 SDK 的覆盖率。现有 transport 单元测试有执行。

没有在本次审查中重建全部 23 个目标、重跑所有包管理器安装矩阵、验证 Windows/macOS/Bun 实际运行结果，或检查 GitHub 远端分支保护和 npm 发布权限；也未进行上游依赖漏洞审计。E2E 使用本地已有产物，其 BUILD-INFO 的 CPA commit 与源码固定版本一致，但平台包名称仍保留旧的 `@cpa-js` scope，因此它不能替代本次正式版的新产物验证。

## 建议发布前修复

### 1. P1：父进程因 SIGTERM 退出时，CPA 子进程可能遗留

位置：`src/server/process.ts:7-16`。

当前只注册 `process.once('exit')` 来杀掉子进程。用 `ManagedProcess` 启动一个长驻 Node 子进程，再向宿主进程发送 SIGTERM，宿主退出后，子进程仍存活；最小复现输出 `childStillAlive: true`。复现使用与 CPA 相同的进程管理类，未依赖 CPA 的业务行为，测试子进程随后已清理。

影响：部署替换、服务停止等常见退出场景可能留下后台进程、持续占用端口。注释“Children ... never outlive it”超出了实际保证。容器或服务管理器若统一杀掉进程组，可能缓解此问题，但普通 Node 宿主没有这一保证。

建议：明确库和调用方的信号处理责任。至少提供可靠的 SIGTERM/SIGINT shutdown 示例，并让项目正式承诺的自动清理行为有相应实现；若库安装信号处理器，要处理已有监听器、多个实例以及退出码，避免改变宿主退出行为。不可捕获的 SIGKILL 不应纳入保证。

验收：在独立宿主进程中分别测试正常退出、SIGTERM、SIGINT，确认没有存活的子进程，并确认调用方原有信号处理仍正常。

### 2. P1：发布流水线没有把完整 CI 作为强制依赖

位置：`.github/workflows/release.yml:6-17,158-160`；`.github/workflows/ci.yml:3-6`。

release 在 `v*` tag 上运行，publish 只依赖 install-test；这条依赖链包含构建、二进制验证和安装冒烟，但没有完整单元测试、类型检查、lint、契约 E2E。普通 CI 在 main push / PR 上运行，release 没有检查相同提交的 CI 是否通过。

影响：从未通过 CI 的提交打 tag，或 CI 尚未结束时打 tag，工作流结构仍允许继续发布。当前测试通过不等于未来正式版发布始终受到保护。远端保护规则是否另有限制，本次未核实。

建议：把检查抽成可复用 workflow，让 release 显式依赖它；或验证 tag 对应的精确 commit 已通过必需检查。不要只检查 main 最近一次绿色结果。

验收：在候选发布流程中故意引入失败测试，确认 publish 无法执行；修复后以同一候选提交完成整个矩阵。

### 3. P2：OAuth 轮询遗留 abort 监听器，取消错误类型不统一

位置：`src/client/resources/oauth.ts:41-60`。

每次轮询后的 sleep 都为 signal 注册一次监听器，但定时器正常完成时没有移除。最小复现经历 14 次 wait 后成功返回，signal 上仍残留 14 个 abort 监听器。`once: true` 只在触发 abort 时移除监听器，不会在轮询成功时移除。

同时，在 sleep 期间取消会直接 reject `signal.reason`；复现得到普通 `Error`，而请求过程中取消使用 `CpaAbortError`。调用方按 README 统一捕获 SDK 错误时，结果取决于取消时机。

建议：实现可清理的 abortable sleep，在成功和失败路径都移除监听器，并检查已取消信号；统一取消错误类型。为整个等待流程单独定义可选总时限，目前 `timeoutMs` 只是每个请求的时限，不能限制总轮询时长。

验收：多轮成功、请求中取消、sleep 中取消、预先取消后，监听器数量均回到基线，取消类型一致。

### 4. P2：非法 args 导致自动创建的临时目录未清理

位置：`src/server/index.ts:215-236`。

`mkdtemp()` 在 `buildArgs()` 之前执行，而 `buildArgs()` 又在负责 cleanup 的 try/catch 外。传入 `args: ['-config']` 会正确报 `invalid-options`，但留下一个 `cpajs-*` 临时目录。已使用有效 `binaryPath` 复现，遗留目录随后已清理。

影响：反复失败的启动会累积临时目录，也与 README 中“每种失败情况都清理临时目录”的承诺不一致。这一路径尚未写入配置，不能据此推断目录里泄漏了凭据。

建议：把纯参数检查全部提前到创建资源之前，同时从第一次创建资源开始覆盖完整清理边界。

验收：对所有被拒绝的 CLI flags 调用 startServer，临时目录数量不增加。

### 5. P2：原始 Response 模式保留调用方 signal 监听器

位置：`src/client/transport.ts:147,196-200`。

`responseType: 'response'` 在 finally 中只清定时器，不移除用户 abort 监听器。这能保证读取 body 时仍可取消，但 body 消费完毕后也没有释放机制。最小复现调用 request 并读完 `.text()` 后，signal 上仍有 1 个监听器。即使该模式下请求失败、根本未返回 Response，也走同一不释放分支。

影响：长期复用同一个 signal 的调用方会累积已结束请求的闭包和 controller。

建议：失败路径立即释放；成功返回流时，在流结束、出错、取消时释放，或提供明确的受控流/释放机制。不能简单在返回 headers 时移除监听器，否则会破坏现有 body 取消语义。

验收：成功读完、主动取消 body、网络失败、HTTP 错误后监听器均恢复基线；未读完时 signal 仍能终止读取。

## 可以随后安排的改进

1. **日志内存上限按字节控制。** `src/server/process.ts:73-94` 只限制 200 行，无换行的 pending 和单行长度都没有上限。面对超长日志，缓存仍可持续增长。建议增加单行/累计字节上限及截断标记；这是代码检查发现的边界，本次未做内存压力测试。
2. **补上关键异常路径的覆盖率门禁。** 将 transport 纳入统计，并在 CI 实际运行覆盖率检查；优先加入上面的行为回归测试，再根据基线设阈值。当前 CI 执行的是 `pnpm test`，没有覆盖率门禁。无需为了提高百分比添加重复实现逻辑的测试。
3. **清楚定义正式版兼容承诺。** 增加 alpha → stable 迁移说明和人工整理的变更记录，特别说明 `managementKey` 弃用、管理密钥默认行为、配置复用、Windows 强制终止、ESM-only 导出、Node/Bun 最低版本，以及 cpajs 与 CPA 分别如何升级。如果发布 1.0，要明确何种类型或行为变化算 breaking change。
4. **限制脱敏承诺的范围。** `src/server/redact.ts:1-6` 跳过长度小于 4 的密钥，且脱敏列表从启动时配置收集，restart 继续使用旧 redactor。README 不宜笼统保证所有密钥都会被屏蔽；应说明短值和运行中新增凭据的边界，或补足实现。本次未复现 CPA 主动输出这些新密钥，不能把这个边界直接定性成已发生泄漏。
5. **确保正式发布使用全新产物。** 本地 dist-bin/dist-npm 是忽略目录，已有产物可能落后于源码。以干净工作区完成 assemble/pack/install-test，并核实主包 optionalDependencies 覆盖预期目标、版本完全一致、解包后类型可用、二进制及 LICENSE 存在。不要把本地旧 tarball 的安装成功当作正式版证据。

## 建议的发布验收顺序

1. 修复第 1–5 项并加入针对性的回归测试，优先解决 SIGTERM 清理与发布门禁。
2. 在声明支持的 Node 22/24、Bun 和主要系统上完成现有 CI；用新构建的 gnu/musl/Windows 二进制重跑契约测试。
3. 以 RC 版本完整跑一遍 release 构建和安装矩阵，核实平台包、主包及 npm dist-tag。
4. 补齐迁移说明、兼容策略和人工整理的发布说明，确认候选提交与正式 tag 对应内容一致后发布。

项目值得保留的基础包括：client/server 入口分离、固定上游 commit、管理密钥默认 bcrypt 和环境变量隔离、配置持久化、restart 并发语义、ETag 支持，以及真实二进制契约和跨平台安装矩阵。下一步应围绕这些既有设计收紧异常行为和发布约束。
