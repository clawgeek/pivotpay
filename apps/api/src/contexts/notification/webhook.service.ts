import { db } from '../../infrastructure/database';
import { audit } from '../../infrastructure/audit';
import { getFlag } from '../../infrastructure/runtime-flags';
import { hmacHex, nowIso, uid, type DomainEvent } from '../../shared/kernel';

interface Delivery {
  id: string;
  tenantId: string;
  eventType: string;
  targetUrl: string;
  payload: string;
  attemptCount: number;
}

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const MAX_ATTEMPTS = 5;

/**
 * Outbox 模式：与订单状态变更在「同一个数据库事务」内写入事件与投递任务，
 * 避免「订单已支付但通知丢失」的分布式不一致。
 */
export function enqueueDomainEvents(
  events: DomainEvent[],
  tenantId: string,
  targetUrl: string,
  apiSecret: string,
): void {
  for (const event of events) {
    const payload = JSON.stringify({
      eventId: event.eventId,
      eventType: event.type,
      aggregateId: event.aggregateId,
      occurredAt: event.occurredAt,
      data: event.payload,
    });
    db.run(
      `INSERT INTO outbox_events (id, aggregate_id, event_type, payload_json, published, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      event.eventId,
      event.aggregateId,
      event.type,
      payload,
      event.occurredAt,
    );
    db.run(
      `INSERT INTO webhook_deliveries
       (id, tenant_id, event_id, event_type, target_url, payload_json,
        status, attempt_count, next_retry_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
      uid('whk'),
      tenantId,
      event.eventId,
      event.type,
      targetUrl,
      payload,
      nowIso(),
      event.occurredAt,
    );
    // 记录签名密钥指纹，便于审计（不落明文密钥）
    audit(tenantId, 'system', 'OUTBOX_ENQUEUED', event.aggregateId, {
      eventType: event.type,
      secretFingerprint: hmacHex(apiSecret, event.eventId).slice(0, 12),
    });
    db.run(
      'UPDATE outbox_events SET published = 1 WHERE id = ?',
      event.eventId,
    );
  }
}

export function listDeliveries(tenantId: string, limit = 100): unknown[] {
  return db
    .all<Record<string, unknown>>(
      `SELECT id, tenant_id AS tenantId, event_id AS eventId,
              event_type AS eventType, target_url AS targetUrl,
              status, attempt_count AS attemptCount,
              next_retry_at AS nextRetryAt, last_error AS lastError,
              delivered_at AS deliveredAt, created_at AS createdAt
       FROM webhook_deliveries
       WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
      tenantId,
      limit,
    )
    .map((row) => ({ ...row, payload: undefined }));
}

let draining = false;

/** 后台派发器：指数退避 + 死信队列，故障注入可强制失败 */
export async function drainWebhooks(): Promise<number> {
  if (draining) return 0;
  draining = true;
  let handled = 0;
  try {
    const now = nowIso();
    const rows = db.all<Record<string, unknown>>(
      `SELECT id, tenant_id AS tenantId, event_type AS eventType,
              target_url AS targetUrl, payload_json AS payload,
              attempt_count AS attemptCount
       FROM webhook_deliveries
       WHERE status = 'PENDING' AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY created_at ASC LIMIT 20`,
      now,
    );
    for (const raw of rows) {
      const delivery: Delivery = {
        id: String(raw.id),
        tenantId: String(raw.tenantId),
        eventType: String(raw.eventType),
        targetUrl: String(raw.targetUrl),
        payload: String(raw.payload),
        attemptCount: Number(raw.attemptCount || 0),
      };
      const app = db.get<{ api_secret: string }>(
        'SELECT api_secret FROM merchant_apps WHERE tenant_id = ? ORDER BY created_at LIMIT 1',
        delivery.tenantId,
      );
      const signature = hmacHex(app?.api_secret || 'pivotpay', delivery.payload);
      const forceFail = getFlag('force_webhook_fail', '0') === '1';
      const timeoutFlag = getFlag('webhook_receiver_down', '0') === '1';

      let ok = false;
      let error = '';
      try {
        if (forceFail || timeoutFlag) {
          throw new Error('故障注入：接收端不可用');
        }
        const response = await fetch(delivery.targetUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-pivotpay-signature': signature,
            'x-pivotpay-event': delivery.eventType,
          },
          body: delivery.payload,
          signal: AbortSignal.timeout(2_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        ok = true;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      const attempt = delivery.attemptCount + 1;
      if (ok) {
        db.run(
          `UPDATE webhook_deliveries SET status = 'DELIVERED', attempt_count = ?,
           delivered_at = ?, last_error = NULL, next_retry_at = NULL WHERE id = ?`,
          attempt,
          nowIso(),
          delivery.id,
        );
      } else if (attempt >= MAX_ATTEMPTS) {
        db.run(
          `UPDATE webhook_deliveries SET status = 'DEAD', attempt_count = ?,
           last_error = ?, next_retry_at = NULL WHERE id = ?`,
          attempt,
          error,
          delivery.id,
        );
      } else {
        const delay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
        db.run(
          `UPDATE webhook_deliveries SET attempt_count = ?, last_error = ?,
           next_retry_at = ? WHERE id = ?`,
          attempt,
          error,
          new Date(Date.now() + delay).toISOString(),
          delivery.id,
        );
      }
      handled += 1;
    }
  } finally {
    draining = false;
  }
  return handled;
}

export function retryDelivery(tenantId: string, id: string): boolean {
  const row = db.get<{ id: string }>(
    'SELECT id FROM webhook_deliveries WHERE id = ? AND tenant_id = ?',
    id,
    tenantId,
  );
  if (!row) return false;
  db.run(
    `UPDATE webhook_deliveries SET status = 'PENDING', attempt_count = 0,
     last_error = NULL, next_retry_at = ?, delivered_at = NULL WHERE id = ?`,
    nowIso(),
    id,
  );
  return true;
}

export function webhookStats(tenantId: string): Record<string, number> {
  const rows = db.all<{ status: string; cnt: number }>(
    'SELECT status, COUNT(*) AS cnt FROM webhook_deliveries WHERE tenant_id = ? GROUP BY status',
    tenantId,
  );
  return Object.fromEntries(rows.map((r) => [r.status.toLowerCase(), r.cnt]));
}
