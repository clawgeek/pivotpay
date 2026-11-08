import { db, type Row } from '../infrastructure/database';
import {
  DomainError,
  Money,
  nowIso,
  sha256Hex,
  stableStringify,
  uid,
} from '../shared/kernel';
import { audit } from '../infrastructure/audit';
import {
  PaymentOrder,
  type PaymentMethod,
  type PaymentOrderSnapshot,
} from '../contexts/payment/payment-order.domain';
import {
  findOrderByChannelTradeNo,
  findOrderById,
  insertAttempt,
  insertOrder,
  insertRefund,
  listAttempts,
  listOrders,
  listRefunds,
  saveOrder,
  sumRefundedCents,
} from '../contexts/payment/payment.repository';
import { getAppById } from '../contexts/tenant/tenant.repository';
import { getAdapter } from '../contexts/channel/adapters';
import {
  type CallbackPayload,
  type ChannelDefinition,
  type ChargeCredential,
} from '../contexts/channel/channel-port';
import { channelRouter, getChannelDefinition } from '../contexts/routing/router.service';
import { enqueueDomainEvents } from '../contexts/notification/webhook.service';
import {
  postPaymentEntries,
  postRefundEntries,
} from '../contexts/ledger/ledger.service';

export interface CreatePaymentRequest {
  outTradeNo: string;
  subject: string;
  amountCents: number;
  currency?: string;
  method?: PaymentMethod;
  notifyUrl?: string;
  clientIp?: string;
  metadata?: Record<string, unknown>;
  ttlMinutes?: number;
}

export interface PaymentView {
  id: string;
  outTradeNo: string;
  subject: string;
  amountCents: number;
  currency: string;
  amountYuan: number;
  status: string;
  method: PaymentMethod;
  channelCode: string | null;
  channelName: string | null;
  channelTradeNo: string | null;
  credential: ChargeCredential | null;
  paidAt: string | null;
  expiresAt: string;
  createdAt: string;
  version: number;
}

function toView(snapshot: PaymentOrderSnapshot): PaymentView {
  const channel = snapshot.channelCode
    ? getChannelDefinition(snapshot.channelCode)
    : undefined;
  return {
    id: snapshot.id,
    outTradeNo: snapshot.outTradeNo,
    subject: snapshot.subject,
    amountCents: snapshot.amountCents,
    currency: snapshot.currency,
    amountYuan: snapshot.amountCents / 100,
    status: snapshot.status,
    method: snapshot.method,
    channelCode: snapshot.channelCode,
    channelName: channel?.name ?? null,
    channelTradeNo: snapshot.channelTradeNo,
    credential: (snapshot.metadata.credential as ChargeCredential) ?? null,
    paidAt: snapshot.paidAt,
    expiresAt: snapshot.expiresAt,
    createdAt: snapshot.createdAt,
    version: snapshot.version,
  };
}

interface ChargeOutcome {
  ok: boolean;
  def?: ChannelDefinition;
  credential?: ChargeCredential;
  channelTradeNo?: string;
  errorCode?: string;
  errorMessage?: string;
}

/** 支付核心应用服务：编排聚合、通道路由、防腐层、事务与领域事件 */
export class PaymentApplicationService {
  /** 下单：幂等键 → 创建聚合 → 通道路由（含 failover）→ 持久化 → 发布事件 */
  async createPayment(input: {
    tenantId: string;
    appId: string;
    idempotencyKey: string;
    request: CreatePaymentRequest;
  }): Promise<PaymentView> {
    const { tenantId, appId, idempotencyKey, request } = input;
    const requestHash = sha256Hex(stableStringify(request));
    const cached = db.get<Row>(
      'SELECT request_hash AS requestHash, response_json AS responseJson, status FROM idempotency_keys WHERE tenant_id = ? AND idem_key = ?',
      tenantId,
      idempotencyKey,
    );
    if (cached) {
      if (String(cached.requestHash) !== requestHash) {
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          '幂等键已被用于不同的请求体',
          409,
        );
      }
      if (cached.responseJson) {
        return JSON.parse(String(cached.responseJson)) as PaymentView;
      }
      throw new DomainError('REQUEST_IN_PROGRESS', '相同请求正在处理中', 409);
    }

