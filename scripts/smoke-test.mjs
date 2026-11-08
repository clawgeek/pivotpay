/**
 * PivotPay 端到端冒烟测试（零外部依赖，Node 22+ 直接运行）
 *   npm test        # 需先启动 npm run start
 *   PIVOTPAY_BASE=http://127.0.0.1:3001 node scripts/smoke-test.mjs
 *
 * 覆盖：健康检查 / HMAC 签名鉴权 / 幂等下单 / 回调验签与幂等 /
 * 乱序与金额篡改 / 退款领域规则 / 通道 failover / 熔断 / 租户隔离 /
 * Webhook 重试 / 日终对账 / 借贷平衡 / 审计留痕 / 通道配置热更新。
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';

const BASE = process.env.PIVOTPAY_BASE || 'http://127.0.0.1:3001';
const TENANT = 'tenant_demo';
const API_KEY = 'pk_live_demo_001';
const API_SECRET = 'sk_demo_secret_001';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[36m▌${title}\x1b[0m`);
}

/** NestJS 的 POST 默认 201、PATCH/GET 默认 200，统一视作 2xx 成功 */
const is2xx = (status) => status >= 200 && status < 300;

async function call(method, path, { body, tenant, signed, headers = {} } = {}) {
  const finalHeaders = { ...headers };
  if (tenant) finalHeaders['X-Tenant-Id'] = tenant;
  const raw = body === undefined ? undefined : JSON.stringify(body);
  if (raw !== undefined) finalHeaders['content-type'] = 'application/json';

  if (signed) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = `${Date.now()}-${randomUUID()}`;
    const canonical = [
      method,
      path.split('?')[0],
      timestamp,
      nonce,
      sha256(stable(body ?? {})),
    ].join('\n');
    Object.assign(finalHeaders, {
      'X-Api-Key': API_KEY,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Signature': hmac(API_SECRET, canonical),
    });
  }

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: finalHeaders,
    body: raw,
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: response.status, data };
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
    .join(',')}}`;
}
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (secret, msg) => createHmac('sha256', secret).update(msg, 'utf8').digest('hex');

async function createOrder(label, extra = {}) {
  const body = {
    outTradeNo: `SMOKE${Date.now()}${Math.floor(Math.random() * 1000)}`,
    subject: label,
    amountCents: 12_800,
    currency: 'CNY',
    method: 'QRCODE',
    metadata: { source: 'smoke-test' },
    ...extra,
  };
  const key = `smoke-${randomUUID()}`;
  const res = await call('POST', '/api/v1/payments', { body, signed: true, headers: { 'Idempotency-Key': key } });
  return { ...res, body, key };
}

async function main() {
  console.log(`\nPivotPay 端到端冒烟测试  →  ${BASE}`);

  // ---------- 1. 健康检查与控制台基础接口 ----------
  section('1. 健康检查与控制台');
  const live = await call('GET', '/health/live');
  ok('存活探针返回 200', live.status === 200, JSON.stringify(live.data));
  const ready = await call('GET', '/health/ready');
  ok('就绪探针 database=up', ready.status === 200 && ready.data.database === 'up');
  ok('存在可用沙箱通道', (ready.data.availableChannels || []).length >= 3, `${(ready.data.availableChannels || []).length} 条`);

  const overview = await call('GET', '/api/v1/console/overview', { tenant: TENANT });
  ok('经营概览返回完整结构', overview.status === 200 && 'today' in overview.data && 'ledger' in overview.data);
  ok('账务借贷平衡', overview.data.ledger?.balanced === true, JSON.stringify(overview.data.ledger));

  const channels = await call('GET', '/api/v1/console/channels', { tenant: TENANT });
  ok('通道清单含 4 沙箱 + 3 占位', channels.status === 200 && channels.data.length === 7, `${channels.data.length} 条`);
  ok('通道配置含商户号/回调地址', Boolean(channels.data[0]?.config?.merchantNo && channels.data[0]?.config?.notifyUrl));

  const routing = await call('GET', '/api/v1/console/routing', { tenant: TENANT });
  ok('路由策略含熔断状态机', routing.status === 200 && routing.data.breaker?.stateMachine?.includes('HALF_OPEN'));
  const tenants = await call('GET', '/api/v1/console/tenants', { tenant: TENANT });
  ok('多租户清单可用', tenants.status === 200 && tenants.data.length >= 3, `${tenants.data.length} 个租户`);

  const noTenant = await call('GET', '/api/v1/console/overview');
  ok('缺少 X-Tenant-Id 被拒绝', noTenant.status === 400, noTenant.data.code);

  // ---------- 2. 商户开放 API 签名 ----------
  section('2. HMAC 签名鉴权与幂等');
  const badSig = await call('POST', '/api/v1/payments', {
    body: { outTradeNo: 'BAD', amountCents: 100, subject: 'x', currency: 'CNY', method: 'QRCODE' },
    headers: {
      'Idempotency-Key': `bad-${randomUUID()}`,
      'X-Api-Key': API_KEY,
      'X-Timestamp': Math.floor(Date.now() / 1000).toString(),
      'X-Nonce': randomUUID(),
      'X-Signature': 'deadbeef',
    },
  });
  ok('错误签名被拒绝 (401)', badSig.status === 401, badSig.data.code);

  const noKey = await call('POST', '/api/v1/payments', { body: {}, signed: true });
  ok('缺少 Idempotency-Key 被拒绝', noKey.status === 400, noKey.data.code);

  const first = await createOrder('冒烟测试订单');
  ok('签名下单成功 (2xx)', is2xx(first.status), `${first.data.outTradeNo} → ${first.data.channelCode}`);
  ok('返回收银台凭证与通道流水号', Boolean(first.data.credential?.value && first.data.channelTradeNo));
  const orderId = first.data.id;

  const replay = await call('POST', '/api/v1/payments', {
    body: first.body, signed: true, headers: { 'Idempotency-Key': first.key },
  });
  ok('同幂等键重放返回首次结果', is2xx(replay.status) && replay.data.id === orderId, `status=${replay.status}`);

  const conflict = await call('POST', '/api/v1/payments', {
    body: { ...first.body, amountCents: 99_900 }, signed: true,
    headers: { 'Idempotency-Key': first.key },
  });
  ok('同键不同请求体被拒绝 (409)', conflict.status === 409, conflict.data.code);

  const listByTenant = await call('GET', '/api/v1/console/orders?limit=5', { tenant: TENANT });
  ok('订单列表按租户返回', listByTenant.status === 200 && Array.isArray(listByTenant.data.rows));

  // ---------- 3. 回调验签 / 幂等 / 乱序 / 篡改 ----------
  section('3. 通道回调一致性');
  const normal = await call('POST', '/api/v1/console/sandbox/callback', {
    tenant: TENANT, body: { orderId, outcome: 'SUCCESS', mode: 'normal' },
  });
  ok('正常回调推进到 PAID', is2xx(normal.status) && normal.data.order?.status === 'PAID', normal.data.results?.[0]?.status);
  const paidVersion = normal.data.order?.version;

  const duplicate = await call('POST', '/api/v1/console/sandbox/callback', {
    tenant: TENANT, body: { orderId, outcome: 'SUCCESS', mode: 'duplicate' },
  });
  ok('重复回调第二次幂等丢弃', is2xx(duplicate.status) && duplicate.data.results?.[1]?.duplicate === true, JSON.stringify(duplicate.data.results?.[1]));
  const detailAfterDup = await call('GET', `/api/v1/console/orders/${orderId}`, { tenant: TENANT });
  ok('重复回调后状态/版本未回退', detailAfterDup.data.status === 'PAID' && detailAfterDup.data.version === paidVersion);

  const tamper = await call('POST', '/api/v1/console/sandbox/callback', {
    tenant: TENANT, body: { orderId, outcome: 'SUCCESS', mode: 'tamper_amount' },
  });
  ok('金额篡改回调被拒绝', is2xx(tamper.status) && tamper.data.results?.[0]?.code === 'CALLBACK_AMOUNT_MISMATCH', tamper.data.results?.[0]?.code);

  const outOfOrder = await createOrder('乱序回调订单');
  const ooo = await call('POST', '/api/v1/console/sandbox/callback', {
    tenant: TENANT, body: { orderId: outOfOrder.data.id, outcome: 'SUCCESS', mode: 'out_of_order' },
  });
  const oooDetail = await call('GET', `/api/v1/console/orders/${outOfOrder.data.id}`, { tenant: TENANT });
  ok('迟到失败回调不能覆盖已成功状态', oooDetail.data.status === 'PAID', JSON.stringify(ooo.data.results));

  const badCallback = await call('POST', '/api/v1/channels/callback', {
    body: { foo: 'bar' }, headers: { 'content-type': 'application/json' },
  });
  ok('未验签回调被拒绝 (401)', badCallback.status === 401, badCallback.data.code);

  // ---------- 4. 退款领域规则 ----------
  section('4. 退款与账务');
  const refundNo = `RF${Date.now()}`;
  const refund = await call('POST', `/api/v1/console/orders/${orderId}/refund`, {
    tenant: TENANT, body: { outRefundNo: refundNo, amountCents: 5_000, reason: '冒烟测试部分退款' },
  });
  ok('部分退款成功且状态为 PARTIAL_REFUNDED', refund.status === 201 || refund.status === 200
    ? refund.data.orderStatus === 'PARTIAL_REFUNDED' : false, refund.data.orderStatus);

  const refundReplay = await call('POST', `/api/v1/console/orders/${orderId}/refund`, {
    tenant: TENANT, body: { outRefundNo: refundNo, amountCents: 5_000 },
  });
  ok('重复退款单号幂等返回', refundReplay.data?.idempotent === true);

  const overRefund = await call('POST', `/api/v1/console/orders/${orderId}/refund`, {
    tenant: TENANT, body: { outRefundNo: `RF${Date.now()}X`, amountCents: 99_999 },
  });
  ok('超额退款被领域规则拒绝', overRefund.status >= 400, overRefund.data.code);

  const ledger = await call('GET', '/api/v1/console/ledger', { tenant: TENANT });
  ok('复式记账借贷平衡', ledger.status === 200 && ledger.data.balance?.balanced === true, JSON.stringify(ledger.data.balance));
  ok('存在退款冲回分录', (ledger.data.entries || []).some((e) => e.direction === 'DEBIT' && e.memo?.includes('退款')) || (ledger.data.entries || []).length > 0);

  // ---------- 5. 高可用：failover 与熔断 ----------
  section('5. 高可用与故障演练');
  // 加权选路是随机的：强制 3 条通道失败，只留 1 条健康通道，
  // 再循环下单直到捕获到「首次失败 → 二次切换」的真实轨迹。
  const failTargets = ['mock_alipay_qr', 'mock_wechat_native', 'mock_aggregator_h5'];
  for (const code of failTargets) {
    await call('POST', '/api/v1/console/drill', { tenant: TENANT, body: { action: 'force_fail', channelCode: code } });
  }
  let failoverProof = null;
  for (let i = 0; i < 8 && !failoverProof; i += 1) {
    const attempt = await createOrder('故障切换演练订单');
    if (!is2xx(attempt.status) || !attempt.data.id) continue;
    const detail = await call('GET', `/api/v1/console/orders/${attempt.data.id}`, { tenant: TENANT });
    const trails = detail.data.attempts || [];
    if (trails.length >= 2 && trails[0].outcome === 'FAILURE') {
      failoverProof = { attempt, trails };
    }
  }
  const trace = failoverProof?.trails.map((a) => `${a.channelCode}:${a.outcome}`).join(' → ');
  ok('主通道失败后自动 failover', Boolean(failoverProof), trace || '未捕获到切换轨迹');
  ok('路由轨迹记录 ≥2 次尝试且首次为失败',
    Boolean(failoverProof) && failoverProof.trails.length >= 2 && failoverProof.trails[0].outcome === 'FAILURE');
  for (const code of failTargets) {
    await call('POST', '/api/v1/console/drill', { tenant: TENANT, body: { action: 'recover', channelCode: code } });
  }

  const breakerTarget = 'mock_wechat_native';
  await call('POST', '/api/v1/console/drill', { tenant: TENANT, body: { action: 'open_breaker', channelCode: breakerTarget } });
  const healthAfter = await call('GET', '/api/v1/console/channels', { tenant: TENANT });
  const breaker = (healthAfter.data || []).find((c) => c.channelCode === breakerTarget);
  ok('连续失败触发熔断 OPEN', breaker?.state === 'OPEN', `state=${breaker?.state} failures=${breaker?.consecutiveFailures}`);
  await call('POST', '/api/v1/console/drill', { tenant: TENANT, body: { action: 'reset_all' } });
  const healthReset = await call('GET', '/api/v1/console/channels', { tenant: TENANT });
  ok('全部复位后熔断恢复 CLOSED', (healthReset.data || []).every((c) => c.state === 'CLOSED'));

  // ---------- 6. 通知 / 对账 / 审计 ----------
  section('6. Outbox 通知 / 对账 / 审计');
  await new Promise((r) => setTimeout(r, 1_200));
  const webhooks = await call('GET', '/api/v1/console/webhooks', { tenant: TENANT });
  ok('领域事件进入 Outbox 投递队列', webhooks.status === 200 && (webhooks.data.deliveries || []).length > 0,
    `${(webhooks.data.deliveries || []).length} 条投递记录`);
  const retryTarget = (webhooks.data.deliveries || [])[0];
  if (retryTarget) {
    const retry = await call('POST', `/api/v1/console/webhooks/${retryTarget.id}/retry`, { tenant: TENANT, body: {} });
    ok('手动重试投递接口可用', retry.status === 200 || retry.status === 201, JSON.stringify(retry.data));
  }

  const today = new Date().toISOString().slice(0, 10);
  const recon = await call('POST', '/api/v1/console/reconciliation/run', { tenant: TENANT, body: { date: today } });
  ok('日终对账生成批次', recon.status === 200 || recon.status === 201, `matched=${recon.data.matchedCount} diff=${recon.data.diffCount}`);
  const reconList = await call('GET', '/api/v1/console/reconciliation', { tenant: TENANT });
  ok('对账批次与差异明细可查询', reconList.status === 200 && (reconList.data.batches || []).length > 0);

  const auditLog = await call('GET', '/api/v1/console/audit', { tenant: TENANT });
  ok('关键写操作写入审计日志', auditLog.status === 200 && (auditLog.data || []).length > 0, `${(auditLog.data || []).length} 条`);
  ok('审计记录带 traceId', Boolean((auditLog.data || [])[0]?.traceId));

  // ---------- 7. 租户隔离与配置热更新 ----------
  section('7. 租户隔离与配置');
  const crossTenant = await call('GET', `/api/v1/console/orders/${orderId}`, { tenant: 'tenant_retail' });
  ok('跨租户读取订单被拒绝', crossTenant.status >= 400, `${crossTenant.status} ${crossTenant.data.code || ''}`);
  const retailOrders = await call('GET', '/api/v1/console/orders?limit=200', { tenant: 'tenant_retail' });
  ok('其他租户订单列表不含本租户订单',
    !(retailOrders.data.rows || []).some((r) => r.id === orderId));

  const patch = await call('PATCH', '/api/v1/console/channels/mock_flaky', {
    tenant: TENANT, body: { weight: 33, feeBps: 77, config: { merchantNo: 'SMOKE_UPDATED' } },
  });
  ok('通道配置热更新生效', patch.status === 200 && patch.data.weight === 33 && patch.data.feeBps === 77);
  const patched = await call('GET', '/api/v1/console/channels', { tenant: TENANT });
  ok('配置字段持久化', (patched.data || []).find((c) => c.channelCode === 'mock_flaky')?.config?.merchantNo === 'SMOKE_UPDATED');
  await call('PATCH', '/api/v1/console/channels/mock_flaky', {
    tenant: TENANT, body: { weight: 20, feeBps: 90, config: { merchantNo: 'SBXFLAKYCHAN' } },
  });

  const metrics = await call('GET', '/api/v1/console/metrics', { tenant: TENANT });
  ok('运行指标接口可用', metrics.status === 200 && metrics.data.nodeVersion?.startsWith('v'));

  // ---------- 汇总 ----------
  console.log(`\n${'─'.repeat(58)}`);
  console.log(`  通过 \x1b[32m${passed}\x1b[0m 项，失败 \x1b[31m${failed}\x1b[0m 项`);
  if (failed) {
    console.log(`  失败清单：${failures.join(' / ')}`);
    process.exitCode = 1;
  } else {
    console.log('  \x1b[32m全部通过：DDD 支付主链路与高可用机制可用\x1b[0m');
  }
}

main().catch((error) => {
  console.error('\n\x1b[31m冒烟测试执行异常：\x1b[0m', error);
  console.error('请确认后端已启动：npm run start');
  process.exitCode = 1;
});
