import { db, type Row } from '../infrastructure/database';
import { nowIso, uid } from '../shared/kernel';
import { audit } from '../infrastructure/audit';
import { postPaymentEntries } from '../contexts/ledger/ledger.service';
import type { PaymentOrderSnapshot } from '../contexts/payment/payment-order.domain';

const RECEIVER = 'http://127.0.0.1:3001/api/v1/test/webhook-receiver';

interface SeedChannel {
  code: string;
  name: string;
  kind: string;
  mode: string;
  enabled: number;
  weight: number;
  feeBps: number;
  methods: string[];
  description: string;
  sortOrder: number;
}

/** 4 个沙箱模拟通道 + 3 个持牌通道占位（默认停用、不发真实请求） */
const CHANNELS: SeedChannel[] = [
  {
    code: 'mock_alipay_qr',
    name: '沙箱 · 扫码钱包 A',
    kind: 'wallet',
    mode: 'mock',
    enabled: 1,
    weight: 100,
    feeBps: 60,
    methods: ['QRCODE'],
    description: '对标视频中的聚合扫码通道，二维码收银台，沙箱模拟',
    sortOrder: 1,
  },
  {
    code: 'mock_wechat_native',
    name: '沙箱 · 扫码钱包 B',
    kind: 'wallet',
    mode: 'mock',
    enabled: 1,
    weight: 90,
    feeBps: 60,
    methods: ['QRCODE', 'H5'],
    description: '对标原生扫码接口，支持二维码与 H5',
    sortOrder: 2,
  },
  {
    code: 'mock_aggregator_h5',
    name: '沙箱 · 聚合网关 H5',
    kind: 'aggregator',
    mode: 'mock',
    enabled: 1,
    weight: 70,
    feeBps: 80,
    methods: ['H5', 'WEB', 'JSAPI', 'QRCODE'],
    description: '对标汇付斗拱类聚合网关配置，全支付方式',
    sortOrder: 3,
  },
  {
    code: 'mock_flaky',
    name: '沙箱 · 故障演练通道',
    kind: 'aggregator',
    mode: 'mock',
    enabled: 1,
    weight: 20,
    feeBps: 55,
    methods: ['QRCODE', 'H5', 'WEB'],
    description: '高延迟高失败率，用于演示熔断、failover 与自动切换',
    sortOrder: 4,
  },
  {
    code: 'official_alipay',
    name: '支付宝开放平台（占位）',
    kind: 'wallet',
    mode: 'official',
    enabled: 0,
    weight: 0,
    feeBps: 60,
    methods: ['QRCODE', 'H5'],
    description: '需企业资质 + 官方应用私钥/平台公钥 + 备案回调域名',
    sortOrder: 5,
  },
  {
    code: 'official_wechatpay',
    name: '微信支付（占位）',
    kind: 'wallet',
    mode: 'official',
    enabled: 0,
    weight: 0,
    feeBps: 60,
    methods: ['QRCODE', 'JSAPI', 'H5'],
    description: '需企业资质 + 商户号 + API v3 密钥与证书',
    sortOrder: 6,
  },
  {
    code: 'official_unionpay',
    name: '银联全渠道（占位）',
    kind: 'bank',
    mode: 'official',
    enabled: 0,
    weight: 0,
    feeBps: 55,
    methods: ['WEB', 'H5'],
    description: '需收单机构资质 + 商户代码 + 签名证书',
    sortOrder: 7,
  },
];

interface SeedTenant {
  id: string;
  code: string;
  name: string;
  plan: string;
  appName: string;
  appId: string;
  apiKey: string;
  apiSecret: string;
}