    const app = getAppById(appId);
    if (!app) throw new DomainError('APP_NOT_FOUND', '应用不存在', 404);
    if (app.status !== 'active') throw new DomainError('APP_DISABLED', '应用已停用', 403);

    const order = PaymentOrder.create({
      tenantId,
      appId,
      outTradeNo: request.outTradeNo,
      subject: request.subject,
      amount: Money.of(request.amountCents, request.currency || 'CNY'),
      method: request.method || 'QRCODE',
      notifyUrl: request.notifyUrl ?? app.webhookUrl,
      clientIp: request.clientIp ?? null,
      metadata: request.metadata ?? {},
      ttlMinutes: request.ttlMinutes ?? 15,
    });

    db.transaction(() => {
      insertOrder(order);
      db.run(
        `INSERT INTO idempotency_keys
         (tenant_id, idem_key, request_hash, response_json, status, created_at)
         VALUES (?, ?, ?, NULL, 'PROCESSING', ?) ON CONFLICT DO NOTHING`,
        tenantId,
        idempotencyKey,
        requestHash,
        nowIso(),
      );
      enqueueDomainEvents(order.pullDomainEvents(), tenantId, app.webhookUrl, app.apiSecret);
      audit(tenantId, 'merchant-api', 'PAYMENT_CREATED', order.id, {
        outTradeNo: request.outTradeNo,
        amountCents: request.amountCents,
      });
    });

    const outcome = await this.routeAndCharge(order, request.method || 'QRCODE', idempotencyKey);
    if (outcome.ok) {
      order.markRouting(outcome.def!.code, outcome.channelTradeNo!);
      order.attachCredential(outcome.credential!);
    } else {
      order.markFailed(outcome.errorMessage || '所有通道均不可用');
    }

    const view = toView(order.toSnapshot());
    db.transaction(() => {
      saveOrder(order);
      db.run(
        `UPDATE idempotency_keys SET response_json = ?, status = 'COMPLETED'
         WHERE tenant_id = ? AND idem_key = ?`,
        JSON.stringify(view),
        tenantId,
        idempotencyKey,
      );
      enqueueDomainEvents(order.pullDomainEvents(), tenantId, app.webhookUrl, app.apiSecret);
      audit(tenantId, 'merchant-api', outcome.ok ? 'PAYMENT_ROUTED' : 'PAYMENT_FAILED', order.id, {
        channelCode: outcome.def?.code ?? null,
        errorCode: outcome.errorCode ?? null,
      });
    });

