# 云枢支付 PivotPay

> 基于 **DDD（领域驱动设计）** 的高可用云端支付平台 · SaaS 多租户控制台
> NestJS 10 + TypeScript 全栈 · React 19 + `meta/astryx` 设计系统 · Node 22 内置 SQLite
>
> **GitHub**：https://github.com/clawgeek/pivotpay

一个可完整跑通的支付平台教学/毕设级实现：从商户入驻、HMAC 签名下单、加权健康度通道路由、三态熔断与 failover、通道回调验签与幂等、复式记账、Outbox 异步通知、日终对账，到 SaaS 多租户控制台与故障演练台。**全链路使用模拟通道，不涉及任何真实资金。**

---

## 一、参考来源与边界

三个参考视频（B 站「老黑学堂」聚合支付系列）抽象出的业务内核：

| 视频 | 可借鉴的工程要素 | 落地位置 |
| --- | --- | --- |
| 聚合支付 / 多通道与回调稳定性 | 多通道路由、异步回调、回调幂等与补单 | `routing` / `payment` / `notification` 上下文 |
| 汇付斗拱通道配置 / 支付网关 | 商户号、密钥、费率、回调地址、通道开关 | 「通道配置」页 + `ChannelAdapter` 防腐层 |
| 收款接入与通道选型 | 收银台二维码凭证、通道能力差异 | 「支付沙箱」页 + `ChargeCredential` |

**明确不实现**：个人收款码免签监听、异地收款、发卡通道、二清资金池等规避支付监管的玩法。持牌通道（支付宝 / 微信支付 / 银联）仅保留适配器接口与配置位，默认停用、无真实密钥、不发起真实请求。详见 [docs/compliance.md](docs/compliance.md)。

> **UI 基座说明**：用户给出的 `github.com/astryx/astryx` 实际返回 404（`AstryX` 为无关的个人老账号）。经确认后采用 **Meta 开源的 `github.com/meta/astryx`**（React 19 设计系统，MIT，150+ 组件，官方提供 table pages / form wizards / navigation patterns 后台范式），通过 npm 包 `@astryxdesign/core@0.7.11` + `@astryxdesign/theme-neutral@0.7.11` 引入，用于构建 SaaS 控制台。本项目的源码不含该设计系统源码，仅作为 npm 依赖引用。

---

## 二、快速启动

环境要求：**Node.js ≥ 22.5**（使用内置 `node:sqlite`）、npm ≥ 10。无需 Docker、无需外部数据库。

```bash
cd pivotpay
npm install

# 方式 A：开发模式（前端热更新，两条命令）
npm run dev:api          # 编译并启动后端 http://127.0.0.1:3001
npm run dev:web          # Vite 开发服务器 http://127.0.0.1:5178

# 方式 B：单端口生产形态（推荐演示 / 答辩）
npm run build            # 编译后端 + 构建前端
npm start                # http://127.0.0.1:3001 同时托管 UI 与 API
```

`npm run dev` 可一键并行启动前后端（`concurrently`）。

**验证**

```bash
npm test                 # 43 项端到端冒烟测试（需后端已启动）
curl http://127.0.0.1:3001/health/ready
```

首次启动自动建库并写入确定性种子数据：3 个租户 / 3 组商户凭据 / 7 条通道 / 42 笔历史订单及配套分录。数据库文件：`data/pivotpay.db`（WAL 模式，删除后重启即可重置）。

**演示租户与凭据**

| 租户 | X-Tenant-Id | API Key | API Secret |
| --- | --- | --- | --- |
| 云枢演示商户 | `tenant_demo` | `pk_live_demo_001` | `sk_demo_secret_001` |
| 星河零售 | `tenant_retail` | `pk_live_retail_002` | `sk_retail_secret_002` |
| 蓝鲸订阅平台 | `tenant_saas` | `pk_live_saas_003` | `sk_saas_secret_003` |

登录后可在右上角切换租户，订单 / 账务 / 通知 / 对账数据整体切换。

---

## 三、功能地图（10 个页面）

