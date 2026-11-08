# PivotPay REST API 参考

Base URL：`http://127.0.0.1:3001`（单端口形态同时托管 UI）。所有请求/响应均为 `application/json; charset=utf-8`。

## 一、鉴权方式

| 类别 | 前缀 | 鉴权 |
| --- | --- | --- |
| 商户开放 API | `/api/v1/payments`、`/api/v1/refunds` | HMAC-SHA256 签名头（见下） |
| 通道回调入口 | `/api/v1/channels/callback` | 通道侧 HMAC 签名（沙箱固定密钥） |
| SaaS 控制台 API | `/api/v1/console/*` | `X-Tenant-Id: tenant_demo`（演示用，生产换 SSO + RBAC） |
| 健康检查 | `/health/*` | 无 |
| 沙箱 Webhook 接收端 | `/api/v1/test/webhook-receiver` | 无（校验签名由商户侧负责） |

### 商户 API 签名规范

```
canonical = METHOD + "\n"
          + PATH(不含 query) + "\n"
          + X-Timestamp(unix 秒) + "\n"
          + X-Nonce(随机唯一) + "\n"
          + SHA256_HEX(stableStringify(body))

X-Signature = HMAC_SHA256_HEX(apiSecret, canonical)
```

`stableStringify`：对象键按字典序排序，忽略 `undefined`，递归序列化；数组保序；标量走 `JSON.stringify`。前后端实现完全一致（`shared/kernel.ts` ↔ `web/src/api/client.ts`）。

服务端校验：签名常量时间比较、时间戳 ±300 秒、nonce 5 分钟内不可重放、API Key 有效且应用状态 active。

**必需头**：`X-Api-Key`、`X-Timestamp`、`X-Nonce`、`X-Signature`；下单另需 `Idempotency-Key`。

## 二、商户开放 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/payments` | 创建支付订单（幂等） |
| GET | `/api/v1/payments?status=&channelCode=&keyword=&limit=&offset=` | 查询订单列表 |
| GET | `/api/v1/payments/:id` | 订单详情（含 `attempts` 路由轨迹） |
| POST | `/api/v1/payments/:id/refund` | 发起退款 |
| POST | `/api/v1/payments/:id/close` | 关单 |
| GET | `/api/v1/refunds` | 退款列表 |
| POST | `/api/v1/channels/callback` | 通道异步回调（验签） |

**POST /api/v1/payments**

```json
{
  "outTradeNo": "ORDER20261108001",
  "subject": "云枢平台 · 测试商品",
  "amountCents": 12800,
  "currency": "CNY",
  "method": "QRCODE",
  "notifyUrl": "https://merchant.example.com/notify",
  "metadata": { "source": "cashier" },
  "ttlMinutes": 15
}
```

`method` ∈ `QRCODE | H5 | JSAPI | WEB`；金额单位为**分**（整数）。响应：

```json
{
  "id": "pay_xxx", "outTradeNo": "ORDER20261108001", "amountCents": 12800,
  "amountYuan": 128, "status": "PAYING", "method": "QRCODE",
  "channelCode": "mock_alipay_qr", "channelName": "沙箱 · 扫码钱包 A",
  "channelTradeNo": "MOCK-xxx",
  "credential": { "type": "QRCODE", "value": "weixin://wxpay/...", "expiresAt": "..." },
  "paidAt": null, "expiresAt": "...", "createdAt": "...", "version": 2
}
```

**POST /api/v1/payments/:id/refund**

```json
{ "outRefundNo": "RF20261108001", "amountCents": 5000, "reason": "用户申请退款" }
```

响应含 `orderStatus`（`PARTIAL_REFUNDED` / `REFUNDED`）与 `totalRefundedCents`；重复 `outRefundNo` 返回 `idempotent: true`。

**curl 示例**（签名部分用 Node 生成，见 `scripts/smoke-test.mjs`）：

```bash
curl -X POST http://127.0.0.1:3001/api/v1/payments \
  -H 'content-type: application/json' \
  -H 'X-Api-Key: pk_live_demo_001' \
  -H 'X-Timestamp: <unix秒>' -H 'X-Nonce: <随机值>' \
  -H 'X-Signature: <HMAC-SHA256 hex>' \
  -H 'Idempotency-Key: order-001' \
  -d '{"outTradeNo":"ORDER001","subject":"测试","amountCents":12800,"currency":"CNY","method":"QRCODE"}'
```

## 三、SaaS 控制台 API

全部需要 `X-Tenant-Id`。

