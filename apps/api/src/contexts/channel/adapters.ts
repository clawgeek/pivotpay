import { DomainError, hmacHex, nowIso, uid } from '../../shared/kernel';
import { getFlag, getNumberFlag } from '../../infrastructure/runtime-flags';
import {
  CHANNEL_CALLBACK_SECRET,
  type CallbackPayload,
  type ChannelAdapter,
  type CreateChargeCommand,
  type CreateChargeResult,
  type ChargeCredential,
  type RefundCommand,
} from './channel-port';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

abstract class MockChannelAdapter implements ChannelAdapter {
  abstract readonly code: string;
  readonly mode = 'mock' as const;

  protected constructor(
    protected readonly baseLatencyMs: number,
    protected readonly baseFailRate: number,
    protected readonly credentialType: ChargeCredential['type'],
  ) {}

  isConfigured(): boolean {
    return true;
  }

  async createCharge(command: CreateChargeCommand): Promise<CreateChargeResult> {
    const startedAt = Date.now();
    const extra = getNumberFlag('extra_latency_ms', 0);
    const jitter = Math.floor(Math.random() * 90);
    await sleep(Math.max(0, this.baseLatencyMs + jitter + extra));

    const forced = getFlag(`force_fail:${this.code}`, '0') === '1';
    const failRate = getNumberFlag(`fail_rate:${this.code}`, this.baseFailRate);
    if (forced || Math.random() < failRate) {
      return {
        ok: false,
        errorCode: 'CHANNEL_TIMEOUT',
        errorMessage: '通道响应超时，触发自动 failover',
        latencyMs: Date.now() - startedAt,
      };
    }

    const channelTradeNo = `${this.code.slice(0, 6).toUpperCase()}${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;
    const credential: ChargeCredential = {
      type: this.credentialType,
      value:
        this.credentialType === 'QRCODE'
          ? `https://cashier.pivotpay.local/qr/${channelTradeNo}?amount=${command.amountCents}`
          : `https://cashier.pivotpay.local/h5/${channelTradeNo}`,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    return {
      ok: true,
      channelTradeNo,
      credential,
      latencyMs: Date.now() - startedAt,
    };
  }

  /** 通道回调同样要求 HMAC 验签；验签失败直接丢弃，不进入领域层 */
  parseCallback(rawBody: string, headers: Record<string, string>): CallbackPayload | null {
    const signature = headers['x-channel-sign'] || headers['X-Channel-Sign'];
    if (!signature || signature !== hmacHex(CHANNEL_CALLBACK_SECRET, rawBody)) {
      return null;
    }
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      if (
        typeof parsed.channelTradeNo !== 'string' ||
        typeof parsed.outTradeNo !== 'string' ||
        typeof parsed.amountCents !== 'number' ||
        (parsed.outcome !== 'SUCCESS' && parsed.outcome !== 'FAILURE')
      ) {
        return null;
      }
      return {
        channelCode: String(parsed.channelCode || this.code),
        channelTradeNo: parsed.channelTradeNo,
        outTradeNo: parsed.outTradeNo,
        amountCents: parsed.amountCents,
        currency: String(parsed.currency || 'CNY'),
        outcome: parsed.outcome,
        occurredAt: String(parsed.occurredAt || nowIso()),
      };
    } catch {
      return null;
    }
  }

  async refund(_command: RefundCommand): Promise<{ ok: boolean; errorCode?: string }> {
    await sleep(30);
    return { ok: true };
  }
}

/** 视频中的「支付宝当面付 / 扫码」类通道，以沙箱模拟器实现 */
class MockAlipayQrAdapter extends MockChannelAdapter {
  readonly code = 'mock_alipay_qr';
  constructor() {
    super(110, 0.02, 'QRCODE');
  }
}

/** 视频中的「微信 Native / 原生扫码」类通道 */
class MockWechatNativeAdapter extends MockChannelAdapter {
  readonly code = 'mock_wechat_native';
  constructor() {
    super(150, 0.03, 'QRCODE');
  }
}

/** 视频中的「汇付斗拱 / 聚合网关」类通道，走 H5 收银台 */
class MockAggregatorH5Adapter extends MockChannelAdapter {
  readonly code = 'mock_aggregator_h5';
  constructor() {
    super(230, 0.04, 'URL');
  }
}

/** 故障演练通道：默认较高失败率，用于演示熔断与自动切换 */
class MockFlakyAdapter extends MockChannelAdapter {
  readonly code = 'mock_flaky';
  constructor() {
    super(320, 0.35, 'QRCODE');
  }
}

/**
 * 持牌通道适配器占位（合规边界）。
 * 参考视频涉及的「个人收款码免签 / 异地收款 / 发卡通道」不在此实现；
 * 这里只保留对接官方开放平台所需的接口形状与配置位。
 * 接入前置条件：企业资质、官方商户号、应用私钥/平台公钥、备案回调域名。
 * 未配置时禁止路由选中，也不发起任何真实请求。
 */
export class OfficialChannelAdapter implements ChannelAdapter {
  readonly mode = 'official' as const;

  constructor(
    readonly code: string,
    private readonly provider: string,
  ) {}

  isConfigured(): boolean {
    return false;
  }

  async createCharge(_command: CreateChargeCommand): Promise<CreateChargeResult> {
    throw new DomainError(
      'CHANNEL_NOT_CONFIGURED',
      `${this.provider} 为持牌通道占位适配器：需企业资质与官方开放平台密钥，沙箱环境不发起真实请求`,
      503,
    );
  }

  parseCallback(_rawBody: string, _headers: Record<string, string>): CallbackPayload | null {
    return null;
  }

  async refund(_command: RefundCommand): Promise<{ ok: boolean; errorCode?: string }> {
    throw new DomainError('CHANNEL_NOT_CONFIGURED', '持牌通道未配置', 503);
  }
}

const adapterList: ChannelAdapter[] = [
  new MockAlipayQrAdapter(),
  new MockWechatNativeAdapter(),
  new MockAggregatorH5Adapter(),
  new MockFlakyAdapter(),
  new OfficialChannelAdapter('official_alipay', '支付宝开放平台（当面付）'),
  new OfficialChannelAdapter('official_wechatpay', '微信支付（Native / JSAPI）'),
  new OfficialChannelAdapter('official_unionpay', '银联商务（全渠道）'),
];

export const channelAdapters: Map<string, ChannelAdapter> = new Map(
  adapterList.map((adapter) => [adapter.code, adapter]),
);

export function getAdapter(code: string): ChannelAdapter | undefined {
  return channelAdapters.get(code);
}

/** 生成一份带签名的通道回调报文（供沙箱与自动化测试复用） */
export function buildSignedCallback(payload: Omit<CallbackPayload, 'occurredAt'> & {
  occurredAt?: string;
}): { rawBody: string; headers: Record<string, string> } {
  const body = JSON.stringify({ ...payload, occurredAt: payload.occurredAt || nowIso() });
  return {
    rawBody: body,
    headers: {
      'content-type': 'application/json',
      'x-channel-sign': hmacHex(CHANNEL_CALLBACK_SECRET, body),
    },
  };
}

export function newChannelTradeNo(code: string): string {
  return `${code.toUpperCase().slice(0, 8)}${uid('').slice(1)}${Date.now().toString().slice(-6)}`;
}