| 页面 | 能力 |
| --- | --- |
| 经营驾驶舱 | 今日交易额、成功率、7 日趋势、通道健康度、账务平衡、最近交易（15s 刷新） |
| 支付订单 | 状态/通道/关键字筛选、详情、路由轨迹、部分退款、关单 |
| 支付沙箱 | 浏览器 Web Crypto 真实计算 HMAC-SHA256 签名调用商户开放 API；二维码收银台；正常/重复/乱序/篡改金额回调演练 |
| 通道配置 | 4 沙箱 + 3 占位通道；商户号 / 密钥 / 回调地址 / 费率 / 权重 / 开关配置弹窗 |
| 路由与熔断 | 有效权重可视化、三态熔断器、8 类故障注入、一键 failover 演练并展示真实切换轨迹 |
| 回调通知 | Outbox 投递记录、指数退避、死信、手动重试 |
| 日终对账 | 按业务日期运行对账、批次留痕、三类差异明细 |
| 账务流水 | 复式分录、借贷平衡校验、科目映射 |
| 商户与密钥 | 多租户切换、接入应用凭据、租户隔离说明 |
| 审计日志 | 关键写操作全量留痕、Trace ID、事件详情 JSON |

---

## 四、目录结构

```
pivotpay/
├── apps/
│   ├── api/                          # NestJS 后端（DDD 四层）
│   │   ├── src/shared/kernel.ts      # 共享内核：AggregateRoot / Entity / ValueObject / Money / DomainEvent
│   │   ├── src/contexts/             # 限界上下文
│   │   │   ├── tenant/               #   租户与接入应用
│   │   │   ├── payment/              #   PaymentOrder 聚合根 + 状态机
│   │   │   ├── channel/              #   ChannelAdapter 端口（ACL）+ 7 个适配器
│   │   │   ├── routing/              #   加权路由 + 三态熔断
│   │   │   ├── notification/         #   Outbox + Webhook 退避派发
│   │   │   ├── ledger/               #   复式记账
│   │   │   └── reconciliation/       #   日终对账
│   │   ├── src/application/          # 用例编排：payment.service / admin.service
│   │   ├── src/infrastructure/       # SQLite、种子、审计、运行时故障标志
│   │   └── src/interface/            # HTTP 控制器、HMAC 鉴权、异常过滤器、健康检查
│   └── web/                          # React 19 + Vite + Astryx
│       ├── src/api/client.ts         # API 客户端 + Web Crypto HMAC 签名
│       ├── src/components/ui.tsx     # 基于 Astryx 的通用组件封装
│       └── src/pages/                # 10 个业务页面
├── packages/shared/src/index.ts      # 前后端共享的 API 契约类型（type-only）
├── scripts/smoke-test.mjs            # 43 项端到端测试
└── docs/                             # DDD 设计 / API 清单 / 高可用 / 合规
```

---

## 五、关键技术点

- **DDD 分层**：领域层不依赖任何框架与第三方 SDK；`PaymentOrder` 聚合根封装状态机与业务不变量（超额退款、终态不可回退）；端口 `ChannelAdapter` 作为防腐层，新增真实通道只需实现一个接口。
- **幂等**：下单用 `Idempotency-Key + 请求体哈希`（同键不同体返回 409）；回调用 `channel_code + channel_trade_no + outcome` 去重；金额/币种核对**先于**去重，避免伪造报文被误判成重复回调。
- **高可用**：`weight × healthScore` 加权选路；CLOSED → OPEN → HALF_OPEN 三态熔断（失败阈值 3，冷却 30s）；最多 2 次尝试，失败通道当次排除；后台定时器驱动半开探测。
- **一致性**：订单状态、复式分录、Outbox 事件在**同一数据库事务**提交，杜绝「支付成功但通知丢失」；Webhook 按 1/2/4/8/16s 退避，超限进死信。
- **安全**：商户 API HMAC-SHA256 + 5 分钟时间戳窗口 + nonce 防重放；通道回调独立密钥验签；控制台与订单详情强制租户隔离（跨租户返回 403）。
- **高可用部署边界**：当前为单进程 SQLite 教学形态，生产化替换点见 [docs/ddd-design.md](docs/ddd-design.md#八生产化演进路径)。

---

## 六、文档

| 文档 | 内容 |
| --- | --- |
| [docs/ddd-design.md](docs/ddd-design.md) | 限界上下文图、聚合与领域事件、状态机、高可用设计、生产化演进 |
| [docs/api-reference.md](docs/api-reference.md) | 全量 REST 接口、签名规范、错误码、curl 示例 |
| [docs/compliance.md](docs/compliance.md) | 合规边界与明确不实现的能力 |

---

## 七、技术栈与许可

NestJS 10 · TypeScript 5.7 · React 19 · Vite 6 · `@astryxdesign/core` 0.7.11（MIT，来自 `meta/astryx`）· `node:sqlite` · `@stylexjs/stylex` · `concurrently`。无外部服务依赖，无真实资金接口。
