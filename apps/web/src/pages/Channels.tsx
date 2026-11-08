import React, { useState } from 'react';
import { apiPatch, useApi } from '../api/client';
import type { ChannelHealth } from '../types';
import {
  ActionButton, BreakerBadge, DataTable, Input, Modal, Panel,
  Toggle, type Column,
} from '../components/ui';

interface ChannelForm {
  enabled: boolean;
  weight: string;
  feeBps: string;
  merchantNo: string;
  apiKey: string;
  notifyUrl: string;
  settleCycle: string;
}

function toForm(row: ChannelHealth): ChannelForm {
  const config = row.config || {};
  return {
    enabled: row.enabled,
    weight: String(row.weight),
    feeBps: String(row.feeBps),
    merchantNo: String(config.merchantNo || ''),
    apiKey: String(config.apiKey || ''),
    notifyUrl: String(config.notifyUrl || ''),
    settleCycle: String(config.settleCycle || 'T+1'),
  };
}

export default function Channels(): React.ReactElement {
  const [refreshKey, setRefreshKey] = useState(0);
  const channels = useApi<ChannelHealth[]>('/api/v1/console/channels', refreshKey, 20_000);
  const [editing, setEditing] = useState<ChannelHealth | null>(null);
  const [form, setForm] = useState<ChannelForm | null>(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const rows = channels.data || [];
  const available = rows.filter((c) => c.enabled && c.configured && c.state !== 'OPEN');

  function openEdit(row: ChannelHealth): void {
    setEditing(row);
    setForm(toForm(row));
    setMessage('');
  }

  async function toggle(row: ChannelHealth): Promise<void> {
    try {
      await apiPatch(`/api/v1/console/channels/${row.channelCode}`, { enabled: !row.enabled });
      setMessage(`${row.name} 已${row.enabled ? '停用' : '启用'}`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setMessage(`操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function save(): Promise<void> {
    if (!editing || !form) return;
    setSaving(true);
    setMessage('');
    try {
      await apiPatch(`/api/v1/console/channels/${editing.channelCode}`, {
        enabled: form.enabled,
        weight: Number(form.weight),
        feeBps: Number(form.feeBps),
        config: {
          merchantNo: form.merchantNo,
          apiKey: form.apiKey,
          notifyUrl: form.notifyUrl,
          settleCycle: form.settleCycle,
        },
      });
      setMessage('通道配置已保存，路由权重即时生效');
      setRefreshKey((k) => k + 1);
      setEditing(null);
    } catch (err) {
      setMessage(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  const columns: Column<ChannelHealth>[] = [
    {
      key: 'name', title: '通道名称',
      render: (r) => (
        <div>
          <div className="pp-strong">{r.name}</div>
          <div className="pp-mono pp-muted" style={{ fontSize: 10.5 }}>{r.channelCode}</div>
        </div>
      ),
    },
    {
      key: 'mode', title: '类型',
      render: (r) => (
        <span className="pp-pill">
          {r.mode === 'mock' ? '沙箱模拟' : '持牌通道占位'} · {r.kind}
        </span>
      ),
    },
    { key: 'methods', title: '支付方式', render: (r) => <span className="pp-muted">{r.methods.join(' / ')}</span> },
    {
      key: 'score', title: '健康度',
      render: (r) => (
        <div style={{ minWidth: 108 }}>
          <div className="pp-flex" style={{ justifyContent: 'space-between', fontSize: 11.5 }}>
            <span>{r.score} 分</span>
            <span className="pp-muted">连续失败 {r.consecutiveFailures}</span>
          </div>
          <div className="pp-bar" style={{ marginTop: 5 }}>
            <span style={{ width: `${r.score}%`, background: r.state === 'OPEN' ? '#dc2626' : r.score < 60 ? '#d97706' : undefined }} />
          </div>
        </div>
      ),
    },
    { key: 'state', title: '熔断器', render: (r) => <BreakerBadge state={r.state} /> },
    { key: 'weight', title: '权重', align: 'right' },
    {
      key: 'feeBps', title: '费率',
      align: 'right',
      render: (r) => <span>{(r.feeBps / 100).toFixed(2)}%</span>,
    },
    {
      key: 'enabled', title: '启用',
      render: (r) => (
        <label className="pp-flex" style={{ gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={() => void toggle(r)}
            aria-label={`切换 ${r.name} 启用状态`}
          />
          <span className="pp-muted" style={{ fontSize: 11.5 }}>{r.enabled ? '是' : '否'}</span>
        </label>
      ),
    },
    {
      key: 'channelCode', title: '操作', align: 'right',
      render: (r) => <button className="pp-link" onClick={() => openEdit(r)}>配置</button>,
    },
  ];

  return (
    <>
      <div className="pp-page-head">
        <div>
          <h2>通道配置</h2>
          <p>通道适配器防腐层（ACL）· 商户号 / 密钥 / 回调地址 / 费率 / 路由权重 · 当前 {available.length}/{rows.length} 条可路由</p>
        </div>
        <ActionButton label="刷新" onClick={() => setRefreshKey((k) => k + 1)} />
      </div>

      <div className="pp-alert info">
        4 条沙箱模拟通道可直接下单演练；3 条持牌通道（支付宝 / 微信支付 / 银联）仅保留适配器接口与配置位，
        默认停用且不配置真实密钥，不会发起真实请求。领域层只依赖 ChannelAdapter 端口，不感知第三方 SDK 字段。
      </div>
      {message && <div className={`pp-alert ${message.includes('失败') ? 'danger' : 'ok'}`}>{message}</div>}
      {channels.error && <div className="pp-alert danger">{channels.error}</div>}

      <Panel title="支付通道列表" sub="健康分 = 成功率 / 延迟 / 连续失败次数综合计算；熔断打开后自动从候选集摘除" flush>
        <DataTable columns={columns} rows={rows} empty={channels.loading ? '加载中…' : '暂无通道'} />
      </Panel>

      <div className="pp-grid-2">
        <Panel title="通道接入分层" sub="DDD 防腐层：外部支付机构模型 → 统一领域端口">
          <div className="pp-stat-row"><span className="pp-muted">领域层</span><span className="pp-strong">ChannelAdapter（端口接口）</span></div>
          <div className="pp-stat-row"><span className="pp-muted">适配器层</span><span className="pp-strong">MockChannelAdapter × 4 / OfficialPlaceholder × 3</span></div>
          <div className="pp-stat-row"><span className="pp-muted">统一命令</span><span className="pp-mono">CreateChargeCommand / RefundCommand</span></div>
          <div className="pp-stat-row"><span className="pp-muted">回调解析</span><span className="pp-mono">parseCallback(rawBody, headers)</span></div>
          <div className="pp-stat-row"><span className="pp-muted">验签密钥</span><span className="pp-mono">通道侧 HMAC-SHA256</span></div>
          <div className="pp-alert warn" style={{ marginTop: 14, marginBottom: 0 }}>
            新增一条真实通道只需实现端口并在注册表注入，路由、订单、账务、对账等限界上下文无需改动。
          </div>
        </Panel>
        <Panel title="运行指标" sub="来自通道健康表，20 秒自动刷新">
          <div className="pp-stat-row"><span className="pp-muted">可用通道</span><span className="pp-strong">{available.length} 条</span></div>
          <div className="pp-stat-row"><span className="pp-muted">熔断隔离</span><span className="pp-strong">{rows.filter((r) => r.state === 'OPEN').length} 条</span></div>
          <div className="pp-stat-row"><span className="pp-muted">强制失败演练</span><span className="pp-strong">{rows.filter((r) => r.forceFail).length} 条</span></div>
          <div className="pp-stat-row"><span className="pp-muted">平均通道耗时</span><span className="pp-strong">{rows.length ? Math.round(rows.reduce((s, r) => s + r.ewmaLatencyMs, 0) / rows.length) : 0} ms</span></div>
          <div className="pp-stat-row"><span className="pp-muted">累计成功 / 失败</span><span className="pp-strong">{rows.reduce((s, r) => s + r.successCount, 0)} / {rows.reduce((s, r) => s + r.failCount, 0)}</span></div>
          <div className="pp-alert info" style={{ marginTop: 14, marginBottom: 0 }}>
            在「路由与熔断」页面注入故障后回到这里，可观察健康分、连续失败次数与熔断状态实时变化。
          </div>
        </Panel>
      </div>

      {editing && form && (
        <Modal
          title={`通道配置 · ${editing.name}`}
          onClose={() => setEditing(null)}
          footer={
            <>
              <ActionButton label="取消" onClick={() => setEditing(null)} />
              <ActionButton label="保存配置" variant="primary" disabled={saving} onClick={() => void save()} />
            </>
          }
        >
          <div className="pp-alert info">
            字段对标参考教程中的「增加支付通道」弹窗。沙箱环境的商户号与密钥仅为演示值，不会用于任何真实资金请求。
          </div>
          <div className="pp-form-grid">
            <Input label="商户号" value={form.merchantNo} onChange={(v) => setForm({ ...form, merchantNo: v })} placeholder="SANDBOX MERCHANT NO" />
            <Input label="接口密钥" value={form.apiKey} onChange={(v) => setForm({ ...form, apiKey: v })} placeholder="sandbox_key_xxx" />
          </div>
          <Input label="异步回调地址" value={form.notifyUrl} onChange={(v) => setForm({ ...form, notifyUrl: v })} placeholder="https://..." />
          <div className="pp-form-grid">
            <Input label="路由权重 (0–1000)" value={form.weight} onChange={(v) => setForm({ ...form, weight: v })} type="text" />
            <Input label="通道费率 (bps)" value={form.feeBps} onChange={(v) => setForm({ ...form, feeBps: v })} type="text" />
          </div>
          <div className="pp-form-grid">
            <div className="pp-form-row">
              <label className="pp-form-label">结算周期</label>
              <select
                className="pp-select"
                style={{ width: '100%' }}
                value={form.settleCycle}
                onChange={(e) => setForm({ ...form, settleCycle: e.target.value })}
              >
                <option value="T+1">T+1 · 次日结算</option>
                <option value="D+1">D+1 · 自然日结算</option>
                <option value="WEEKLY">按周结算</option>
              </select>
            </div>
            <div className="pp-form-row">
              <label className="pp-form-label">通道开关</label>
              <Toggle label="启用该通道" value={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
            </div>
          </div>
          <div className="pp-code-block">{`${editing.channelCode}  ·  ${editing.methods.join(' / ')}\n${editing.description}`}</div>
        </Modal>
      )}
    </>
  );
}
