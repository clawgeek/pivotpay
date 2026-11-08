/**
 * 前后端共享的 API 契约类型（type-only，编译后不产生运行时依赖）。
 * 领域模型仍由后端 DDD 各限界上下文独立持有，此处仅描述传输结构。
 */

export type PaymentStatus =
  | 'CREATED' | 'PAYING' | 'PAID' | 'PARTIAL_REFUNDED'
  | 'REFUNDED' | 'FAILED' | 'CLOSED';

export type PaymentMethod = 'QRCODE' | 'H5' | 'JSAPI' | 'WEB';

export interface PaymentOrder {
  id: string;
  tenantId: string;
  appId: string;
  outTradeNo: string;
  subject: string;
  amountCents: number;
  currency: string;
  amountYuan?: number;
  status: PaymentStatus;
  method: PaymentMethod;
  channelCode: string | null;
  channelName?: string | null;
  channelTradeNo: string | null;
  credential?: {
    type: 'QRCODE' | 'URL' | 'FORM';
    value: string;
    expiresAt: string;
  } | null;
  paidAt: string | null;
  expiresAt: string;
  createdAt: string;
  version: number;
  attempts?: PaymentAttempt[];
}

export interface PaymentAttempt {
  id: string;
  channelCode: string;
  attemptNo: number;
  outcome: string;
  latencyMs: number;
  errorCode: string | null;
  createdAt: string;
}

export interface ChannelHealth {
  channelCode: string;
  name: string;
  kind: string;
  mode: 'mock' | 'official';
  enabled: boolean;
  weight: number;
  feeBps: number;
  methods: string[];
  description: string;
  config: Record<string, unknown>;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  consecutiveFailures: number;
  successCount: number;
  failCount: number;
  ewmaLatencyMs: number;
  forceFail: boolean;
  configured: boolean;
  score: number;
}

export interface Tenant {
  id: string;
  code: string;
  name: string;
  plan: string;
  status: string;
  createdAt: string;
  apps: MerchantApp[];
}

export interface MerchantApp {
  id: string;
  tenantId: string;
  name: string;
  appId: string;
  apiKey: string;
  apiSecret: string;
  webhookUrl: string;
  status: string;
  createdAt: string;
}

export interface Overview {
  bizDate: string;
  today: { amountCents: number; amountYuan: number; orderCount: number };
  totals: { orders: number; settled: number; failed: number; successRate: number };
  avgLatencyMs: number;
  channels: { total: number; available: number; openBreakers: number };
  webhooks: { delivered: number; pending: number; dead: number };
  ledger: { debit: number; credit: number; balanced: boolean };
  trend: Array<{ day: string; orders: number; amount: number }>;
  recentOrders: PaymentOrder[];
}
