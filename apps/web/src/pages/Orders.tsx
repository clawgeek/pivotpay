import React, { useEffect, useState } from 'react';
import { apiGet, apiPost, shortTime, useApi, yuan } from '../api/client';
import type { PaymentOrder, PaymentAttempt, ChannelHealth } from '../types';
import {
  ActionButton, DataTable, Input, Modal, Panel, StatusBadge,
  moneyCell, timeCell, type Column,
} from '../components/ui';

const STATUSES = ['', 'CREATED', 'PAYING', 'PAID', 'PARTIAL_REFUNDED', 'REFUNDED', 'FAILED', 'CLOSED'];
const STATUS_LABELS: Record<string, string> = {
  '': '全部状态', CREATED: '待支付', PAYING: '处理中', PAID: '支付成功',
  PARTIAL_REFUNDED: '部分退款', REFUNDED: '全额退款', FAILED: '支付失败', CLOSED: '已关单',
};

export default function Orders(): React.ReactElement {
  const [status, setStatus] = useState('');
  const [channelCode, setChannelCode] = useState('');
  const [keyword, setKeyword] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<PaymentOrder | null>(null);
  const [attempts, setAttempts] = useState<PaymentAttempt[]>([]);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundAmount, setRefundAmount] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (channelCode) query.set('channelCode', channelCode);
  if (keyword) query.set('keyword', keyword);
  query.set('limit', '100');
  const list = useApi<{ rows: PaymentOrder[]; total: number }>(
    `/api/v1/console/orders?${query.toString()}`, refreshKey,
  );
  const channels = useApi<ChannelHealth[]>('/api/v1/console/channels');

  useEffect(() => {
    const timer = window.setTimeout(() => setRefreshKey((k) => k + 1), 350);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  async function openDetail(row: PaymentOrder): Promise<void> {
    try {
      const detail = await apiGet<PaymentOrder & { attempts: PaymentAttempt[] }>(
        `/api/v1/console/orders/${row.id}`,
      );
      setSelected(detail);
      setAttempts(detail.attempts || []);
      setActionMsg('');
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function doRefund(): Promise<void> {
    if (!selected) return;
    try {
      const result = await apiPost<Record<string, unknown>>(
        `/api/v1/console/orders/${selected.id}/refund`,
        {
          outRefundNo: `RF${Date.now()}`,
          amountCents: Math.round(Number(refundAmount) * 100),
          reason: '控制台发起退款',
        },
      );
      setActionMsg(`退款成功：${yuan(Number(result.amountCents))}，订单状态 ${String(result.orderStatus)}`);
      setRefundOpen(false);
      setRefreshKey((k) => k + 1);
      const detail = await apiGet<PaymentOrder & { attempts: PaymentAttempt[] }>(
        `/api/v1/console/orders/${selected.id}`,
      );
      setSelected(detail);
    } catch (err) {
      setActionMsg(`退款失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function doClose(): Promise<void> {
    if (!selected) return;
    try {
      await apiPost(`/api/v1/console/orders/${selected.id}/close`, {});
      setActionMsg('订单已关闭');
      setRefreshKey((k) => k + 1);
      setSelected(null);
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : String(err));
    }
  }

  const columns: Column<PaymentOrder>[] = [
    { key: 'outTradeNo', title: '商户订单号', render: (r) => <span className="pp-mono">{r.outTradeNo}</span> },
    { key: 'subject', title: '商品标题' },
    { key: 'amountCents', title: '金额', align: 'right', render: (r) => moneyCell(r.amountCents) },
    { key: 'status', title: '状态', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'channelCode', title: '路由通道', render: (r) => <span className="pp-muted">{r.channelCode || '—'}</span> },
    { key: 'createdAt', title: '创建时间', render: (r) => timeCell(r.createdAt) },
    {
      key: 'id', title: '操作', align: 'right',
      render: (r) => <button className="pp-link" onClick={() => void openDetail(r)}>详情 / 退款</button>,
    },
  ];

  const attemptColumns: Column<PaymentAttempt>[] = [
    { key: 'attemptNo', title: '尝试' },
    { key: 'channelCode', title: '通道', render: (r) => <span className="pp-mono">{r.channelCode}</span> },
    { key: 'outcome', title: '结果' },
    { key: 'latencyMs', title: '耗时', align: 'right', render: (r) => <span>{r.latencyMs} ms</span> },
    { key: 'errorCode', title: '错误码', render: (r) => <span className="pp-muted">{r.errorCode || '—'}</span> },
    { key: 'createdAt', title: '时间', render: (r) => timeCell(r.createdAt) },
  ];

  return (
    <>
      <div className="pp-page-head">
        <div>
          <h2>支付订单</h2>
          <p>订单聚合根状态机 · 通道路由轨迹 · 退款与关单 · 共 {list.data?.total ?? 0} 笔</p>
        </div>
        <ActionButton label="刷新" onClick={() => setRefreshKey((k) => k + 1)} />
      </div>

      <div className="pp-toolbar">
        <select className="pp-select" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
        <select className="pp-select" value={channelCode} onChange={(e) => setChannelCode(e.target.value)}>
          <option value="">全部通道</option>
          {(channels.data || []).map((c) => <option key={c.channelCode} value={c.channelCode}>{c.name}</option>)}
        </select>
        <div style={{ width: 240 }}>
          <input
            className="pp-input"
            placeholder="搜索订单号 / 通道流水号"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <span className="pp-muted" style={{ fontSize: 12 }}>筛选条件变化后自动刷新</span>
      </div>

      {list.error && <div className="pp-alert danger">{list.error}</div>}

      <Panel title="订单列表" sub="数据来自真实 REST 接口，按租户隔离" flush>
        <DataTable columns={columns} rows={list.data?.rows} empty={list.loading ? '加载中…' : '没有匹配的订单'} />
      </Panel>

      {selected && (
        <Modal
          title={`订单详情 · ${selected.outTradeNo}`}
          onClose={() => setSelected(null)}
          footer={
            <>
              <ActionButton label="关闭" onClick={() => setSelected(null)} />
              <ActionButton label="关闭订单" variant="destructive" onClick={() => void doClose()} />
              <ActionButton label="发起退款" variant="primary" onClick={() => setRefundOpen(true)} />
            </>
          }
        >
          {actionMsg && <div className="pp-alert ok">{actionMsg}</div>}
          <div className="pp-form-grid">
            <div>
              <div className="pp-stat-row"><span className="pp-muted">订单 ID</span><span className="pp-mono">{selected.id}</span></div>
              <div className="pp-stat-row"><span className="pp-muted">金额</span><span className="pp-strong">{yuan(selected.amountCents)}</span></div>
              <div className="pp-stat-row"><span className="pp-muted">状态</span><StatusBadge status={selected.status} /></div>
              <div className="pp-stat-row"><span className="pp-muted">支付方式</span><span>{selected.method}</span></div>
              <div className="pp-stat-row"><span className="pp-muted">版本</span><span>v{selected.version}</span></div>
            </div>
            <div>
              <div className="pp-stat-row"><span className="pp-muted">路由通道</span><span>{selected.channelCode || '—'}</span></div>
              <div className="pp-stat-row"><span className="pp-muted">通道流水号</span><span className="pp-mono">{selected.channelTradeNo || '—'}</span></div>
              <div className="pp-stat-row"><span className="pp-muted">创建时间</span><span>{shortTime(selected.createdAt)}</span></div>
              <div className="pp-stat-row"><span className="pp-muted">支付时间</span><span>{shortTime(selected.paidAt)}</span></div>
              <div className="pp-stat-row"><span className="pp-muted">回调地址</span><span className="pp-mono" style={{ fontSize: 10 }}>{selected.credential ? '已生成凭证' : '—'}</span></div>
            </div>
          </div>
          <div className="pp-panel-title" style={{ margin: '18px 0 8px' }}>通道路由轨迹</div>
          <DataTable columns={attemptColumns} rows={attempts} empty="该订单为种子历史数据，无实时路由轨迹" />
        </Modal>
      )}

      {refundOpen && selected && (
        <Modal
          title="发起退款"
          onClose={() => setRefundOpen(false)}
          footer={
            <>
              <ActionButton label="取消" onClick={() => setRefundOpen(false)} />
              <ActionButton label="确认退款" variant="primary" onClick={() => void doRefund()} />
            </>
          }
        >
          <div className="pp-alert info">
            领域规则：累计退款金额不得超过订单实付金额；重复退款单号幂等返回。
          </div>
          <Input
            label={`退款金额（元），订单实付 ${yuan(selected.amountCents)}`}
            value={refundAmount}
            onChange={setRefundAmount}
            placeholder="例如 12.50"
          />
        </Modal>
      )}
    </>
  );
}
