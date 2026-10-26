# 原生 CLIProxyAPI 的 JS npm 封装计划

## 目标

提供标准 npm 包（暂名 `cpa-js`），在 JS 中启动官方 CLIProxyAPI，或通过带类型的手写 client 连接已有服务。TypeScript 开发，发布 JS、类型声明和 source map，支持 Node.js 与 Bun。

依据官方文档和固定版本源码，手写带类型的 CLIProxyAPI 原生管理 API client。

## 公共入口

- `cpa-js/server`：二进制定位、配置、进程生命周期、就绪检测、日志。
- `cpa-js/client`：基于标准 Fetch 的原生管理 API client，可独立连接本地或远程 CPA。

```ts
import { startServer } from 'cpa-js/server';

const server = await startServer({
  stateDir: './.cpa',
  config: {
    // 固定版本 CPA 的原生配置字段
  },
});

console.log(server.origin);
console.log(server.baseUrl); // 模型 API 的 /v1 地址
await server.stop();
```

```ts
import { createClient } from 'cpa-js/client';

const client = createClient({
  baseUrl: 'http://127.0.0.1:8317',
  managementKey: process.env.CPA_MANAGEMENT_KEY!,
  timeoutMs: 15_000,
});

// 方法名在接口盘点阶段确定。
const config = await client.config.get();
const files = await client.authFiles.list();
```

## 官方二进制：我们编译、随 npm 分发

用户 `npm install` 后即可调用 `startServer()`，平台二进制自动就位。

- CI 从固定版本官方 CPA 源码编译 executable，直接运行官方服务。
- 各平台独立 npm 包，通过主包的 `optionalDependencies` 及平台包的 `os`、`cpu`、`libc` 选择正确产物。
- 二进制直接包含在平台包中，由 npm 安装对应平台产物。
- 平台包与主包版本一致；另记录 CPA 版本、源码提交、构建参数、产物校验和与许可证。
- `binaryPath` 仅作为高级覆盖选项。提供明确的平台不支持、可选依赖被省略、文件缺失及不可执行错误。

目标矩阵：

| 系统 | 目标 |
| --- | --- |
| macOS | x64、arm64 |
| Windows | x64、arm64；评估上游支持的其他架构 |
| Linux glibc | x64、arm64、armv7；盘点其他上游可支持架构 |
| Linux musl | x64、arm64、armv7 |
| FreeBSD 等 | 盘点上游及 Go 工具链可支持目标并逐项构建 |

“全平台”以明确矩阵为准，上游可支持目标逐项编译；记录无法支持目标及原因。涉及 CGO 和动态插件时，区分带插件与便携构建能力。能运行的目标执行真实启动及 HTTP 冒烟测试；仅交叉编译通过的目标明确标注验证级别。验证 npm 的平台选择规则，避免多个变体误装或遗漏。

## Server 行为

- 使用 `node:child_process.spawn` 运行原生 CPA。
- 支持互斥的 `configPath` 和 `config`。
- 配置对象使用原生字段与语义，写入包管理的配置文件；现有配置文件交给 CPA，尊重上游自身的持久化及热更新行为。
- 分别管理状态目录、凭据、配置和临时文件，清理范围限定为本包创建的临时资源。
- 等待实际就绪后返回；检查进程提前退出，支持启动超时和主动取消。
- 验证官方 CLI 的端口 0 及端口发现能力，据此实现动态端口或指定端口启动。
- 提供 origin、模型 API baseUrl、进程信息、日志回调和退出结果。
- `stop()` 幂等，先优雅终止，超时强制结束，验证 Windows 对应行为。
- 启动失败、超时或取消时清理子进程和本包的临时资源。
- 传递参数使用 spawn 参数数组，日志与错误中的密钥执行脱敏。

## 手写 API client

先固定 CPA 版本，以官方文档和该版本源码的路由、handler、请求与响应结构为依据，覆盖原生管理能力。采用 `/v8/management`，按固定版本的真实路由实现接口。

拟定资源分组，最终按真实路由调整：

