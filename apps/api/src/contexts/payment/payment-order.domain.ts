import {
  AggregateRoot,
  DomainError,
  Money,
  nowIso,
  uid,
} from '../../shared/kernel';

export type PaymentStatus =
  | 'CREATED'
  | 'PAYING'
  | 'PAID'
  | 'PARTIAL_REFUNDED'
  | 'REFUNDED'
  | 'FAILED'
  | 'CLOSED';

export type PaymentMethod = 'QRCODE' | 'H5' | 'JSAPI' | 'WEB';

/** 状态机：显式声明所有合法迁移，任何回退迁移都会被拒绝 */
const ALLOWED_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  CREATED: ['PAYING', 'FAILED', 'CLOSED'],
  PAYING: ['PAYING', 'PAID', 'FAILED', 'CLOSED'],
  PAID: ['PARTIAL_REFUNDED', 'REFUNDED'],
  PARTIAL_REFUNDED: ['PARTIAL_REFUNDED', 'REFUNDED'],
  REFUNDED: [],
  FAILED: [],
  CLOSED: [],
};

export interface PaymentOrderSnapshot {
  id: string;
  tenantId: string;
  appId: string;
  outTradeNo: string;
  subject: string;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  method: PaymentMethod;
  channelCode: string | null;
  channelTradeNo: string | null;
  notifyUrl: string | null;
  clientIp: string | null;
  metadata: Record<string, unknown>;
  paidAt: string | null;
  closedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CreatePaymentInput {
  tenantId: string;
  appId: string;
  outTradeNo: string;
  subject: string;
  amount: Money;
  method: PaymentMethod;
  notifyUrl: string | null;
  clientIp: string | null;
  metadata: Record<string, unknown>;
  /** 订单有效期（分钟） */
  ttlMinutes: number;
}

export class PaymentOrder extends AggregateRoot {
  private snapshot: PaymentOrderSnapshot;

  private constructor(snapshot: PaymentOrderSnapshot) {
    super(snapshot.id, snapshot.version);
    this.snapshot = snapshot;
  }

  static create(input: CreatePaymentInput): PaymentOrder {
    if (!input.outTradeNo || input.outTradeNo.length > 64) {
      throw new DomainError('INVALID_OUT_TRADE_NO', '商户订单号无效');
    }
    if (input.amount.isZero()) {
      throw new DomainError('INVALID_AMOUNT', '支付金额必须大于 0');
    }
    const now = nowIso();
    const order = new PaymentOrder({
      id: uid('pay'),
      tenantId: input.tenantId,
      appId: input.appId,
      outTradeNo: input.outTradeNo,
      subject: input.subject,
      amountCents: input.amount.amountCents,
      currency: input.amount.currency,
      status: 'CREATED',
      method: input.method,
      channelCode: null,
      channelTradeNo: null,
      notifyUrl: input.notifyUrl,
      clientIp: input.clientIp,
      metadata: input.metadata,
      paidAt: null,
      closedAt: null,
      expiresAt: new Date(Date.now() + input.ttlMinutes * 60_000).toISOString(),
      createdAt: now,
      updatedAt: now,
      version: 0,
    });
    order.record('PaymentCreated', {
      outTradeNo: input.outTradeNo,
      amountCents: input.amount.amountCents,
      method: input.method,
    });
    return order;
  }

  static fromSnapshot(snapshot: PaymentOrderSnapshot): PaymentOrder {
    return new PaymentOrder({ ...snapshot });
  }

  private moveTo(next: PaymentStatus): void {
    const allowed = ALLOWED_TRANSITIONS[this.snapshot.status];
    if (!allowed.includes(next)) {
      throw new DomainError(
        'ILLEGAL_STATE_TRANSITION',
        `订单状态不允许从 ${this.snapshot.status} 迁移到 ${next}`,
        409,
      );
    }
    this.snapshot = {
      ...this.snapshot,
      status: next,
      updatedAt: nowIso(),
      version: this.snapshot.version + 1,
    };
    this.version = this.snapshot.version;
  }

