import { db, type Row } from '../../infrastructure/database';
import { nowIso } from '../../shared/kernel';
import { channelAdapters } from '../channel/adapters';
import type { ChannelDefinition, ChannelMode } from '../channel/channel-port';
import type { PaymentMethod } from '../payment/payment-order.domain';

type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface ChannelHealthView {
  channelCode: string;
  name: string;
  kind: string;
  mode: ChannelMode;
  enabled: boolean;
  weight: number;
  feeBps: number;
  methods: string[];
  description: string;
  config: Record<string, unknown>;
  state: BreakerState;
  consecutiveFailures: number;
  successCount: number;
  failCount: number;
  ewmaLatencyMs: number;
  forceFail: boolean;
  openedAt: string | null;
  updatedAt: string;
  configured: boolean;
  score: number;
}

const OPEN_DURATION_MS = 30_000;
const FAILURE_THRESHOLD = 3;

function parseMethods(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function listChannelDefinitions(): ChannelDefinition[] {
  return db
    .all<Row>('SELECT * FROM channel_defs ORDER BY sort_order, code')
    .map((row) => ({
      code: String(row.code),
      name: String(row.name),
      kind: row.kind as ChannelDefinition['kind'],
      mode: row.mode as ChannelMode,
      enabled: Boolean(row.enabled),
      weight: Number(row.weight),
      feeBps: Number(row.fee_bps),
      methods: parseMethods(String(row.methods)) as PaymentMethod[],
      description: String(row.description || ''),
      config: (() => {
        try {
          return JSON.parse(String(row.config_json || '{}')) as Record<string, unknown>;
        } catch {
          return {};
        }
      })(),
      sortOrder: Number(row.sort_order || 0),
    }));
}

export function getChannelDefinition(code: string): ChannelDefinition | undefined {
  return listChannelDefinitions().find((c) => c.code === code);
}

/** 高可用通道路由：加权选择 + 三态熔断 + 自动排除故障通道 */
export class ChannelRouter {
  /** 选出一条可路由的通道；excluded 用于 failover 时排除已失败通道 */
  select(method: PaymentMethod, excluded: string[] = []): ChannelDefinition | null {
    const candidates = listChannelDefinitions()
      .filter((def) => def.enabled)
      .filter((def) => def.methods.includes(method))
      .filter((def) => !excluded.includes(def.code))
      .filter((def) => {
        const adapter = channelAdapters.get(def.code);
        return adapter?.isConfigured() === true;
      })
      .map((def) => ({ def, health: this.healthOf(def.code) }))
      .filter(({ health }) => health.state !== 'OPEN');

    if (candidates.length === 0) return null;

    const weighted = candidates.map(({ def, health }) => ({
      def,
      weight: Math.max(1, def.weight * (this.scoreOf(health) / 100)),
    }));
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    let cursor = Math.random() * total;
    for (const item of weighted) {
      cursor -= item.weight;
      if (cursor <= 0) return item.def;
    }
    return weighted[weighted.length - 1].def;
  }

  private healthOf(code: string): Row {
    const row = db.get<Row>('SELECT * FROM channel_health WHERE channel_code = ?', code);
    if (row) return row;
    db.run(
      `INSERT INTO channel_health
       (channel_code, state, consecutive_failures, success_count, fail_count,
        ewma_latency_ms, opened_at, force_fail, updated_at)
       VALUES (?, 'CLOSED', 0, 0, 0, 0, NULL, 0, ?)`,
      code,
      nowIso(),
    );
    return db.get<Row>('SELECT * FROM channel_health WHERE channel_code = ?', code)!;
  }

  private scoreOf(health: Row): number {
    const successes = Number(health.success_count || 0);
    const failures = Number(health.fail_count || 0);
    const total = successes + failures;
    const failRate = total > 0 ? failures / total : 0;
    const latencyPenalty = Math.min(25, Number(health.ewma_latency_ms || 0) / 40);
    const statePenalty = health.state === 'HALF_OPEN' ? 30 : 0;
    return Math.max(5, 100 - failRate * 100 - latencyPenalty - statePenalty);
  }

  recordSuccess(code: string, latencyMs: number): void {
    const health = this.healthOf(code);
    const ewma =
      successes(health) === 0
        ? latencyMs
        : 0.7 * Number(health.ewma_latency_ms || 0) + 0.3 * latencyMs;
    const nextState: BreakerState =
      health.state === 'HALF_OPEN' ? 'CLOSED' : (health.state as BreakerState);
    db.run(
      `UPDATE channel_health SET success_count = success_count + 1,
       consecutive_failures = 0, ewma_latency_ms = ?, state = ?,
       opened_at = NULL, updated_at = ? WHERE channel_code = ?`,
      ewma,
      nextState,
      nowIso(),
      code,
    );
  }

  recordFailure(code: string, _errorCode = 'UNKNOWN'): void {
    const health = this.healthOf(code);
    const consecutive = Number(health.consecutive_failures || 0) + 1;
    const shouldOpen = consecutive >= FAILURE_THRESHOLD || health.state === 'HALF_OPEN';
    db.run(
      `UPDATE channel_health SET fail_count = fail_count + 1,
       consecutive_failures = ?, state = ?, opened_at = ?, updated_at = ?
       WHERE channel_code = ?`,
      shouldOpen ? 0 : consecutive,
      shouldOpen ? 'OPEN' : (health.state as BreakerState),
      shouldOpen ? nowIso() : health.opened_at ?? null,
      nowIso(),
      code,
    );
  }

  /** 定时器调用：OPEN 超过冷却窗口后进入 HALF_OPEN，放行一次探测流量 */
  tick(): void {
    const openRows = db.all<Row>(
      "SELECT channel_code, opened_at FROM channel_health WHERE state = 'OPEN'",
    );
    for (const row of openRows) {
      const opened = row.opened_at ? new Date(String(row.opened_at)).getTime() : 0;
      if (Date.now() - opened > OPEN_DURATION_MS) {
        db.run(
          `UPDATE channel_health SET state = 'HALF_OPEN', consecutive_failures = 0,
           updated_at = ? WHERE channel_code = ?`,
          nowIso(),
          row.channel_code,
        );
      }
    }
  }

  listHealth(): ChannelHealthView[] {
    return listChannelDefinitions().map((def) => {
      const health = this.healthOf(def.code);
      return {
        channelCode: def.code,
        name: def.name,
        kind: def.kind,
        mode: def.mode,
        enabled: def.enabled,
        weight: def.weight,
        feeBps: def.feeBps,
        methods: def.methods,
        description: def.description,
        config: def.config,
        state: health.state as BreakerState,
        consecutiveFailures: Number(health.consecutive_failures || 0),
        successCount: Number(health.success_count || 0),
        failCount: Number(health.fail_count || 0),
        ewmaLatencyMs: Math.round(Number(health.ewma_latency_ms || 0)),
        forceFail: Boolean(health.force_fail),
        openedAt: health.opened_at ? String(health.opened_at) : null,
        updatedAt: String(health.updated_at),
        configured: channelAdapters.get(def.code)?.isConfigured() ?? false,
        score: Math.round(this.scoreOf(health)),
      };
    });
  }

  reset(code: string): void {
    db.run(
      `UPDATE channel_health SET state = 'CLOSED', consecutive_failures = 0,
       success_count = 0, fail_count = 0, ewma_latency_ms = 0,
       opened_at = NULL, updated_at = ? WHERE channel_code = ?`,
      nowIso(),
      code,
    );
  }
}

function successes(health: Row): number {
  return Number(health.success_count || 0) + Number(health.fail_count || 0);
}

export const channelRouter = new ChannelRouter();
