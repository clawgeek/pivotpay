/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Node 22 内置 SQLite（实验特性，启动需 --experimental-sqlite）。
// 使用 require 避免依赖 @types/node 中尚未稳定的 node:sqlite 声明。
const sqlite = require('node:sqlite') as { DatabaseSync: new (file: string) => any };

export type Row = Record<string, any>;

export const DATA_DIR =
  process.env.PIVOTPAY_DATA_DIR || path.resolve(process.cwd(), 'data');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'standard', status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS merchant_apps (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  app_id TEXT UNIQUE NOT NULL, api_key TEXT UNIQUE NOT NULL,
  api_secret TEXT NOT NULL, webhook_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id TEXT NOT NULL, idem_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  response_json TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idem_key)
);
CREATE TABLE IF NOT EXISTS payment_orders (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, app_id TEXT NOT NULL,
  out_trade_no TEXT NOT NULL, subject TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, currency TEXT NOT NULL,
  status TEXT NOT NULL, method TEXT NOT NULL,
  channel_code TEXT, channel_trade_no TEXT,
  notify_url TEXT, client_ip TEXT, metadata_json TEXT,
  paid_at TEXT, closed_at TEXT, expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, out_trade_no)
);
CREATE INDEX IF NOT EXISTS idx_orders_tenant_created
  ON payment_orders(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON payment_orders(status);
CREATE TABLE IF NOT EXISTS payment_attempts (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, channel_code TEXT NOT NULL,
  attempt_no INTEGER NOT NULL, outcome TEXT NOT NULL,
  latency_ms INTEGER NOT NULL, error_code TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, order_id TEXT NOT NULL,
  out_refund_no TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  reason TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (tenant_id, out_refund_no)
);
CREATE TABLE IF NOT EXISTS channel_defs (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  mode TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  weight INTEGER NOT NULL DEFAULT 100, fee_bps INTEGER NOT NULL DEFAULT 60,
  methods TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}',
  description TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS channel_health (
  channel_code TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'CLOSED',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  ewma_latency_ms REAL NOT NULL DEFAULT 0,
  opened_at TEXT, force_fail INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, event_id TEXT NOT NULL,
  event_type TEXT NOT NULL, target_url TEXT NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT,
  last_error TEXT, delivered_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_pending
  ON webhook_deliveries(status, next_retry_at);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, order_id TEXT,
  account TEXT NOT NULL, direction TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, memo TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reconciliation_batches (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, biz_date TEXT NOT NULL,
  status TEXT NOT NULL, total_count INTEGER NOT NULL,
  matched_count INTEGER NOT NULL, diff_count INTEGER NOT NULL,
  created_at TEXT NOT NULL, UNIQUE (tenant_id, biz_date)
);
CREATE TABLE IF NOT EXISTS reconciliation_diffs (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, out_trade_no TEXT NOT NULL,
  kind TEXT NOT NULL, local_cents INTEGER, channel_cents INTEGER,
  note TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, resource TEXT NOT NULL, detail_json TEXT NOT NULL,
  trace_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_callbacks (
  id TEXT PRIMARY KEY, channel_trade_no TEXT NOT NULL,
  channel_code TEXT NOT NULL, outcome TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (channel_code, channel_trade_no, outcome)
);
CREATE TABLE IF NOT EXISTS runtime_flags (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
`;

class SqliteDatabase {
  private readonly handle: any;

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
    this.handle = new sqlite.DatabaseSync(path.join(DATA_DIR, 'pivotpay.db'));
    this.handle.exec('PRAGMA journal_mode = WAL;');
    this.handle.exec('PRAGMA foreign_keys = ON;');
    this.handle.exec(SCHEMA);
  }

  private normalize(value: unknown): unknown {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    if (value !== null && typeof value === 'object') return JSON.stringify(value);
    return value;
  }

  private args(params: unknown[]): unknown[] {
    return params.map((p) => this.normalize(p));
  }

  exec(sql: string): void {
    this.handle.exec(sql);
  }

  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.handle.prepare(sql).run(...this.args(params));
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.handle.prepare(sql).get(...this.args(params)) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.handle.prepare(sql).all(...this.args(params)) as T[];
  }

  /** 同步事务：Node 单线程 + 同步 SQLite 调用，事务内不会被其他请求插入 */
  transaction<T>(fn: () => T): T {
    this.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  /** 健康检查用：确认库可读可写 */
  isWritable(): boolean {
    try {
      this.exec('CREATE TABLE IF NOT EXISTS _health_probe (x INTEGER)');
      this.run('INSERT INTO _health_probe (x) VALUES (?)', 1);
      this.run('DELETE FROM _health_probe');
      return true;
    } catch {
      return false;
    }
  }
}

export const db = new SqliteDatabase();