  /** 路由到通道；failover 会重复调用，因此允许 PAYING -> PAYING */
  markRouting(channelCode: string, channelTradeNo: string): void {
    this.moveTo('PAYING');
    this.snapshot.channelCode = channelCode;
    this.snapshot.channelTradeNo = channelTradeNo;
    this.record('PaymentRouted', { channelCode, channelTradeNo });
  }

  /** 通道返回的支付凭证（二维码 / 收银台链接），存入聚合快照的元数据 */
  attachCredential(credential: unknown): void {
    this.snapshot.metadata = { ...this.snapshot.metadata, credential };
  }

  markSucceeded(channelTradeNo: string, paidAt: string): void {
    if (this.snapshot.status === 'PAID') {
      // 重复回调：幂等返回，不重复记事件
      return;
    }
    if (this.snapshot.status === 'PARTIAL_REFUNDED' || this.snapshot.status === 'REFUNDED') {
      throw new DomainError('CALLBACK_OUT_OF_ORDER', '订单已进入退款态，拒绝迟到的成功回调', 409);
    }
    this.moveTo('PAID');
    this.snapshot.paidAt = paidAt;
    this.snapshot.channelTradeNo = channelTradeNo;
    this.record('PaymentSucceeded', {
      channelTradeNo,
      amountCents: this.snapshot.amountCents,
      paidAt,
    });
  }

  markFailed(reason: string): void {
    if (this.snapshot.status === 'PAID' || this.snapshot.status.startsWith('REFUND')) {
      // 乱序回调保护：已成功的订单不能被失败通知覆盖
      throw new DomainError('CALLBACK_OUT_OF_ORDER', '订单已支付成功，拒绝迟到的失败回调', 409);
    }
    this.moveTo('FAILED');
    this.record('PaymentFailed', { reason });
  }

  close(): void {
    if (this.snapshot.status === 'PAID') {
      throw new DomainError('ORDER_ALREADY_PAID', '已支付订单不可关单', 409);
    }
    this.moveTo('CLOSED');
    this.snapshot.closedAt = nowIso();
    this.record('PaymentClosed', {});
  }

  /** 退款领域规则：累计退款不得超过实付金额 */
  applyRefund(amount: Money, alreadyRefundedCents: number): void {
    if (this.snapshot.status !== 'PAID' && this.snapshot.status !== 'PARTIAL_REFUNDED') {
      throw new DomainError('ORDER_NOT_REFUNDABLE', '仅已支付订单可退款', 409);
    }
    const total = Money.of(this.snapshot.amountCents, this.snapshot.currency);
    const remaining = total.subtract(Money.of(alreadyRefundedCents, this.snapshot.currency));
    if (!remaining.greaterOrEqual(amount)) {
      throw new DomainError('REFUND_EXCEEDS_PAID', '累计退款金额超出实付金额', 422);
    }
    const nextRefunded = alreadyRefundedCents + amount.amountCents;
    const fullyRefunded = nextRefunded === this.snapshot.amountCents;
    this.moveTo(fullyRefunded ? 'REFUNDED' : 'PARTIAL_REFUNDED');
    this.record('RefundAccepted', {
      amountCents: amount.amountCents,
      totalRefundedCents: nextRefunded,
      fullyRefunded,
    });
  }

  assertTenant(tenantId: string): void {
    if (this.snapshot.tenantId !== tenantId) {
      throw new DomainError('TENANT_MISMATCH', '订单不属于当前租户', 403);
    }
  }

  assertNotExpired(at: Date = new Date()): void {
    if (at.getTime() > new Date(this.snapshot.expiresAt).getTime()) {
      throw new DomainError('ORDER_EXPIRED', '订单已过期', 409);
    }
  }

  get amount(): Money {
    return Money.of(this.snapshot.amountCents, this.snapshot.currency);
  }

  get status(): PaymentStatus {
    return this.snapshot.status;
  }

  get channelCode(): string | null {
    return this.snapshot.channelCode;
  }

  get channelTradeNo(): string | null {
    return this.snapshot.channelTradeNo;
  }

  toSnapshot(): PaymentOrderSnapshot {
    return { ...this.snapshot, metadata: { ...this.snapshot.metadata } };
  }
}