| 分组 | 能力 |
| --- | --- |
| config | 完整配置、配置节点、YAML 的读取与修改 |
| authFiles | 凭据列表、上传、下载、修改、启停、删除 |
| oauth | 原生授权入口、回调、状态与会话操作 |
| usage | 原生用量统计及导入导出 |
| logs | 普通日志、错误日志、请求日志 |
| requests | 原生管理 API 的上游请求调用 |
| server | 原生版本等服务信息 |

公共约定：

- 每个实例独立保存地址、鉴权及 fetch。
- baseUrl 接受服务根地址，保留反向代理路径前缀。
- 明确区分管理密钥和模型 API key。
- 支持自定义 fetch、headers、默认超时和单次 AbortSignal。
- 为参数、请求体、响应与错误编写类型，保留原生 JSON 字段及响应语义。
- 正确处理 JSON、文本、YAML、上传下载和空响应。
- HTTP 错误提供状态码及原始响应体；网络错误、超时和主动取消可区分。
- 动态配置节点返回 JSON 值，已知配置提供明确类型，扩展字段使用 JSON 值或 unknown 表达。
- 模型推理提供原生地址，支持现有 SDK 接入。

## 接口覆盖及版本策略

在 `docs/api-coverage.md` 逐项记录 HTTP 方法、路径、文档链接、源码路由与 handler、参数、响应、错误、client 方法、测试及完成状态。

文档描述契约，固定版本实现核实行为；差异显式记录并以支持版本做契约验证。包版本与 CPA 版本分别记录，升级时检查接口及配置变化，维护兼容矩阵。

参考资料：

- https://github.com/router-for-me/CLIProxyAPI
- https://help.router-for.me/management/apiv8
- https://help.router-for.me/management/api
- https://help.router-for.me/configuration/options

## 建议目录

```text
src/
  index.ts
  client/
    index.ts
    transport.ts
    errors.ts
    types/
    resources/
  server/
    index.ts
    binary.ts
    config.ts
    process.ts
    readiness.ts
    types.ts
packages/                 # 各平台 npm 包的清单和组装配置
scripts/                  # 固定版本构建、产物校验、npm 包组装
docs/
  api-coverage.md
  compatibility.md
examples/
tests/
```

优先使用标准 Fetch 和 Node 标准库，仅为确有必要的能力引入依赖，例如 YAML 序列化。

## 实施顺序

- [x] 固定 CPA 版本，盘点全部原生管理路由、CLI 参数、配置格式和就绪检测方式。（v8.0.43，见 `docs/api-coverage.md`）
- [x] 确认完整平台矩阵、CGO/插件差异及各目标的测试方式。（见 `docs/compatibility.md`）
- [x] 实现 client 传输层、错误和资源方法，完成接口覆盖表。
- [x] 实现配置管理、进程启动、就绪检测、日志、退出及清理。
- [x] 建立官方源码编译及各平台二进制 npm 包组装流水线。（脚本已本地验证；全矩阵 CI 待首次运行）
- [ ] 完成真实 CPA 契约验证及 Node/Bun 安装使用验证。（linux-x64 glibc/musl 已本地验证；其他平台由 release workflow 验证，待首次运行）
- [x] 完成文档、示例、兼容矩阵及发布流水线。（发布需配置 npm `environment` 与 `NPM_TOKEN`）

## 验证和验收

- 模拟 HTTP 验证 client 的路径、编码、参数、鉴权、响应格式、文件传输及错误。
- 真实 CPA 配合假上游验证配置热更新、凭据操作、鉴权及流式调用。
- OAuth 使用模拟服务执行 CI 测试，真实账号授权提供手动验证步骤。
- 验证端口占用、启动超时、取消、进程异常退出、重复停止及清理。
- 各平台编译成功，并明确区分原生运行测试与交叉编译验证。
- 对 npm pack 产物在临时项目中真实安装，验证平台包自动选择及安装后直接启动。
- 类型检查、测试、打包内容及许可证通过；仅依赖实现原生 CPA 封装所需的组件。

完成标准：用户安装 npm 包即可启动对应平台的官方 CPA，或连接已有实例，通过带类型的手写 client 调用支持版本的原生管理 API，平台二进制随 npm 自动安装。
