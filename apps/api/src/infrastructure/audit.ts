import { db } from '../infrastructure/database';
import { nowIso, uid } from '../shared/kernel';

export function audit(
  tenantId: string,
  actor: string,
  action: string,
  resource: string,
  detail: Record<string, unknown> = {},
  traceId = uid('trc'),
): string {
  db.run(
    `INSERT INTO audit_logs
     (id, tenant_id, actor, action, resource, detail_json, trace_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    uid('aud'),
    tenantId,
    actor,
    action,
    resource,
    detail,
    traceId,
    nowIso(),
  );
  return traceId;
}

export function listAudit(tenantId: string, limit = 100): unknown[] {
  return db.all(
    `SELECT id, actor, action, resource, detail_json AS detailJson,
            trace_id AS traceId, created_at AS createdAt
     FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
    tenantId,
    limit,
  );
}