    if (!outcome.ok) {
      throw new DomainError(
        outcome.errorCode || 'CHANNEL_UNAVAILABLE',
        outcome.errorMessage || '所有通道均不可用',
        502,
      );
    }
    return view;
  }

  /** 通道选择 + 最多两次 failover；失败会记入 payment_attempts 并驱动熔断器 */
  private async routeAndCharge(
    order: PaymentOrder,
    method: PaymentMethod,
    idempotencyKey: string,
  ): Promise<ChargeOutcome> {
    const snapshot = order.toSnapshot();
    const excluded: string[] = [];
    let lastErrorCode = 'NO_CHANNEL_AVAILABLE';
    let lastErrorMessage = '当前无可用通道（全部熔断或停用）';

    for (let attemptNo = 1; attemptNo <= 2; attemptNo += 1) {
      const def = channelRouter.select(method, excluded);
      if (!def) break;
      const adapter = getAdapter(def.code);
      if (!adapter?.isConfigured()) {
        excluded.push(def.code);
        continue;
      }
      try {
        const result = await adapter.createCharge({
          orderId: snapshot.id,
          outTradeNo: snapshot.outTradeNo,
          amountCents: snapshot.amountCents,
          currency: snapshot.currency,
          subject: snapshot.subject,
          method,
          notifyUrl: snapshot.notifyUrl,
          clientIp: snapshot.clientIp,
          idempotencyKey,
        });
        if (result.ok) {
          insertAttempt(
            snapshot.id,
            def.code,
            attemptNo,
            'SUCCESS',
            result.latencyMs,
            null,
          );
          channelRouter.recordSuccess(def.code, result.latencyMs);
          return {
            ok: true,
            def,
            credential: result.credential,
            channelTradeNo: result.channelTradeNo,
          };
        }
        insertAttempt(
          snapshot.id,
          def.code,
          attemptNo,
          'FAILURE',
          result.latencyMs,
          result.errorCode || null,
        );
        channelRouter.recordFailure(def.code, result.errorCode);
        excluded.push(def.code);
        lastErrorCode = result.errorCode || 'CHANNEL_ERROR';
        lastErrorMessage = result.errorMessage || '通道下单失败';
      } catch (error) {
        channelRouter.recordFailure(def.code, 'ADAPTER_EXCEPTION');
        excluded.push(def.code);
        lastErrorMessage = error instanceof Error ? error.message : '适配器异常';
      }
    }
    insertAttempt(snapshot.id, 'NONE', 0, 'EXHAUSTED', 0, lastErrorCode);
    return { ok: false, errorCode: lastErrorCode, errorMessage: lastErrorMessage };
  }

  /** 通道回调：验签 → 回调幂等 → 金额核对 → 状态机 → 复式记账 → Outbox 通知 */
  handleChannelCallback(rawBody: string, headers: Record<string, string>): {
    accepted: boolean;
    duplicate: boolean;
    status?: string;
    reason?: string;
  } {
    const firstMock = getAdapter('mock_alipay_qr');
    const payload = firstMock?.parseCallback(rawBody, headers) as CallbackPayload | null;
    if (!payload) {
      throw new DomainError('INVALID_CHANNEL_SIGNATURE', '通道回调验签失败', 401);
    }

    return db.transaction(() => {
      const order = findOrderByChannelTradeNo(payload.channelTradeNo);
      if (!order) {
        return { accepted: false, duplicate: false, reason: '订单不存在' };
      }
      const snapshot = order.toSnapshot();

      // 金额/币种核对必须先于回调去重：否则「同流水号 + 篡改金额」的伪造报文
      // 会被误判为重复回调而静默放过，掩盖了资金篡改攻击。
      if (snapshot.amountCents !== payload.amountCents) {
        throw new DomainError('CALLBACK_AMOUNT_MISMATCH', '回调金额与订单金额不一致', 422);
      }
      if (snapshot.currency !== payload.currency) {
        throw new DomainError('CALLBACK_CURRENCY_MISMATCH', '回调币种与订单币种不一致', 422);
      }

      const seen = db.get<Row>(
        `SELECT id FROM channel_callbacks
         WHERE channel_code = ? AND channel_trade_no = ? AND outcome = ?`,
        payload.channelCode,
        payload.channelTradeNo,
        payload.outcome,
      );
      if (seen) return { accepted: false, duplicate: true, reason: '重复回调已幂等丢弃' };

      db.run(
        `INSERT INTO channel_callbacks
         (id, channel_trade_no, channel_code, outcome, received_at)
         VALUES (?, ?, ?, ?, ?)`,
        uid('cbk'),
        payload.channelTradeNo,
        payload.channelCode,
        payload.outcome,
        nowIso(),
      );

      const beforeStatus = snapshot.status;
      if (payload.outcome === 'SUCCESS') {
        order.markSucceeded(payload.channelTradeNo, payload.occurredAt);
        // 只有状态真正推进到 PAID 才记账，重复 / 迟到回调不得重复入账
        if (beforeStatus !== 'PAID' && order.status === 'PAID') {
          const def = getChannelDefinition(snapshot.channelCode || '');
          postPaymentEntries(order.toSnapshot(), def?.feeBps ?? 60);
        }
        if (snapshot.channelCode) channelRouter.recordSuccess(snapshot.channelCode, 0);
      } else {
        order.markFailed('通道返回支付失败');
        if (snapshot.channelCode) channelRouter.recordFailure(snapshot.channelCode, 'PAY_FAILED');
      }

      const app = getAppById(snapshot.appId);
      saveOrder(order);
      enqueueDomainEvents(
        order.pullDomainEvents(),
        snapshot.tenantId,
        app?.webhookUrl || '',
        app?.apiSecret || 'pivotpay',
      );
      audit(snapshot.tenantId, 'channel', 'CALLBACK_ACCEPTED', order.id, {
        outcome: payload.outcome,
        channelTradeNo: payload.channelTradeNo,
      });
      return { accepted: true, duplicate: false, status: order.status };
    });
  }

  /** 退款：领域规则保证累计退款不超过实付金额，退款单号幂等 */
  refund(input: {
    tenantId: string;
    orderId: string;
    outRefundNo: string;
    amountCents: number;
    reason?: string;
  }): Record<string, unknown> {
    return db.transaction(() => {
      const existing = db.get<Row>(
        'SELECT * FROM refunds WHERE tenant_id = ? AND out_refund_no = ?',
        input.tenantId,
        input.outRefundNo,
      );
      if (existing) {
        return { ...existing, idempotent: true };
      }
      const order = findOrderById(input.orderId);
      if (!order) throw new DomainError('ORDER_NOT_FOUND', '订单不存在', 404);
      order.assertTenant(input.tenantId);
      const alreadyRefunded = sumRefundedCents(order.id);
      const amount = Money.of(input.amountCents);
      order.applyRefund(amount, alreadyRefunded);
      const refundId = insertRefund({
        orderId: order.id,
        tenantId: input.tenantId,
        outRefundNo: input.outRefundNo,
        amountCents: input.amountCents,
        reason: input.reason || '商户发起退款',
      });
      saveOrder(order);
      postRefundEntries(input.tenantId, order.id, input.amountCents);
      const app = getAppById(order.toSnapshot().appId);
      enqueueDomainEvents(
        order.pullDomainEvents(),
        input.tenantId,
        app?.webhookUrl || '',
        app?.apiSecret || 'pivotpay',
      );
      audit(input.tenantId, 'merchant-api', 'REFUND_ACCEPTED', order.id, {
        outRefundNo: input.outRefundNo,
        amountCents: input.amountCents,
      });
      return {
        id: refundId,
        orderId: order.id,
        outRefundNo: input.outRefundNo,
        amountCents: input.amountCents,
        status: 'SUCCESS',
        orderStatus: order.status,
        totalRefundedCents: alreadyRefunded + input.amountCents,
      };
    });
  }

  closeOrder(tenantId: string, orderId: string): PaymentView {
    return db.transaction(() => {
      const order = findOrderById(orderId);
      if (!order) throw new DomainError('ORDER_NOT_FOUND', '订单不存在', 404);
      order.assertTenant(tenantId);
      order.close();
      saveOrder(order);
      audit(tenantId, 'merchant-api', 'ORDER_CLOSED', orderId, {});
      return toView(order.toSnapshot());
    });
  }

  getOrder(tenantId: string, orderId: string): Record<string, unknown> {
    const order = findOrderById(orderId);
    if (!order) throw new DomainError('ORDER_NOT_FOUND', '订单不存在', 404);
    order.assertTenant(tenantId);
    return { ...toView(order.toSnapshot()), attempts: listAttempts(orderId) };
  }

  queryOrders(tenantId: string, query: Record<string, string>): {
    rows: unknown[];
    total: number;
  } {
    return listOrders({
      tenantId,
      status: query.status,
      channelCode: query.channelCode,
      keyword: query.keyword,
      limit: Math.min(Number(query.limit || 50), 200),
      offset: Number(query.offset || 0),
    });
  }

  queryRefunds(tenantId: string): unknown[] {
    return listRefunds(tenantId);
  }
}

export const paymentService = new PaymentApplicationService();