const TENANTS: SeedTenant[] = [
  {
    id: 'tenant_demo',
    code: 'PIVOT-DEMO',
    name: '云枢演示商户',
    plan: 'enterprise',
    appName: '线上收银台',
    appId: 'app_demo_cashier',
    apiKey: 'pk_live_demo_001',
    apiSecret: 'sk_demo_secret_001',
  },
  {
    id: 'tenant_retail',
    code: 'PIVOT-RETAIL',
    name: '星河零售',
    plan: 'standard',
    appName: '门店 POS',
    appId: 'app_retail_pos',
    apiKey: 'pk_live_retail_002',
    apiSecret: 'sk_retail_secret_002',
  },
  {
    id: 'tenant_saas',
    code: 'PIVOT-SAAS',
    name: '蓝鲸订阅平台',
    plan: 'starter',
    appName: '订阅计费',
    appId: 'app_saas_billing',
    apiKey: 'pk_live_saas_003',
    apiSecret: 'sk_saas_secret_003',
  },
];

// 固定种子的线性同余发生器，保证每次初始化数据一致
let rngState = 20261108;
function rand(): number {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
}

function localDate(offsetDays: number): string {
  const d = new Date(Date.now() - offsetDays * 86_400_000);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/** 通道配置展示字段（对标教程中的「增加支付通道」弹窗：商户号 / 密钥 / 回调地址 / 结算周期） */
function channelConfig(channel: { code: string; mode: string }): Record<string, unknown> {
  return {
    mode: channel.mode,
    sandbox: channel.mode === 'mock',
    merchantNo: channel.mode === 'mock' ? `SBX${channel.code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-8)}` : '',
    apiKey: channel.mode === 'mock' ? `sandbox_key_${channel.code}` : '',
    notifyUrl: 'http://127.0.0.1:3001/api/v1/channels/callback',
    settleCycle: 'T+1',
  };
}

/** 幂等补齐：旧库若缺少展示字段，启动时自动合并，不覆盖用户已填写的值 */
function ensureChannelConfig(): void {
  const defaults = new Map(CHANNELS.map((c) => [c.code, channelConfig(c)]));
  for (const row of db.all<Row>('SELECT code, config_json FROM channel_defs')) {
    const code = String(row.code);
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(String(row.config_json || '{}')) as Record<string, unknown>;
    } catch {
      current = {};
    }
    const base = defaults.get(code) || {};
    const merged = { ...base, ...current };
    if (JSON.stringify(merged) !== JSON.stringify(current)) {
      db.run('UPDATE channel_defs SET config_json = ? WHERE code = ?', JSON.stringify(merged), code);
    }
  }
}

