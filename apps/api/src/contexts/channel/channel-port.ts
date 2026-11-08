import type { PaymentMethod } from '../payment/payment-order.domain';

export type ChannelMode = 'mock' | 'official';
export type ChannelKind = 'wallet' | 'bank' | 'aggregator';

export interface ChannelDefinition {
  code: string;
  name: string;
  kind: ChannelKind;
  mode: ChannelMode;
  enabled: boolean;
  weight: number;
  feeBps: number;
  methods: PaymentMethod[];
  description: string;
  config: Record<string, unknown>;
  sortOrder: number;
}

export interface CreateChargeCommand {
  orderId: string;
  outTradeNo: string;
  amountCents: number;
  currency: string;
  subject: string;
  method: PaymentMethod;
  notifyUrl: string | null;
  clientIp: string | null;
  idempotencyKey: string;
}

export interface ChargeCredential {
  type: 'QRCODE' | 'URL' | 'FORM';
  value: string;
  expiresAt: string;
}

export interface CreateChargeResult {
  ok: boolean;
  channelTradeNo?: string;
  credential?: ChargeCredential;
  errorCode?: string;
  errorMessage?: string;
  latencyMs: number;
}

export interface CallbackPayload {
  channelCode: string;
  channelTradeNo: string;
  outTradeNo: string;
  amountCents: number;
  currency: string;
  outcome: 'SUCCESS' | 'FAILURE';
  occurredAt: string;
}

export interface RefundCommand {
  channelTradeNo: string;
  outRefundNo: string;
  amountCents: number;
  reason: string;
}

/**
 * 通道适配器端口（防腐层 / ACL）。
 * 领域层只依赖此接口，不感知任何第三方 SDK 的字段与签名规则。
 * official 适配器仅保留接口形状与配置位，不发起真实请求。
 */
export interface ChannelAdapter {
  readonly code: string;
  readonly mode: ChannelMode;
  isConfigured(): boolean;
  createCharge(command: CreateChargeCommand): Promise<CreateChargeResult>;
  /** 验签并解析回调；验签失败返回 null */
  parseCallback(rawBody: string, headers: Record<string, string>): CallbackPayload | null;
  refund(command: RefundCommand): Promise<{ ok: boolean; errorCode?: string }>;
}

export const CHANNEL_CALLBACK_SECRET = 'pivotpay-sandbox-channel-secret';
