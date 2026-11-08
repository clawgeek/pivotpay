import { DomainError, Money, ValueObject } from '../../shared/kernel';

/** 商户应用身份：SaaS 多租户下的接入凭据值对象 */
export class ApiCredential extends ValueObject {
  constructor(
    public readonly appId: string,
    public readonly apiKey: string,
    public readonly apiSecret: string,
  ) {
    super();
  }
}

export type TenantPlan = 'starter' | 'standard' | 'enterprise';

export interface TenantSnapshot {
  id: string;
  code: string;
  name: string;
  plan: TenantPlan;
  status: 'active' | 'suspended';
  createdAt: string;
}

export interface MerchantAppSnapshot {
  id: string;
  tenantId: string;
  name: string;
  appId: string;
  apiKey: string;
  apiSecret: string;
  webhookUrl: string;
  status: 'active' | 'disabled';
  createdAt: string;
}

export class Tenant {
  private constructor(private readonly snapshot: TenantSnapshot) {}

  static of(snapshot: TenantSnapshot): Tenant {
    return new Tenant(snapshot);
  }

  assertActive(): void {
    if (this.snapshot.status !== 'active') {
      throw new DomainError('TENANT_SUSPENDED', '租户已停用', 403);
    }
  }

  get id(): string {
    return this.snapshot.id;
  }

  get rateLimitPerMinute(): number {
    return this.snapshot.plan === 'enterprise'
      ? 600
      : this.snapshot.plan === 'standard'
        ? 120
        : 30;
  }

  toJSON(): TenantSnapshot {
    return { ...this.snapshot };
  }
}

/** 回调地址白名单：仅允许 http/https，防止 SSRF 式的内网地址配置 */
export class WebhookUrl extends ValueObject {
  private constructor(public readonly value: string) {
    super();
  }

  static of(raw: string): WebhookUrl {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new DomainError('INVALID_WEBHOOK_URL', '回调地址格式不正确');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new DomainError('INVALID_WEBHOOK_URL', '回调地址仅支持 http/https');
    }
    return new WebhookUrl(parsed.toString());
  }
}

/** 费率值对象，基点（bps）：60 = 0.60% */
export class FeeRate extends ValueObject {
  private constructor(public readonly bps: number) {
    super();
  }

  static of(bps: number): FeeRate {
    if (!Number.isInteger(bps) || bps < 0 || bps > 1000) {
      throw new DomainError('INVALID_FEE_RATE', '费率必须在 0–1000 bps 之间');
    }
    return new FeeRate(bps);
  }

  calculate(amount: Money): Money {
    return Money.of(Math.floor((amount.amountCents * this.bps) / 10_000), amount.currency);
  }
}
