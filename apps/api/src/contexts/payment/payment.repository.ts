import { db, type Row } from '../../infrastructure/database';
import { DomainError, nowIso, uid } from '../../shared/kernel';
import {
  PaymentOrder,
  type PaymentMethod,
  type PaymentOrderSnapshot,
  type PaymentStatus,
} from './payment-order.domain';

const COLUMNS = `id, tenant_id AS tenantId, app_id AS appId,
  out_trade_no AS outTradeNo, subject, amount_cents AS amountCents, currency,
  status, method, channel_code AS channelCode,
  channel_trade_no AS channelTradeNo, notify_url AS notifyUrl,
  client_ip AS clientIp, metadata_json AS metadataJson,
  paid_at AS paidAt, closed_at AS closedAt, expires_at AS expiresAt,
  created_at AS createdAt, updated_at AS updatedAt, version`;

function toSnapshot(row: Row): PaymentOrderSnapshot {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(String(row.metadataJson || '{}')) as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    appId: String(row.appId),
    outTradeNo: String(row.outTradeNo),
    subject: String(row.subject),
    amountCents: Number(row.amountCents),
    currency: String(row.currency),
    status: row.status as PaymentStatus,
    method: row.method as PaymentMethod,
    channelCode: row.channelCode ? String(row.channelCode) : null,
    channelTradeNo: row.channelTradeNo ? String(row.channelTradeNo) : null,
    notifyUrl: row.notifyUrl ? String(row.notifyUrl) : null,
    clientIp: row.clientIp ? String(row.clientIp) : null,
    metadata,
    paidAt: row.paidAt ? String(row.paidAt) : null,
    closedAt: row.closedAt ? String(row.closedAt) : null,
    expiresAt: String(row.expiresAt),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    version: Number(row.version || 0),
  };
}

function load(sql: string, ...params: unknown[]): PaymentOrder | null {
  const row = db.get<Row>(sql, ...params);
  return row ? PaymentOrder.fromSnapshot(toSnapshot(row)) : null;
}

export function findOrderById(id: string): PaymentOrder | null {
  return load(`SELECT ${COLUMNS} FROM payment_orders WHERE id = ?`, id);
}

export function findOrderByOutTradeNo(
  tenantId: string,
  outTradeNo: string,
): PaymentOrder | null {
  return load(
    `SELECT ${COLUMNS} FROM payment_orders WHERE tenant_id = ? AND out_trade_no = ?`,
    tenantId,
    outTradeNo,
  );
}

export function findOrderByChannelTradeNo(channelTradeNo: string): PaymentOrder | null {
  return load(
    `SELECT ${COLUMNS} FROM payment_orders WHERE channel_trade_no = ?`,
    channelTradeNo,
  );
}

export function insertOrder(order: PaymentOrder): void {
  const s = order.toSnapshot();
  db.run(
    `INSERT INTO payment_orders
     (id, tenant_id, app_id, out_trade_no, subject, amount_cents, currency,
      status, method, channel_code, channel_trade_no, notify_url, client_ip,
      metadata_json, paid_at, closed_at, expires_at, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    s.id,
    s.tenantId,
    s.appId,
    s.outTradeNo,
    s.subject,
    s.amountCents,
    s.currency,
    s.status,
    s.method,
    s.channelCode,
    s.channelTradeNo,
    s.notifyUrl,
    s.clientIp,
    s.metadata,
    s.paidAt,
    s.closedAt,
    s.expiresAt,
    s.createdAt,
    s.updatedAt,
    s.version,
  );
}

/** 乐观并发控制：以数据库当前 version 做 CAS，防止并发回调重复推进状态 */
export function saveOrder(order: PaymentOrder): void {
  const s = order.toSnapshot();
  const current = db.get<{ version: number }>(
    'SELECT version FROM payment_orders WHERE id = ?',
    s.id,
  );
  if (!current) {
    throw new DomainError('ORDER_NOT_FOUND', '订单不存在', 404);
  }
  const result = db.run(
    `UPDATE payment_orders SET status = ?, channel_code = ?, channel_trade_no = ?,
      paid_at = ?, closed_at = ?, updated_at = ?, metadata_json = ?,
      version = version + 1
     WHERE id = ? AND version = ?`,
    s.status,
    s.channelCode,
    s.channelTradeNo,
    s.paidAt,
    s.closedAt,
    s.updatedAt,
    s.metadata,
    s.id,
    current.version,
  );
  if (result.changes === 0) {
    throw new DomainError('CONCURRENT_MODIFICATION', '订单已被并发修改，请重试', 409);
  }
}

export interface OrderQuery {
  tenantId: string;
  status?: string;
  channelCode?: string;
  keyword?: string;
  limit?: number;
  offset?: number;
}

export function listOrders(query: OrderQuery): { rows: unknown[]; total: number } {
  const where = ['tenant_id = ?'];
  const params: unknown[] = [query.tenantId];
  if (query.status) {
    where.push('status = ?');
    params.push(query.status);
  }
  if (query.channelCode) {
    where.push('channel_code = ?');
    params.push(query.channelCode);
  }
  if (query.keyword) {
    where.push('(out_trade_no LIKE ? OR id LIKE ? OR channel_trade_no LIKE ?)');
    const like = `%${query.keyword}%`;
    params.push(like, like, like);
  }
  const clause = where.join(' AND ');
  const total = Number(
    db.get<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM payment_orders WHERE ${clause}`,
      ...params,
    )?.cnt || 0,
  );
  const rows = db.all(
    `SELECT ${COLUMNS} FROM payment_orders WHERE ${clause}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ...params,
    query.limit ?? 50,
    query.offset ?? 0,
  );
  return { rows, total };
}

export function insertAttempt(
  orderId: string,
  channelCode: string,
  attemptNo: number,
  outcome: string,
  latencyMs: number,
  errorCode: string | null,
): void {
  db.run(
    `INSERT INTO payment_attempts
     (id, order_id, channel_code, attempt_no, outcome, latency_ms, error_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    uid('att'),
    orderId,
    channelCode,
    attemptNo,
    outcome,
    latencyMs,
    errorCode,
    nowIso(),
  );
}

export function listAttempts(orderId: string): unknown[] {
  return db.all(
    `SELECT id, channel_code AS channelCode, attempt_no AS attemptNo,
            outcome, latency_ms AS latencyMs, error_code AS errorCode,
            created_at AS createdAt
     FROM payment_attempts WHERE order_id = ? ORDER BY created_at, attempt_no`,
    orderId,
  );
}

export function sumRefundedCents(orderId: string): number {
  return Number(
    db.get<{ total: number }>(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refunds
       WHERE order_id = ? AND status = 'SUCCESS'`,
      orderId,
    )?.total || 0,
  );
}

export function insertRefund(input: {
  orderId: string;
  tenantId: string;
  outRefundNo: string;
  amountCents: number;
  reason: string;
}): string {
  const id = uid('ref');
  db.run(
    `INSERT INTO refunds
     (id, tenant_id, order_id, out_refund_no, amount_cents, reason, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'SUCCESS', ?)`,
    id,
    input.tenantId,
    input.orderId,
    input.outRefundNo,
    input.amountCents,
    input.reason,
    nowIso(),
  );
  return id;
}

export function listRefunds(tenantId: string, limit = 100): unknown[] {
  return db.all(
    `SELECT id, order_id AS orderId, out_refund_no AS outRefundNo,
            amount_cents AS amountCents, reason, status, created_at AS createdAt
     FROM refunds WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
    tenantId,
    limit,
  );
}
