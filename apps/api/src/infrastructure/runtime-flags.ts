import { db } from '../infrastructure/database';

/** 运行时故障注入开关，供沙箱演练与熔断验证使用 */
export function getFlag(key: string, fallback = ''): string {
  const row = db.get<{ value: string }>(
    'SELECT value FROM runtime_flags WHERE key = ?',
    key,
  );
  return row ? row.value : fallback;
}

export function getNumberFlag(key: string, fallback = 0): number {
  const value = Number.parseFloat(getFlag(key, ''));
  return Number.isFinite(value) ? value : fallback;
}

export function setFlag(key: string, value: string | number): void {
  db.run(
    `INSERT INTO runtime_flags (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    String(value),
  );
}

export function allFlags(): Record<string, string> {
  const rows = db.all<{ key: string; value: string }>(
    'SELECT key, value FROM runtime_flags ORDER BY key',
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
