import { db } from '../../infrastructure/database';
import { nowIso, uid } from '../../shared/kernel';
import type { PaymentOrderSnapshot } from '../payment/payment-order.domain';

/**
 * 复式记账：每笔资金变动同时记借贷两方，保证 Σ借方 = Σ贷方。
 * 平台只记录账务流水，不设资金池、不做二次清结算。
 */
export function postPaymentEntries(order: PaymentOrderSnapshot, feeBps: number): void {
  const amount = order.amountCents;
  const fee = Math.floor((amount * feeBps) / 10_000);
  const net = amount - fee;
  const now = nowIso();
  const entries: Array<[string, 'DEBIT' | 'CREDIT', number, string]> = [
    ['CHANNEL_RECEIVABLE', 'DEBIT', amount, '通道应收（客户实付）'],
    ['MERCHANT_SETTLEABLE', 'CREDIT', net, '商户可结算'],
    ['PLATFORM_FEE_INCOME', 'CREDIT', fee, '平台手续费收入'],
  ];
  for (const [account, direction, cents, memo] of entries) {
    db.run(
      `INSERT INTO ledger_entries
       (id, tenant_id, order_id, account, direction, amount_cents, memo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      uid('ldg'),
      order.tenantId,
      order.id,
      account,
      direction,
      cents,
      memo,
      now,
    );
  }
}

export function postRefundEntries(
  tenantId: string,
  orderId: string,
  amountCents: number,
): void {
  const now = nowIso();
  const entries: Array<[string, 'DEBIT' | 'CREDIT', string]> = [
    ['MERCHANT_SETTLEABLE', 'DEBIT', '冲减商户可结算'],
    ['CHANNEL_RECEIVABLE', 'CREDIT', '通道退款应付'],
  ];
  for (const [account, direction, memo] of entries) {
    db.run(
      `INSERT INTO ledger_entries
       (id, tenant_id, order_id, account, direction, amount_cents, memo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      uid('ldg'),
      tenantId,
      orderId,
      account,
      direction,
      amountCents,
      memo,
      now,
    );
  }
}

export function listLedger(tenantId: string, limit = 100): unknown[] {
  return db.all(
    `SELECT id, account, direction, amount_cents AS amountCents, memo,
            order_id AS orderId, created_at AS createdAt
     FROM ledger_entries WHERE tenant_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    tenantId,
    limit,
  );
}

export function ledgerBalance(tenantId: string): { debit: number; credit: number; balanced: boolean } {
  const row = db.get<{ debit: number; credit: number }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_cents ELSE 0 END), 0) AS debit,
            COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE 0 END), 0) AS credit
     FROM ledger_entries WHERE tenant_id = ?`,
    tenantId,
  );
  const debit = Number(row?.debit || 0);
  const credit = Number(row?.credit || 0);
  return { debit, credit, balanced: debit === credit };
}
