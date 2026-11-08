import React, { useState } from 'react';
import {
  apiGet, apiPost, shortTime, signedMerchantApi, useApi, yuan,
} from '../api/client';
import type { ChannelHealth, MerchantApp, PaymentOrder, PaymentAttempt } from '../types';
import {
  ActionButton, BreakerBadge, DataTable, KpiCard, Panel, type Column,
} from '../components/ui';

interface Candidate {
  code: string;
  name: string;
  weight: number;
  score: number;
  state: string;
  effectiveWeight: number;
  usable: boolean;
}

interface RoutingPolicy {
  strategy: string;
  failover: string;
  breaker: { stateMachine: string; failureThreshold: number; cooldownMs: number };
  idempotency: string;
  consistency: string;
  candidates: Candidate[];
}

interface Metrics {
  uptimeSec: number;
  nodeVersion: string;
  ordersByStatus: Record<string, number>;
  breakerStates: Record<string, string>;
  memoryMb: number;
  flags: Record<string, string>;
}

interface DrillResult {
  flags?: Record<string, string>;
  health?: ChannelHealth[];
}

export default function Routing(): React.ReactElement {
  const [refreshKey, setRefreshKey] = useState(0);
  const policy = useApi<RoutingPolicy>('/api/v1/console/routing', refreshKey, 15_000);
  const channels = useApi<ChannelHealth[]>('/api/v1/console/channels', refreshKey, 15_000);
  const metrics = useApi<Metrics>('/api/v1/console/metrics', refreshKey, 15_000);
  const creds = useApi<MerchantApp[]>('/api/v1/console/credentials');
  const [target, setTarget] = useState('mock_alipay_qr');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [attempts, setAttempts] = useState<PaymentAttempt[]>([]);

  const pushLog = (line: string) =>
    setLog((prev) => [`${new Date().toLocaleTimeString('zh-CN')}  ${line}`, ...prev].slice(0, 16));

  async function drill(action: string, value?: number): Promise<DrillResult | null> {
    setBusy(true);
    setMessage('');
    try {
      const result = await apiPost<DrillResult>('/api/v1/console/drill', {
        action,
        channelCode: target,
        value,
      });
      pushLog(`演练动作 ${action}${value !== undefined ? `(${value})` : ''} → ${target} 已执行`);
      setRefreshKey((k) => k + 1);
      return result;
    } catch (err) {
      setMessage(`演练失败：${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** 一键演练：强制主通道失败 → HMAC 签名下单 → 读取 failover 轨迹 → 恢复 */
  async function failoverShowcase(): Promise<void> {
    const cred = creds.data?.[0];
    if (!cred) {
      setMessage('商户凭据尚未加载，请稍后再试');
      return;
    }
    setBusy(true);
    setMessage('');
    setAttempts([]);
    try {
      pushLog('① 强制主通道下单失败');
      await apiPost('/api/v1/console/drill', { action: 'force_fail', channelCode: target });
      const body = {
        outTradeNo: `DRILL${Date.now()}`,
        subject: '高可用切换演练订单',
        amountCents: 12_800,
        currency: 'CNY',
        method: 'QRCODE',
        metadata: { scenario: 'failover-drill' },
      };
      pushLog('② 以商户开放 API（真实 HMAC 签名）创建支付订单');
      const order = await signedMerchantApi<PaymentOrder>(
        'POST', '/api/v1/payments', body, cred, `drill-${Date.now()}`,
      );
      const detail = await apiGet<PaymentOrder & { attempts: PaymentAttempt[] }>(
        `/api/v1/console/orders/${order.id}`,
      );
      setAttempts(detail.attempts || []);
      const used = (detail.attempts || []).map((a) => `${a.channelCode}:${a.outcome}`).join(' → ');
      pushLog(`③ 实际路由轨迹：${used || '无'}`);
      pushLog(`④ 最终通道 ${order.channelCode || '—'} · 订单 ${order.outTradeNo} · ${yuan(order.amountCents)}`);
      setMessage(`演练完成：订单 ${order.outTradeNo} 经 failover 落到 ${order.channelCode || '—'}，共 ${(detail.attempts || []).length} 次尝试`);
    } catch (err) {
      setMessage(`演练失败：${err instanceof Error ? err.message : String(err)}`);
      pushLog(`演练异常：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await apiPost('/api/v1/console/drill', { action: 'recover', channelCode: target }).catch(() => null);
      pushLog('⑤ 主通道已恢复强制失败标记');
      setBusy(false);
      setRefreshKey((k) => k + 1);
    }
  }

  const candidateColumns: Column<Candidate>[] = [
    { key: 'name', title: '通道', render: (r) => <span className="pp-strong">{r.name}</span> },
    { key: 'code', title: '编码', render: (r) => <span className="pp-mono pp-muted">{r.code}</span> },
    { key: 'weight', title: '静态权重', align: 'right' },
    { key: 'score', title: '健康分', align: 'right' },
    {
      key: 'effectiveWeight', title: '有效权重', align: 'right',
      render: (r) => (
        <div style={{ minWidth: 100 }}>
          <span className="pp-strong">{r.effectiveWeight}</span>
          <div className="pp-bar" style={{ marginTop: 4 }}>
            <span style={{ width: `${Math.min(100, r.effectiveWeight)}%` }} />
          </div>
        </div>
      ),
    },
    { key: 'state', title: '熔断状态', render: (r) => <BreakerBadge state={r.state} /> },
    {
      key: 'usable', title: '可路由',
      render: (r) => <span className={r.usable ? 'pp-strong' : 'pp-error'}>{r.usable ? '是' : '否'}</span>,
    },
  ];

  const healthColumns: Column<ChannelHealth>[] = [
    { key: 'name', title: '通道' },
    { key: 'state', title: '熔断器', render: (r) => <BreakerBadge state={r.state} /> },
    { key: 'consecutiveFailures', title: '连续失败', align: 'right' },
    { key: 'successCount', title: '成功次数', align: 'right' },
    { key: 'failCount', title: '失败次数', align: 'right' },
    { key: 'ewmaLatencyMs', title: 'EWMA 延迟', align: 'right', render: (r) => <span>{r.ewmaLatencyMs} ms</span> },
    { key: 'score', title: '健康分', align: 'right' },
  ];

  const attemptColumns: Column<PaymentAttempt>[] = [
    { key: 'attemptNo', title: '第几次' },
    { key: 'channelCode', title: '通道', render: (r) => <span className="pp-mono">{r.channelCode}</span> },
    { key: 'outcome', title: '结果' },
    { key: 'latencyMs', title: '耗时', align: 'right', render: (r) => <span>{r.latencyMs} ms</span> },
    { key: 'errorCode', title: '错误码', render: (r) => <span className="pp-muted">{r.errorCode || '—'}</span> },
    { key: 'createdAt', title: '时间', render: (r) => <span className="pp-muted">{shortTime(r.createdAt)}</span> },
  ];

  const p = policy.data;
  const rows = channels.data || [];
  const openCount = rows.filter((r) => r.state === 'OPEN').length;
  const flags = metrics.data?.flags || {};

  return (
    <>
      <div className="pp-page-head">
        <div>
          <h2>路由与熔断</h2>
          <p>加权健康度路由 · 三态熔断器 · failover 自动切换 · 故障注入演练台</p>
        </div>
        <ActionButton label="刷新状态" onClick={() => setRefreshKey((k) => k + 1)} />
      </div>

      <div className="pp-alert info">
        所有演练动作只修改内存标志与本地健康表，不会接触任何真实资金。演练结束后点击「全部复位」即可回到初始态。
      </div>
      {message && <div className={`pp-alert ${message.includes('失败') ? 'danger' : 'ok'}`}>{message}</div>}

      <div className="pp-kpi-grid">
        <KpiCard label="路由策略" value="加权健康度" sub="weight × healthScore" tone="blue" />
        <KpiCard label="当前可路由通道" value={`${(p?.candidates || []).filter((c) => c.usable).length} 条`} sub={`候选通道共 ${p?.candidates.length ?? 0} 条`} tone="green" />
        <KpiCard label="熔断隔离" value={`${openCount} 条`} sub={`失败阈值 ${p?.breaker.failureThreshold ?? 3} 次 / 冷却 ${(p?.breaker.cooldownMs ?? 30_000) / 1000}s`} tone="amber" />
        <KpiCard label="服务运行" value={`${metrics.data?.uptimeSec ?? 0}s`} sub={`Node ${metrics.data?.nodeVersion || '—'} · ${metrics.data?.memoryMb ?? 0} MB`} tone="blue" />
      </div>

      <div className="pp-grid-2">
        <Panel title="路由策略与一致性保证" sub="来自 routing 限界上下文的实时策略快照">
          <div className="pp-stat-row"><span className="pp-muted">选路算法</span><span className="pp-strong">{p?.strategy || '—'}</span></div>
          <div className="pp-stat-row"><span className="pp-muted">失败切换</span><span className="pp-strong">{p?.failover || '—'}</span></div>
          <div className="pp-stat-row"><span className="pp-muted">熔断状态机</span><span className="pp-mono">{p?.breaker.stateMachine || '—'}</span></div>
          <div className="pp-stat-row"><span className="pp-muted">幂等策略</span><span className="pp-muted" style={{ maxWidth: 320, textAlign: 'right' }}>{p?.idempotency || '—'}</span></div>
          <div className="pp-stat-row"><span className="pp-muted">事务一致性</span><span className="pp-muted" style={{ maxWidth: 320, textAlign: 'right' }}>{p?.consistency || '—'}</span></div>
          <div className="pp-alert warn" style={{ marginTop: 14, marginBottom: 0 }}>
            当前生效标志：<span className="pp-mono">{Object.keys(flags).length ? JSON.stringify(flags) : '{}（全部复位）'}</span>
          </div>
        </Panel>

        <Panel title="故障注入演练台" sub={`当前演练目标：${target}`}>
          <div className="pp-form-row">
            <label className="pp-form-label">选择目标通道</label>
            <select className="pp-select" style={{ width: '100%' }} value={target} onChange={(e) => setTarget(e.target.value)}>
              {rows.map((c) => <option key={c.channelCode} value={c.channelCode}>{c.name}</option>)}
            </select>
          </div>
          <div className="pp-drill-grid">
            <button className="pp-drill-btn" disabled={busy} onClick={() => void failoverShowcase()}>
              <b>▶ 一键 failover 演练</b><span>强制主通道失败 → 签名下单 → 查看切换轨迹 → 自动恢复</span>
            </button>
            <button className="pp-drill-btn" disabled={busy} onClick={() => void drill('force_fail')}>
              <b>强制通道下单失败</b><span>模拟通道不可用，观察 healthScore 下降</span>
            </button>
            <button className="pp-drill-btn" disabled={busy} onClick={() => void drill('open_breaker')}>
              <b>连击 3 次触发熔断</b><span>达到阈值后 CLOSED → OPEN，自动摘除</span>
            </button>
            <button className="pp-drill-btn" disabled={busy} onClick={() => void drill('reset_breaker')}>
              <b>复位目标通道熔断</b><span>OPEN → CLOSED，清空连续失败计数</span>
            </button>
            <button className="pp-drill-btn" disabled={busy} onClick={() => void drill('force_webhook_fail', 1)}>
              <b>通知投递持续失败</b><span>触发指数退避重试与死信队列</span>
            </button>
            <button className="pp-drill-btn" disabled={busy} onClick={() => void drill('receiver_down', 1)}>
              <b>模拟商户接收端宕机</b><span>Webhook 目标不可达，验证重试策略</span>
            </button>
            <button className="pp-drill-btn" disabled={busy} onClick={() => void drill('extra_latency', 800)}>
              <b>注入 800ms 通道延迟</b><span>EWMA 延迟上升，健康分下降</span>
            </button>
            <button className="pp-drill-btn" disabled={busy} onClick={() => void drill('reset_all')}>
              <b>全部复位</b><span>清除所有故障标志与熔断状态</span>
            </button>
          </div>
        </Panel>
      </div>

      <Panel title="候选通道与有效权重" sub="有效权重 = 静态权重 × 健康分 / 100；熔断 OPEN 或停用时不参与选路" flush>
        <DataTable columns={candidateColumns} rows={p?.candidates} empty={policy.loading ? '加载中…' : '暂无候选通道'} />
      </Panel>

      <Panel title="熔断器运行态" sub="连续失败、成功/失败累计、EWMA 延迟均为真实统计值" flush>
        <DataTable columns={healthColumns} rows={rows} empty="加载中…" />
      </Panel>

      <div className="pp-grid-2">
        <Panel title="最近一次 failover 轨迹" sub="一键演练后显示逐次通道尝试与错误码" flush>
          <DataTable columns={attemptColumns} rows={attempts} empty="点击「一键 failover 演练」生成轨迹" />
        </Panel>
        <Panel title="演练执行日志" sub="按时间倒序，最多保留 16 条">
          <div className="pp-code-block" style={{ maxHeight: 220 }}>
            {log.length ? log.join('\n') : '等待演练动作…'}
          </div>
          <div className="pp-alert info" style={{ marginTop: 12, marginBottom: 0 }}>
            提示：先在「支付沙箱」下单并模拟回调成功，可同时观察 Webhook 投递记录进入「回调通知」页面。
          </div>
        </Panel>
      </div>
    </>
  );
}
