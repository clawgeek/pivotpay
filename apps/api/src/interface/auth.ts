import { timingSafeEqual } from 'node:crypto';
import {
  DomainError,
  hmacHex,
  sha256Hex,
  stableStringify,
} from '../shared/kernel';
import {
  getAppByApiKey,
  requireTenant,
} from '../contexts/tenant/tenant.repository';
import type { MerchantAppSnapshot } from '../contexts/tenant/tenant.domain';

export interface RequestLike {
  method: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

function readHeader(req: RequestLike, name: string): string {
  const raw = req.headers[name.toLowerCase()] ?? req.headers[name];
  return Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
}

function requestPath(req: RequestLike): string {
  return (req.originalUrl || req.url || '/').split('?')[0];
}

/** 构造商户 API 签名串（前后端必须完全一致） */
export function canonicalString(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: unknown;
}): string {
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    sha256Hex(stableStringify(input.body ?? {})),
  ].join('\n');
}

const nonceCache = new Map<string, number>();

export interface MerchantAuth {
  tenantId: string;
  appId: string;
  app: MerchantAppSnapshot;
}

/** 商户 API 鉴权：HMAC-SHA256 + 时间戳窗口 + nonce 防重放 */
export function authenticateMerchant(req: RequestLike): MerchantAuth {
  const apiKey = readHeader(req, 'x-api-key');
  const timestamp = readHeader(req, 'x-timestamp');
  const nonce = readHeader(req, 'x-nonce');
  const signature = readHeader(req, 'x-signature');
  if (!apiKey || !timestamp || !nonce || !signature) {
    throw new DomainError('UNAUTHORIZED', '缺少签名头：X-Api-Key / X-Timestamp / X-Nonce / X-Signature', 401);
  }
  const app = getAppByApiKey(apiKey);
  if (!app) throw new DomainError('UNAUTHORIZED', 'API Key 无效', 401);
  if (app.status !== 'active') throw new DomainError('APP_DISABLED', '应用已停用', 403);

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    throw new DomainError('SIGNATURE_EXPIRED', '请求时间戳超出 5 分钟窗口', 401);
  }
  const now = Date.now();
  for (const [key, expireAt] of nonceCache) {
    if (expireAt < now) nonceCache.delete(key);
  }
  if (nonceCache.has(nonce)) {
    throw new DomainError('REPLAY_DETECTED', 'nonce 已使用，拒绝重放请求', 401);
  }

  const expected = hmacHex(
    app.apiSecret,
    canonicalString({
      method: req.method,
      path: requestPath(req),
      timestamp,
      nonce,
      body: req.body,
    }),
  );
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new DomainError('INVALID_SIGNATURE', '签名校验失败', 401);
  }
  nonceCache.set(nonce, now + 300_000);
  requireTenant(app.tenantId);
  return { tenantId: app.tenantId, appId: app.id, app };
}

/** 控制台鉴权：演示环境用 X-Tenant-Id 做租户隔离，生产应替换为 SSO + RBAC */
export function authenticateConsole(req: RequestLike): string {
  const tenantId = readHeader(req, 'x-tenant-id');
  if (!tenantId) {
    throw new DomainError('TENANT_HEADER_REQUIRED', '缺少 X-Tenant-Id', 400);
  }
  requireTenant(tenantId);
  return tenantId;
}
