import { db, type Row } from '../../infrastructure/database';
import { DomainError } from '../../shared/kernel';
import { Tenant, type MerchantAppSnapshot, type TenantSnapshot } from './tenant.domain';

export function getTenant(tenantId: string): Tenant | null {
  const row = db.get<Row>(
    `SELECT id, code, name, plan, status, created_at AS createdAt
     FROM tenants WHERE id = ?`,
    tenantId,
  );
  return row ? Tenant.of(row as unknown as TenantSnapshot) : null;
}

export function requireTenant(tenantId: string): Tenant {
  const tenant = getTenant(tenantId);
  if (!tenant) {
    throw new DomainError('TENANT_NOT_FOUND', '租户不存在', 404);
  }
  tenant.assertActive();
  return tenant;
}

export function listTenants(): TenantSnapshot[] {
  return db.all(
    `SELECT id, code, name, plan, status, created_at AS createdAt
     FROM tenants ORDER BY created_at`,
  ) as TenantSnapshot[];
}

export function listApps(tenantId?: string): MerchantAppSnapshot[] {
  const sql = `SELECT id, tenant_id AS tenantId, name, app_id AS appId,
    api_key AS apiKey, api_secret AS apiSecret,
    webhook_url AS webhookUrl, status, created_at AS createdAt
    FROM merchant_apps ${tenantId ? 'WHERE tenant_id = ?' : ''} ORDER BY created_at`;
  return (tenantId ? db.all(sql, tenantId) : db.all(sql)) as MerchantAppSnapshot[];
}

export function getAppById(appId: string): MerchantAppSnapshot | null {
  const row = db.get<Row>(
    `SELECT id, tenant_id AS tenantId, name, app_id AS appId,
      api_key AS apiKey, api_secret AS apiSecret,
      webhook_url AS webhookUrl, status, created_at AS createdAt
     FROM merchant_apps WHERE id = ?`,
    appId,
  );
  return row ? (row as unknown as MerchantAppSnapshot) : null;
}

export function getAppByApiKey(apiKey: string): MerchantAppSnapshot | null {
  const row = db.get<Row>(
    `SELECT id, tenant_id AS tenantId, name, app_id AS appId,
      api_key AS apiKey, api_secret AS apiSecret,
      webhook_url AS webhookUrl, status, created_at AS createdAt
     FROM merchant_apps WHERE api_key = ?`,
    apiKey,
  );
  return row ? (row as unknown as MerchantAppSnapshot) : null;
}
