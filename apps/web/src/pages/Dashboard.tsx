import React from 'react';
import { useApi, yuan, shortTime } from '../api/client';
import type { Overview, ChannelHealth, PaymentOrder } from '../types';
import {
  ActionButton, BreakerBadge, DataTable, KpiCard, LineChart,
  Panel, StatusBadge, moneyCell, timeCell, type Column,
} from '../components/ui';

export default function Dashboard(): React.ReactElement {
  const overview = useApi<Overview>('/api/v1/console/overview', 0, 15_000);
  const channels = useApi<ChannelHealth[]>('/api/v1/console/channels', 0, 15_000);
  const data = overview.data;

  const orderColumns: Column<PaymentOrder>[] = [
    { key: 'outTradeNo', title: '商户订单号', render: (r) => <span className="pp-mono">{r.outTradeNo}</span> },
    { key: 'subject', title: '商品' },
    { key: 'amountCents', title: '金额', align: 'right', render: (r) => moneyCell(r.amountCents) },
    { key: 'status', title: '状态', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'channelCode', title: '通道', render: (r) => <span className="pp-muted">{r.channelCode || '—'}</span> },
    { key: 'createdAt', title: '创建时间', render: (r) => timeCell(r.createdAt) },
  ];

  const channelColumns: Column<ChannelHealth>[] = [
    { key: 'name', title: '通道', render: (r) => <span className="pp-strong">{r.name}</span> },
    { key: 'state', title: '熔断状态', render: (r) => <BreakerBadge state={r.state} /> },
    { key: 'score', title: '健康分', align: 'right', render: (r) => <span>{r.score}</span> },
    { key: 'weight', title: '权重', align: 'right' },
    { key: 'ewmaLatencyMs', title: '平均耗时', align: 'right', render: (r) => <span>{r.ewmaLatencyMs} ms</span> },
  ];

  return (
    <>
      <div className="pp-page-head">
        <div>
          <h2>经营驾驶舱</h2>
          <p>多租户实时交易概览 · 数据每 15 秒自动刷新 · 业务日期 {data?.bizDate || '—'}</p>
        </div>
        <ActionButton label="刷新数据" onClick={() => void overview.reload()} />
      </div>

      {overview.error && <div className="pp-alert danger">接口异常：{overview.error}</div>}

      <div className="pp-kpi-grid">
        <KpiCard
          label="今日交易额"
          value={yuan(data?.today.amountCents || 0)}
          sub={`今日成功订单 ${data?.today.orderCount ?? 0} 笔`}
          tone="blue"
        />
        <KpiCard
          label="累计成功率"
          value={`${data?.totals.successRate ?? 0}%`}
          sub={`累计 ${data?.totals.orders ?? 0} 笔 · 失败 ${data?.totals.failed ?? 0} 笔`}
          tone="green"
        />
        <KpiCard
          label="可用通道"
          value={`${data?.channels.available ?? 0} / ${data?.channels.total ?? 0}`}
          sub={`熔断隔离 ${data?.channels.openBreakers ?? 0} 条`}
          tone="amber"
        />
        <KpiCard
          label="回调通知"
          value={`${data?.webhooks.delivered ?? 0} 已送达`}
          sub={`待投递 ${data?.webhooks.pending ?? 0} · 死信 ${data?.webhooks.dead ?? 0}`}
          tone="blue"
        />
      </div>

      <div className="pp-grid-2">
        <Panel title="近 7 日交易额趋势" sub="按订单创建日聚合，单位：分">
          <LineChart points={data?.trend || []} />
          <div className="pp-flex pp-wrap" style={{ marginTop: 10, gap: 18 }}>
            {(data?.trend || []).map((t) => (
              <span key={t.day} className="pp-muted" style={{ fontSize: 11 }}>
                {t.day.slice(5)} · {yuan(t.amount)}
              </span>
            ))}
          </div>
        </Panel>
        <Panel title="平台运行态" sub="健康检查 / 账务平衡 / 通知队列">
          <div className="pp-stat-row"><span className="pp-muted">数据库</span><span className="pp-strong">WAL · 可读写</span></div>
          <div className="pp-stat-row"><span className="pp-muted">账务借贷合计</span><span className="pp-strong">{yuan(data?.ledger.debit || 0)}</span></div>
          <div className="pp-stat-row"><span className="pp-muted">借贷平衡</span><span className={data?.ledger.balanced ? 'pp-strong' : 'pp-error'}>{data?.ledger.balanced ? '平衡 ✓' : '不平衡'}</span></div>
          <div className="pp-stat-row"><span className="pp-muted">平均通道耗时</span><span className="pp-strong">{data?.avgLatencyMs ?? 0} ms</span></div>
          <div className="pp-stat-row"><span className="pp-muted">事务一致性</span><span className="pp-strong">Outbox · 单事务提交</span></div>
          <div className="pp-alert info" style={{ marginTop: 14, marginBottom: 0 }}>
            订单状态、复式分录与 Outbox 事件在同一数据库事务内提交，避免「支付成功但通知丢失」。
          </div>
        </Panel>
      </div>

      <Panel title="通道健康度" sub="加权路由依据：weight × healthScore，熔断打开后自动摘除" flush>
        <DataTable columns={channelColumns} rows={channels.data} empty="通道数据加载中…" />
      </Panel>

      <Panel title="最近交易" sub={`最近 ${data?.recentOrders.length ?? 0} 笔订单`} flush
        extra={<button className="pp-link" onClick={() => { window.location.hash = '/orders'; }}>查看全部 →</button>}>
        <DataTable columns={orderColumns} rows={data?.recentOrders} empty={overview.loading ? '加载中…' : '暂无订单'} />
      </Panel>
    </>
  );
}