| 方法 | 路径 | 返回要点 |
| --- | --- | --- |
| GET | `/api/v1/console/overview` | 今日交易额/成功率/通道/通知/账务/7 日趋势/最近订单 |
| GET | `/api/v1/console/orders` | 订单分页列表（同商户 API 查询参数） |
| GET | `/api/v1/console/orders/:id` | 详情 + 路由轨迹 |
| POST | `/api/v1/console/orders/:id/refund` | 控制台退款 |
| POST | `/api/v1/console/orders/:id/close` | 控制台关单 |
| GET | `/api/v1/console/refunds` | 退款列表 |
| GET | `/api/v1/console/channels` | 7 条通道 + 健康分 / 熔断 / 配置 |
| PATCH | `/api/v1/console/channels/:code` | `{enabled, weight, feeBps, config}`，即时生效 |
| GET | `/api/v1/console/routing` | 路由策略、熔断器参数、候选通道与有效权重 |
| POST | `/api/v1/console/drill` | 故障注入，见下 |
| POST | `/api/v1/console/sandbox/callback` | 生成带真实通道签名的回调并投递 |
| GET | `/api/v1/console/webhooks` | 投递记录 + 统计 |
| POST | `/api/v1/console/webhooks/:id/retry` | 手动重新入队 |
| GET | `/api/v1/console/reconciliation` | 批次 + 差异明细 |
| POST | `/api/v1/console/reconciliation/run` | `{date: "YYYY-MM-DD"}` |
| GET | `/api/v1/console/ledger` | 分录列表 + 借贷平衡 |
| GET | `/api/v1/console/tenants` | 租户与接入应用 |
| GET | `/api/v1/console/credentials` | 当前租户凭据（沙箱演示用） |
| GET | `/api/v1/console/audit` | 审计日志 |
| GET | `/api/v1/console/metrics` | 运行时指标、订单状态分布、故障标志 |

**POST /api/v1/console/drill**

```json
{ "action": "force_fail", "channelCode": "mock_alipay_qr", "value": 800 }
```

`action` 取值：

| action | 效果 |
| --- | --- |
| `force_fail` / `recover` | 目标通道下单恒定失败 / 恢复 |
| `open_breaker` / `reset_breaker` | 连续 3 次失败触发 OPEN / 复位 |
| `reset_all` | 清除全部故障标志与熔断状态 |
| `force_webhook_fail` | 通知投递持续失败（`value: 0` 关闭） |
| `receiver_down` | Webhook 接收端不可达（`value: 0` 关闭） |
| `extra_latency` | 注入通道延迟毫秒数 |

**POST /api/v1/console/sandbox/callback**

```json
{ "orderId": "pay_xxx", "outcome": "SUCCESS", "mode": "duplicate" }
```

`mode` ∈ `normal | duplicate | out_of_order | tamper_amount`。返回 `results[]`（每次投递的 `accepted` / `duplicate` / `status` / `code`）与最新订单快照。

## 四、健康检查

| 路径 | 说明 |
| --- | --- |
| `GET /health/live` | `{status:"ok", at}` |
| `GET /health/ready` | `{status:"ready"\|"degraded", database, availableChannels[], at}` |
| `GET /health/metrics` | uptime、Node 版本、各状态订单数、熔断状态、内存、故障标志 |

## 五、错误响应

```json
{ "ok": false, "code": "REFUND_EXCEEDS_PAID", "message": "累计退款金额超出实付金额" }
```

常见业务码：

| code | HTTP | 含义 |
| --- | --- | --- |
| `UNAUTHORIZED` / `INVALID_SIGNATURE` | 401 | 签名头缺失或校验失败 |
| `SIGNATURE_EXPIRED` / `REPLAY_DETECTED` | 401 | 时间戳超窗 / nonce 重放 |
| `INVALID_CHANNEL_SIGNATURE` | 401 | 通道回调验签失败 |
| `TENANT_HEADER_REQUIRED` | 400 | 缺少 X-Tenant-Id |
| `TENANT_MISMATCH` | 403 | 跨租户访问 |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | 缺少幂等键 |
| `IDEMPOTENCY_CONFLICT` | 409 | 同键不同请求体 |
| `REQUEST_IN_PROGRESS` | 409 | 相同请求处理中 |
| `ILLEGAL_STATE_TRANSITION` | 409 | 订单状态机非法迁移 |
| `CALLBACK_OUT_OF_ORDER` | 409 | 迟到回调试图覆盖终态 |
| `CALLBACK_AMOUNT_MISMATCH` / `CALLBACK_CURRENCY_MISMATCH` | 422 | 回调金额/币种与订单不符 |
| `REFUND_EXCEEDS_PAID` | 422 | 超额退款 |
| `ORDER_NOT_REFUNDABLE` / `ORDER_ALREADY_PAID` / `ORDER_EXPIRED` | 409 | 订单不可操作 |
| `ORDER_NOT_FOUND` / `CHANNEL_NOT_FOUND` | 404 | 资源不存在 |
| `CHANNEL_NOT_CONFIGURED` | 503 | 持牌通道占位未配置 |
| `INVALID_AMOUNT` / `INVALID_OUT_TRADE_NO` / `INVALID_WEIGHT` / `INVALID_FEE_RATE` | 400 | 参数校验 |
| `UNKNOWN_DRILL` / `CHANNEL_REQUIRED` | 400 | 演练动作非法 |

> NestJS 的 POST 默认返回 **201**，PATCH/GET 返回 **200**，请以 2xx 判定成功（冒烟测试中的 `is2xx` 即为此）。

## 六、端到端验证

```bash
npm start          # 终端 A
npm test           # 终端 B，43 项断言
```

覆盖：探针 / 概览 / 7 通道 / 多租户 / 错误签名 / nonce / 幂等重放与冲突 / 回调成功 / 重复回调 / 金额篡改 / 乱序回调 / 未验签回调 / 部分退款 / 重复退款 / 超额退款 / 借贷平衡 / failover 轨迹 / 熔断开关 / Webhook 重试 / 日终对账 / 审计 traceId / 租户隔离 / 通道配置热更新 / 运行指标。