export function seedDatabase(): void {
  ensureChannelConfig();
  const row = db.get<Row>('SELECT COUNT(*) AS cnt FROM tenants');
  if (Number(row?.cnt || 0) > 0) return;

  db.transaction(() => {
    for (const tenant of TENANTS) {
      db.run(
        `INSERT INTO tenants (id, code, name, plan, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)`,
        tenant.id,
        tenant.code,
        tenant.name,
        tenant.plan,
        nowIso(),
      );
      db.run(
        `INSERT INTO merchant_apps
         (id, tenant_id, name, app_id, api_key, api_secret, webhook_url, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        tenant.appId,
        tenant.id,
        tenant.appName,
        tenant.appId,
        tenant.apiKey,
        tenant.apiSecret,
        RECEIVER,
        nowIso(),
      );
    }

    for (const channel of CHANNELS) {
      db.run(
        `INSERT INTO channel_defs
         (code, name, kind, mode, enabled, weight, fee_bps, methods, config_json, description, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        channel.code,
        channel.name,
        channel.kind,
        channel.mode,
        channel.enabled,
        channel.weight,
        channel.feeBps,
        JSON.stringify(channel.methods),
        JSON.stringify(channelConfig(channel)),
        channel.description,
        channel.sortOrder,
      );
      db.run(
        `INSERT INTO channel_health
         (channel_code, state, consecutive_failures, success_count, fail_count,
          ewma_latency_ms, opened_at, force_fail, updated_at)
         VALUES (?, 'CLOSED', 0, 0, 0, ?, NULL, 0, ?)`,
        channel.code,
        channel.mode === 'mock' ? 120 : 0,
        nowIso(),
      );
    }

    // 历史订单：每个租户 14 笔，近 7 天分布
    const statuses = [
      'PAID', 'PAID', 'PAID', 'PAID', 'PAID', 'PAID', 'PAID',
      'FAILED', 'CLOSED', 'PARTIAL_REFUNDED', 'PAID', 'PAID', 'REFUNDED', 'PAID',
    ];
    const subjects = [
      '会员订阅月卡', '门店消费', '云资源套餐', '数字商品', '课程订单',
      '硬件配件', '增值服务', '企业版年费',
    ];
    for (const tenant of TENANTS) {
      for (let i = 0; i < 14; i += 1) {
        const offset = i < 6 ? 0 : i % 7;
        const createdAt = new Date(
          Date.now() - offset * 86_400_000 - (i % 9) * 3_600_000 - Math.floor(rand() * 3_000_000),
        ).toISOString();
        const status = statuses[i];
        const channel = CHANNELS[Math.floor(rand() * 4)];
        const amountCents = 1_900 + Math.floor(rand() * 48_000);
        const outTradeNo = `${tenant.code.replace('-', '')}${localDate(offset).replace(/-/g, '')}${String(i + 1).padStart(4, '0')}`;
        const orderId = uid('pay');
        const channelTradeNo = `${channel.code.toUpperCase().slice(0, 6)}${Date.now().toString().slice(-8)}${i}`;
        const paidAt = status !== 'CREATED' && status !== 'CLOSED'
          ? new Date(new Date(createdAt).getTime() + 45_000).toISOString()
          : null;
        db.run(
          `INSERT INTO payment_orders
           (id, tenant_id, app_id, out_trade_no, subject, amount_cents, currency,
            status, method, channel_code, channel_trade_no, notify_url, client_ip,
            metadata_json, paid_at, closed_at, expires_at, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, ?, 'CNY', ?, 'QRCODE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          orderId,
          tenant.id,
          tenant.appId,
          outTradeNo,
          subjects[Math.floor(rand() * subjects.length)],
          amountCents,
          status,
          channel.code,
          status === 'CLOSED' ? null : channelTradeNo,
          RECEIVER,
          `10.20.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}`,
          JSON.stringify({ seed: true }),
          paidAt,
          status === 'CLOSED' ? createdAt : null,
          new Date(new Date(createdAt).getTime() + 900_000).toISOString(),
          createdAt,
          createdAt,
        );
        if (status === 'PAID' || status === 'PARTIAL_REFUNDED' || status === 'REFUNDED') {
          const snapshot: PaymentOrderSnapshot = {
            id: orderId,
            tenantId: tenant.id,
            appId: tenant.appId,
            outTradeNo,
            subject: 'seed',
            amountCents,
            currency: 'CNY',
            status: status as PaymentOrderSnapshot['status'],
            method: 'QRCODE',
            channelCode: channel.code,
            channelTradeNo,
            notifyUrl: RECEIVER,
            clientIp: null,
            metadata: {},
            paidAt,
            closedAt: null,
            expiresAt: createdAt,
            createdAt,
            updatedAt: createdAt,
            version: 1,
          };
          postPaymentEntries(snapshot, channel.feeBps);
        }
        if (status === 'PARTIAL_REFUNDED' || status === 'REFUNDED') {
          db.run(
            `INSERT INTO refunds
             (id, tenant_id, order_id, out_refund_no, amount_cents, reason, status, created_at)
             VALUES (?, ?, ?, ?, ?, '用户申请退款', 'SUCCESS', ?)`,
            uid('ref'),
            tenant.id,
            orderId,
            `REF${outTradeNo}`,
            Math.floor(amountCents / (status === 'REFUNDED' ? 1 : 3)),
            createdAt,
          );
        }
      }
    }

    audit('system', 'system', 'DATABASE_SEEDED', 'pivotpay', {
      tenants: TENANTS.length,
      channels: CHANNELS.length,
    });
  });
}
