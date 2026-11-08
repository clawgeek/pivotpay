/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useState } from 'react';

export const TENANT_STORAGE_KEY = 'pivotpay.tenant';

export function getTenantId(): string {
  return localStorage.getItem(TENANT_STORAGE_KEY) || 'tenant_demo';
}

export function setTenantId(id: string): void {
  localStorage.setItem(TENANT_STORAGE_KEY, id);
}

function consoleHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'X-Tenant-Id': getTenantId(),
  };
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const text = await response.text();
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text };
  }
  if (!response.ok) {
    throw new Error(payload.message || `${response.status} ${response.statusText}`);
  }
  return payload as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET', headers: consoleHeaders() });
}

export function apiPost<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: consoleHeaders(),
    body: JSON.stringify(body),
  });
}

export function apiPatch<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, {
    method: 'PATCH',
    headers: consoleHeaders(),
    body: JSON.stringify(body),
  });
}

/** 与后端 shared/kernel.ts 的 stableStringify 完全一致 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(digest);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  );
  return toHex(signature);
}

export interface MerchantCredential {
  apiKey: string;
  apiSecret: string;
}

/**
 * 真实商户开放 API 调用：浏览器 Web Crypto 计算 HMAC-SHA256，
 * 与后端 authenticateMerchant 使用同一套规范串，不是 mock。
 */
export async function signedMerchantApi<T>(
  method: 'POST' | 'GET',
  path: string,
  body: Record<string, unknown>,
  credential: MerchantCredential,
  idempotencyKey?: string,
): Promise<T> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  const canonical = [
    method,
    path.split('?')[0],
    timestamp,
    nonce,
    await sha256Hex(stableStringify(body ?? {})),
  ].join('\n');
  const signature = await hmacHex(credential.apiSecret, canonical);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'X-Api-Key': credential.apiKey,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': signature,
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return request<T>(path, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

/** 轻量数据 hook：支持手动刷新与轮询 */
export function useApi<T>(
  path: string | null,
  refreshKey = 0,
  intervalMs = 0,
): {
  data: T | null;
  error: string;
  loading: boolean;
  reload: () => Promise<void>;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const result = await apiGet<T>(path);
      setData(result);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    void reload();
    if (intervalMs > 0) {
      const timer = window.setInterval(() => void reload(), intervalMs);
      return () => window.clearInterval(timer);
    }
    return undefined;
  }, [path, refreshKey, intervalMs, reload]);

  return { data, error, loading, reload };
}

export function yuan(cents: number): string {
  return `¥${(cents / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function shortTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
