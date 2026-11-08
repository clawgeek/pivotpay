import { db, type Row } from '../infrastructure/database';
import { DomainError, nowIso } from '../shared/kernel';
import { audit } from '../infrastructure/audit';
import { setFlag, allFlags } from '../infrastructure/runtime-flags';
import { findOrderById } from '../contexts/payment/payment.repository';
import { paymentService } from './payment.service';
import { buildSignedCallback } from '../contexts/channel/adapters';
import { channelRouter, listChannelDefinitions } from '../contexts/routing/router.service';
import { listTenants, listApps } from '../contexts/tenant/tenant.repository';
import {
  listDeliveries,
  retryDelivery,
  webhookStats,
} from '../contexts/notification/webhook.service';
import { listLedger, ledgerBalance } from '../contexts/ledger/ledger.service';
import {
  listAudit,
} from '../infrastructure/audit';
import {
  listBatches,
  listDiffs,
  runReconciliation,
} from '../contexts/reconciliation/reconciliation.service';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export class ConsoleApplicationService {
  overview(tenantId: string): Record<string, unknown> {
    const day = today();
    const paid = db.get<Row>(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_cents), 0) AS amount
       FROM payment_orders WHERE tenant_id = ? AND substr(created_at,1,10) = ?
         AND status IN ('PAID','PARTIAL_REFUNDED','REFUNDED')`,
      tenantId,
      day,
    );
    const totals = db.get<Row>(
      `SELECT COUNT(*) AS cnt,
        COALESCE(SUM(CASE WHEN status IN ('PAID','PARTIAL_REFUNDED','REFUNDED') THEN 1 ELSE 0 END), 0) AS paid,
        COALESCE(SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0) AS failed
       FROM payment_orders WHERE tenant_id = ?`,
      tenantId,
    );
    const attempts = db.get<Row>(
      `SELECT COALESCE(AVG(a.latency_ms), 0) AS avgLatency
       FROM payment_attempts a JOIN payment_orders o ON o.id = a.order_id
       WHERE o.tenant_id = ? AND a.outcome = 'SUCCESS'`,
      tenantId,
    );
    const trend = db.all<Row>(
      `SELECT substr(created_at,1,10) AS day,
        COUNT(*) AS orders,
        COALESCE(SUM(CASE WHEN status IN ('PAID','PARTIAL_REFUNDED','REFUNDED')
          THEN amount_cents ELSE 0 END), 0) AS amount
       FROM payment_orders WHERE tenant_id = ?
       GROUP BY substr(created_at,1,10) ORDER BY day DESC LIMIT 7`,
      tenantId,
    );
    const recent = paymentService.queryOrders(tenantId, { limit: '8' }).rows;
    const health = channelRouter.listHealth();
    const webhooks = webhookStats(tenantId);
    const balance = ledgerBalance(tenantId);
    const settled = Number(totals?.paid || 0);
    const total = Number(totals?.cnt || 0);
    return {
      bizDate: day,
      today: {
        amountCents: Number(paid?.amount || 0),
        amountYuan: Number(paid?.amount || 0) / 100,
        orderCount: Number(paid?.cnt || 0),
      },
      totals: {
        orders: total,
        settled,
        failed: Number(totals?.failed || 0),
        successRate: total > 0 ? Number(((settled / total) * 100).toFixed(1)) : 0,
      },
      avgLatencyMs: Math.round(Number(attempts?.avgLatency || 0)),
      channels: {
        total: health.length,
        available: health.filter((c) => c.enabled && c.configured && c.state !== 'OPEN').length,
        openBreakers: health.filter((c) => c.state === 'OPEN').length,
      },
      webhooks: {
        delivered: webhooks.delivered || 0,
        pending: webhooks.pending || 0,
        dead: webhooks.dead || 0,
      },
      ledger: balance,
      trend: trend.reverse(),
      recentOrders: recent,
    };
  }

  channels(): unknown[] {
    return channelRouter.listHealth();
  }

  updateChannel(
    code: string,
    patch: {
      enabled?: boolean;
      weight?: number;
      feeBps?: number;
      config?: Record<string, unknown>;
    },
  ): unknown {
    const def = listChannelDefinitions().find((c) => c.code === code);
    if (!def) throw new DomainError('CHANNEL_NOT_FOUND', '通道不存在', 404);
    if (patch.weight !== undefined && (patch.weight < 0 || patch.weight > 1000)) {
      throw new DomainError('INVALID_WEIGHT', '权重需在 0–1000 之间');
    }
    if (patch.feeBps !== undefined && (patch.feeBps < 0 || patch.feeBps > 1000)) {
      throw new DomainError('INVALID_FEE_RATE', '费率需在 0–1000 bps 之间');
    }
    const mergedConfig = patch.config ? { ...def.config, ...patch.config } : def.config;
    db.run(
      `UPDATE channel_defs SET enabled = ?, weight = ?, fee_bps = ?, config_json = ? WHERE code = ?`,
      patch.enabled ?? def.enabled,
      patch.weight ?? def.weight,
      patch.feeBps ?? def.feeBps,
      JSON.stringify(mergedConfig),
      code,
    );
    audit('system', 'console', 'CHANNEL_UPDATED', code, patch);
    return channelRouter.listHealth().find((c) => c.channelCode === code);
  }

  routingPolicy(): Record<string, unknown> {
    const health = channelRouter.listHealth();
    return {
      strategy: '加权健康度路由（weight × healthScore）',
      failover: '最多 2 次尝试，失败通道当次排除',
      breaker: {
        stateMachine: 'CLOSED → OPEN → HALF_OPEN → CLOSED',
        failureThreshold: 3,
        cooldownMs: 30_000,
      },
      idempotency: 'Idempotency-Key + 请求体哈希；回调按 channel_trade_no + outcome 去重',
      consistency: '订单状态、账务分录、Outbox 事件同一数据库事务提交',
      candidates: health.map((c) => ({
        code: c.channelCode,
        name: c.name,
        weight: c.weight,
        score: c.score,
        state: c.state,
        effectiveWeight: Math.round(c.weight * (c.score / 100)),
        usable: c.enabled && c.configured && c.state !== 'OPEN',
      })),
    };
  }

  /** 故障注入：驱动熔断、failover、回调重试等演练场景 */
  injectFault(payload: {
    action: string;
    channelCode?: string;
    value?: number;
  }): Record<string, unknown> {
    const { action, channelCode } = payload;
    switch (action) {
      case 'force_fail':
      case 'recover': {
        if (!channelCode) throw new DomainError('CHANNEL_REQUIRED', '需要指定通道');
        const fail = action === 'force_fail';
        setFlag(`force_fail:${channelCode}`, fail ? '1' : '0');
        db.run(
          'UPDATE channel_health SET force_fail = ?, updated_at = ? WHERE channel_code = ?',
          fail ? 1 : 0,
          nowIso(),
          channelCode,
        );
        break;
      }
      case 'open_breaker': {
        if (!channelCode) throw new DomainError('CHANNEL_REQUIRED', '需要指定通道');
        for (let i = 0; i < 3; i += 1) channelRouter.recordFailure(channelCode, 'MANUAL_DRILL');
        break;
      }
      case 'reset_breaker': {
        if (!channelCode) throw new DomainError('CHANNEL_REQUIRED', '需要指定通道');
        channelRouter.reset(channelCode);
        setFlag(`force_fail:${channelCode}`, '0');
        break;
      }
      case 'reset_all': {
        for (const def of listChannelDefinitions()) {
          channelRouter.reset(def.code);
          setFlag(`force_fail:${def.code}`, '0');
        }
        setFlag('force_webhook_fail', '0');
        setFlag('webhook_receiver_down', '0');
        setFlag('extra_latency_ms', '0');
        break;
      }
      case 'force_webhook_fail':
        setFlag('force_webhook_fail', payload.value === 0 ? '0' : '1');
        break;
      case 'receiver_down':
        setFlag('webhook_receiver_down', payload.value === 0 ? '0' : '1');
        break;
      case 'extra_latency':
        setFlag('extra_latency_ms', String(payload.value ?? 500));
        break;
      default:
        throw new DomainError('UNKNOWN_DRILL', `未知演练动作：${action}`);
    }
    audit('system', 'console', 'FAULT_INJECTED', action, { channelCode, value: payload.value });
    return { flags: allFlags(), health: channelRouter.listHealth() };
  }

  /** 沙箱：生成带真实 HMAC 签名的通道回调，验证幂等 / 乱序 / 金额篡改 */
  simulateCallback(input: {
    tenantId: string;
    orderId: string;
    outcome: 'SUCCESS' | 'FAILURE';
    mode: 'normal' | 'duplicate' | 'out_of_order' | 'tamper_amount';
  }): Record<string, unknown> {
    const order = findOrderById(input.orderId);
    if (!order) throw new DomainError('ORDER_NOT_FOUND', '订单不存在', 404);
    order.assertTenant(input.tenantId);
    const snapshot = order.toSnapshot();
    if (!snapshot.channelTradeNo) {
      throw new DomainError('ORDER_NOT_ROUTED', '订单尚未路由到通道，无法回调', 409);
    }
    const base = {
      channelCode: snapshot.channelCode || 'mock_alipay_qr',
      channelTradeNo: snapshot.channelTradeNo,
      outTradeNo: snapshot.outTradeNo,
      amountCents: snapshot.amountCents,
      currency: snapshot.currency,
    };

    const calls: Array<{ label: string; outcome: 'SUCCESS' | 'FAILURE'; amountCents: number }> =
      input.mode === 'duplicate'
        ? [
            { label: '第 1 次回调', outcome: input.outcome, amountCents: base.amountCents },
            { label: '重复回调（相同报文）', outcome: input.outcome, amountCents: base.amountCents },
          ]
        : input.mode === 'out_of_order'
          ? [
              { label: '先到：支付成功', outcome: 'SUCCESS', amountCents: base.amountCents },
              { label: '迟到：支付失败', outcome: 'FAILURE', amountCents: base.amountCents },
            ]
          : input.mode === 'tamper_amount'
            ? [
                {
                  label: '篡改金额 +1 分',
                  outcome: input.outcome,
                  amountCents: base.amountCents + 1,
                },
              ]
            : [
                {
                  label: input.outcome === 'SUCCESS' ? '支付成功' : '支付失败',
                  outcome: input.outcome,
                  amountCents: base.amountCents,
                },
              ];

    const results: unknown[] = [];
    for (const call of calls) {
      const signed = buildSignedCallback({
        ...base,
        amountCents: call.amountCents,
        outcome: call.outcome,
      });
      try {
        results.push({
          label: call.label,
          ...paymentService.handleChannelCallback(signed.rawBody, signed.headers),
        });
      } catch (error) {
        results.push({
          label: call.label,
          accepted: false,
          code: error instanceof DomainError ? error.code : 'ERROR',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { results, order: paymentService.getOrder(input.tenantId, input.orderId) };
  }

  tenants(): unknown[] {
    return listTenants().map((tenant) => ({
      ...tenant,
      apps: listApps(tenant.id),
    }));
  }

  credentials(tenantId: string): unknown[] {
    return listApps(tenantId);
  }

  reconciliation(tenantId: string, date?: string): Record<string, unknown> {
    return {
      batches: listBatches(tenantId),
      diffs: listDiffs(tenantId),
      lastRun: date ? runReconciliation(tenantId, date) : null,
    };
  }

  runReconcile(tenantId: string, date?: string): Record<string, unknown> {
    const result = runReconciliation(tenantId, date || today());
    return { ...result, batches: listBatches(tenantId), diffs: listDiffs(tenantId) };
  }

  ledger(tenantId: string): Record<string, unknown> {
    return { entries: listLedger(tenantId), balance: ledgerBalance(tenantId) };
  }

  webhooks(tenantId: string): Record<string, unknown> {
    return { deliveries: listDeliveries(tenantId), stats: webhookStats(tenantId) };
  }

  retryWebhook(tenantId: string, id: string): Record<string, unknown> {
    return { ok: retryDelivery(tenantId, id) };
  }

  auditLog(tenantId: string): unknown[] {
    return listAudit(tenantId);
  }

  metrics(): Record<string, unknown> {
    const rows = db.all<Row>('SELECT status, COUNT(*) AS cnt FROM payment_orders GROUP BY status');
    const health = channelRouter.listHealth();
    return {
      uptimeSec: Math.round(process.uptime()),
      nodeVersion: process.version,
      ordersByStatus: Object.fromEntries(rows.map((r) => [r.status, r.cnt])),
      breakerStates: Object.fromEntries(health.map((h) => [h.channelCode, h.state])),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      flags: allFlags(),
    };
  }
}

export const consoleService = new ConsoleApplicationService();
