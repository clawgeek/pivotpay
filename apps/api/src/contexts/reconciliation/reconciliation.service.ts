import { db, type Row } from '../../infrastructure/database';
import { nowIso, uid } from '../../shared/kernel';
import { audit } from '../../infrastructure/audit';

export interface DiffItem {
  outTradeNo: string;
  kind: 'AMOUNT_MISMATCH' | 'MISSING_IN_CHANNEL' | 'MISSING_IN_LOCAL';
  localCents: number | null;
  channelCents: number | null;
  note: string;
}

/**
 * 日终对账：与通道账单逐笔核对。
 * 通道账单由沙箱按确定性规则生成，并刻意注入三类差异，
 * 用于演示差异发现与人工处置流程（不接入任何真实资金清算）。
 */
export function runReconciliation(tenantId: string, bizDate: string): {
  id: string;
  totalCount: number;
  matchedCount: number;
  diffCount: number;
  diffs: DiffItem[];
} {
  const local = db.all<Row>(
    `SELECT out_trade_no AS outTradeNo, amount_cents AS amountCents, status
     FROM payment_orders
     WHERE tenant_id = ? AND substr(created_at, 1, 10) = ?
       AND status IN ('PAID', 'PARTIAL_REFUNDED', 'REFUNDED')
     ORDER BY out_trade_no`,
    tenantId,
    bizDate,
  );

  const channelBill = new Map<string, number>();
  for (const row of local) {
    channelBill.set(String(row.outTradeNo), Number(row.amountCents));
  }

  // 确定性差异注入：取排序后的第 1、2 笔
  if (local.length >= 1) {
    const first = String(local[0].outTradeNo);
    channelBill.set(first, Math.max(0, Number(local[0].amountCents) - 1));
  }
  if (local.length >= 2) {
    channelBill.delete(String(local[1].outTradeNo));
  }
  // 通道侧多出一笔（本地无）
  channelBill.set(`CH_ONLY_${bizDate.replace(/-/g, '')}_001`, 19900);

  const diffs: DiffItem[] = [];
  let matched = 0;
  const localMap = new Map(local.map((r) => [String(r.outTradeNo), Number(r.amountCents)]));

  for (const [outTradeNo, localCents] of localMap) {
    const channelCents = channelBill.get(outTradeNo);
    if (channelCents === undefined) {
      diffs.push({
        outTradeNo,
        kind: 'MISSING_IN_CHANNEL',
        localCents,
        channelCents: null,
        note: '本地有支付成功记录，通道账单缺失（挂账待查）',
      });
    } else if (channelCents !== localCents) {
      diffs.push({
        outTradeNo,
        kind: 'AMOUNT_MISMATCH',
        localCents,
        channelCents,
        note: `金额不一致，差额 ${localCents - channelCents} 分`,
      });
    } else {
      matched += 1;
    }
  }
  for (const [outTradeNo, channelCents] of channelBill) {
    if (!localMap.has(outTradeNo)) {
      diffs.push({
        outTradeNo,
        kind: 'MISSING_IN_LOCAL',
        localCents: null,
        channelCents,
        note: '通道有收款记录，本地无对应订单（疑似掉单）',
      });
    }
  }

  const batchId = uid('rec');
  db.transaction(() => {
    db.run(
      'DELETE FROM reconciliation_diffs WHERE batch_id IN (SELECT id FROM reconciliation_batches WHERE tenant_id = ? AND biz_date = ?)',
      tenantId,
      bizDate,
    );
    db.run(
      'DELETE FROM reconciliation_batches WHERE tenant_id = ? AND biz_date = ?',
      tenantId,
      bizDate,
    );
    db.run(
      `INSERT INTO reconciliation_batches
       (id, tenant_id, biz_date, status, total_count, matched_count, diff_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      batchId,
      tenantId,
      bizDate,
      diffs.length > 0 ? 'WITH_DIFFS' : 'BALANCED',
      localMap.size + diffs.filter((d) => d.kind === 'MISSING_IN_LOCAL').length,
      matched,
      diffs.length,
      nowIso(),
    );
    for (const diff of diffs) {
      db.run(
        `INSERT INTO reconciliation_diffs
         (id, batch_id, out_trade_no, kind, local_cents, channel_cents, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        uid('dif'),
        batchId,
        diff.outTradeNo,
        diff.kind,
        diff.localCents,
        diff.channelCents,
        diff.note,
      );
    }
    audit(tenantId, 'system', 'RECONCILIATION_RUN', bizDate, {
      matched,
      diffCount: diffs.length,
    });
  });

  return {
    id: batchId,
    totalCount: localMap.size,
    matchedCount: matched,
    diffCount: diffs.length,
    diffs,
  };
}

export function listBatches(tenantId: string): unknown[] {
  return db.all(
    `SELECT id, biz_date AS bizDate, status, total_count AS totalCount,
            matched_count AS matchedCount, diff_count AS diffCount,
            created_at AS createdAt
     FROM reconciliation_batches WHERE tenant_id = ?
     ORDER BY biz_date DESC`,
    tenantId,
  );
}

export function listDiffs(tenantId: string, batchId?: string): unknown[] {
  if (batchId) {
    return db.all(
      `SELECT d.id, d.batch_id AS batchId, d.out_trade_no AS outTradeNo,
              d.kind, d.local_cents AS localCents,
              d.channel_cents AS channelCents, d.note
       FROM reconciliation_diffs d
       JOIN reconciliation_batches b ON b.id = d.batch_id
       WHERE b.tenant_id = ? AND d.batch_id = ? ORDER BY d.kind`,
      tenantId,
      batchId,
    );
  }
  return db.all(
    `SELECT d.id, d.batch_id AS batchId, d.out_trade_no AS outTradeNo,
            d.kind, d.local_cents AS localCents,
            d.channel_cents AS channelCents, d.note
     FROM reconciliation_diffs d
     JOIN reconciliation_batches b ON b.id = d.batch_id
     WHERE b.tenant_id = ? ORDER BY d.id DESC LIMIT 100`,
    tenantId,
  );
}
