import React, { useState } from 'react';
import { apiPost, getTenantId, setTenantId, shortTime, useApi, yuan } from '../api/client';
import type { MerchantApp, Tenant } from '../types';
import {
  ActionButton, DataTable, Input, KpiCard, Panel, type Column,
} from '../components/ui';

interface Delivery {
  id: string;
  tenantId: string;
  eventId: string;
  eventType: string;
  targetUrl: string;
  status: string;
  attemptCount: number;
  nextRetryAt: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

interface Batch {
  id: string;
  bizDate: string;
  status: string;
  totalCount: number;
  matchedCount: number;
  diffCount: number;
  createdAt: string;
}

interface Diff {
  id: string;
  batchId: string;
  outTradeNo: string;
  kind: string;
  localCents: number | null;
  channelCents: number | null;
  note: string;
}

interface LedgerEntry {
  id: string;
  account: string;
  direction: string;
  amountCents: number;
  memo: string;
  orderId: string;
  createdAt: string;
}

interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  resource: string;
  detailJson: string;
  traceId: string;
  createdAt: string;
}

const ACCOUNT_LABELS: Record<string, string> = {
  CHANNEL_RECEIVABLE: '通道应收',
  MERCHANT_SETTLEABLE: '商户可结算',
  PLATFORM_FEE_INCOME: '平台手续费收入',
  REFUND_PAYABLE: '退款应付',
  MERCHANT_PAYABLE: '商户应付',
};

const DIFF_LABELS: Record<string, string> = {
  AMOUNT_MISMATCH: '金额不一致',
  MISSING_IN_CHANNEL: '通道账单缺失',
  MISSING_IN_LOCAL: '本地账单缺失',
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: '待投递', DELIVERED: '已送达', DEAD: '死信', FAILED: '失败',
};

function PageHead({ title, desc, onRefresh }: { title: string; desc: string; onRefresh: () => void }): React.ReactElement {
  return (
    <div className="pp-page-head">
      <div><h2>{title}</h2><p>{desc}</p></div>
      <ActionButton label="刷新" onClick={onRefresh} />
    </div>
  );
}

function Webhooks(): React.ReactElement {
  const [refreshKey, setRefreshKey] = useState(0);
  const data = useApi<{ deliveries: Delivery[]; stats: Record<string, number> }>(
    '/api/v1/console/webhooks', refreshKey, 12_000,
  );
  const [message, setMessage] = useState('');

  async function retry(id: string): Promise<void> {
    try {
      const result = await apiPost<{ ok: boolean }>(`/api/v1/console/webhooks/${id}/retry`, {});
      setMessage(result.ok ? '已重新入队，等待退避派发器投递' : '该记录无需重试');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setMessage(`重试失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const columns: Column<Delivery>[] = [
    { key: 'eventType', title: '领域事件', render: (r) => <span className="pp-mono">{r.eventType}</span> },
    { key: 'targetUrl', title: '目标地址', render: (r) => <span className="pp-mono pp-muted" style={{ fontSize: 10.5 }}>{r.targetUrl}</span> },
    {
      key: 'status', title: '状态',
      render: (r) => <span className={`pp-pill${r.status === 'DEAD' ? ' pp-error' : ''}`}>{STATUS_LABELS[r.status] || r.status}</span>,
    },
    { key: 'attemptCount', title: '投递次数', align: 'right' },
    { key: 'nextRetryAt', title: '下次重试', render: (r) => <span className="pp-muted">{shortTime(r.nextRetryAt)}</span> },
    { key: 'lastError', title: '最近错误', render: (r) => <span className="pp-muted">{r.lastError || '—'}</span> },
    {
      key: 'id', title: '操作', align: 'right',
      render: (r) => <button className="pp-link" onClick={() => void retry(r.id)}>手动重试</button>,
    },
  ];

  const stats = data.data?.stats || {};
  return (
    <>
      <PageHead title="回调通知" desc="Outbox 事务性发件箱 · 指数退避重试 · 死信队列 · 12 秒自动刷新" onRefresh={() => setRefreshKey((k) => k + 1)} />
      <div className="pp-alert info">
        订单状态变更、复式分录与 Outbox 事件在同一事务提交；后台派发器异步按 1s/2s/4s/8s/16s 退避投递，
        超过次数进入死信，可在此手动重试。投递报文带 HMAC 签名便于商户侧验签。
      </div>
      {message && <div className="pp-alert ok">{message}</div>}
      <div className="pp-kpi-grid">
        <KpiCard label="已送达" value={`${stats.delivered ?? 0} 条`} sub="商户接收端返回成功" tone="green" />
        <KpiCard label="待投递" value={`${stats.pending ?? 0} 条`} sub="含退避等待中的记录" tone="amber" />
        <KpiCard label="死信" value={`${stats.dead ?? 0} 条`} sub="超过最大重试次数" tone="red" />
        <KpiCard label="总计" value={`${data.data?.deliveries.length ?? 0} 条`} sub="当前租户可见记录" tone="blue" />
      </div>
      <Panel title="通知投递记录" sub="在「路由与熔断」中开启通知失败演练，可观察投递次数递增与死信产生" flush>
        <DataTable columns={columns} rows={data.data?.deliveries} empty={data.loading ? '加载中…' : '暂无通知记录，去「支付沙箱」完成一笔支付并模拟回调即可生成'} />
      </Panel>
    </>
  );
}

function Reconciliation(): React.ReactElement {
  const [refreshKey, setRefreshKey] = useState(0);
  const data = useApi<{ batches: Batch[]; diffs: Diff[]; lastRun: unknown }>(
    '/api/v1/console/reconciliation', refreshKey,
  );
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(): Promise<void> {
    setBusy(true);
    setMessage('');
    try {
      const result = await apiPost<{ totalCount: number; matchedCount: number; diffCount: number }>(
        '/api/v1/console/reconciliation/run', { date },
      );
      setMessage(`对账完成：核对 ${result.totalCount} 笔，匹配 ${result.matchedCount} 笔，发现 ${result.diffCount} 条差异`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setMessage(`对账失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const batchColumns: Column<Batch>[] = [
    { key: 'bizDate', title: '业务日期', render: (r) => <span className="pp-strong">{r.bizDate}</span> },
    { key: 'status', title: '批次状态', render: (r) => <span className="pp-pill">{r.status === 'BALANCED' ? '已平账' : '有差异'}</span> },
    { key: 'totalCount', title: '核对笔数', align: 'right' },
    { key: 'matchedCount', title: '匹配笔数', align: 'right' },
    { key: 'diffCount', title: '差异笔数', align: 'right', render: (r) => <span className={r.diffCount ? 'pp-error' : ''}>{r.diffCount}</span> },
    { key: 'createdAt', title: '执行时间', render: (r) => <span className="pp-muted">{shortTime(r.createdAt)}</span> },
  ];

  const diffColumns: Column<Diff>[] = [
    { key: 'outTradeNo', title: '商户订单号', render: (r) => <span className="pp-mono">{r.outTradeNo}</span> },
    { key: 'kind', title: '差异类型', render: (r) => <span className="pp-pill">{DIFF_LABELS[r.kind] || r.kind}</span> },
    { key: 'localCents', title: '本地金额', align: 'right', render: (r) => <span>{r.localCents == null ? '—' : yuan(r.localCents)}</span> },
    { key: 'channelCents', title: '通道金额', align: 'right', render: (r) => <span>{r.channelCents == null ? '—' : yuan(r.channelCents)}</span> },
    { key: 'note', title: '说明', render: (r) => <span className="pp-muted">{r.note}</span> },
  ];

  const batches = data.data?.batches || [];
  const diffs = data.data?.diffs || [];
  return (
    <>
      <PageHead title="日终对账" desc="本地订单账 vs 通道账单逐笔核对 · 差异分类登记 · 批次留痕" onRefresh={() => setRefreshKey((k) => k + 1)} />
      <div className="pp-alert info">
        沙箱通道账单按确定性规则生成，并刻意注入「金额不一致 / 通道缺失 / 本地缺失」三类差异，
        用于演示差异发现流程。真实场景需对接持牌机构下发的对账文件，本系统不涉及真实资金清算。
      </div>
      {message && <div className={`pp-alert ${message.includes('失败') ? 'danger' : 'ok'}`}>{message}</div>}
      <Panel title="执行对账" sub="选择业务日期，对该租户当日已支付订单与通道账单做逐笔比对">
        <div className="pp-flex pp-wrap">
          <div style={{ width: 220 }}><Input label="业务日期 (YYYY-MM-DD)" value={date} onChange={setDate} placeholder="2026-11-08" /></div>
          <ActionButton label="运行对账" variant="primary" disabled={busy} onClick={() => void run()} />
          <span className="pp-muted" style={{ fontSize: 12 }}>种子数据分布在最近 7 天，可选择对应日期查看差异</span>
        </div>
      </Panel>
      <div className="pp-kpi-grid">
        <KpiCard label="对账批次" value={`${batches.length} 个`} sub="按租户隔离" tone="blue" />
        <KpiCard label="累计核对" value={`${batches.reduce((s, b) => s + b.totalCount, 0)} 笔`} sub="历史批次合计" tone="green" />
        <KpiCard label="差异记录" value={`${diffs.length} 条`} sub="需人工核查处置" tone="amber" />
        <KpiCard label="最近批次" value={batches[0]?.status === 'BALANCED' ? '已平账' : batches[0]?.status === 'WITH_DIFFS' ? '有差异' : '未运行'} sub={batches[0]?.bizDate || '—'} tone="blue" />
      </div>
      <Panel title="对账批次" sub="每次运行生成独立批次，重复运行同一日期不重复写入" flush>
        <DataTable columns={batchColumns} rows={batches} empty={data.loading ? '加载中…' : '尚无对账批次，点击上方「运行对账」'} />
      </Panel>
      <Panel title="差异明细" sub="金额差异 / 单边账的订单级明细" flush>
        <DataTable columns={diffColumns} rows={diffs} empty="暂无差异记录" />
      </Panel>
    </>
  );
}

function Ledger(): React.ReactElement {
  const [refreshKey, setRefreshKey] = useState(0);
  const data = useApi<{ entries: LedgerEntry[]; balance: { debit: number; credit: number; balanced: boolean } }>(
    '/api/v1/console/ledger', refreshKey,
  );
  const balance = data.data?.balance;

  const columns: Column<LedgerEntry>[] = [
    { key: 'createdAt', title: '记账时间', render: (r) => <span className="pp-muted">{shortTime(r.createdAt)}</span> },
    {
      key: 'account', title: '科目',
      render: (r) => (
        <div>
          <div className="pp-strong">{ACCOUNT_LABELS[r.account] || r.account}</div>
          <div className="pp-mono pp-muted" style={{ fontSize: 10.5 }}>{r.account}</div>
        </div>
      ),
    },
    { key: 'memo', title: '摘要', render: (r) => <span className="pp-muted">{r.memo}</span> },
    { key: 'orderId', title: '关联订单', render: (r) => <span className="pp-mono pp-muted" style={{ fontSize: 10.5 }}>{r.orderId}</span> },
    { key: 'direction', title: '方向', render: (r) => <span className="pp-pill">{r.direction === 'DEBIT' ? '借' : '贷'}</span> },
    { key: 'amountCents', title: '金额', align: 'right', render: (r) => <span className="pp-strong">{yuan(r.amountCents)}</span> },
  ];

  return (
    <>
      <PageHead title="账务流水" desc="复式记账 · 借贷平衡校验 · 支付 / 退款 / 手续费分录" onRefresh={() => setRefreshKey((k) => k + 1)} />
      <div className="pp-alert info">
        每笔支付成功事务同时写入「通道应收（借）= 商户可结算（贷）+ 平台手续费收入（贷）」；
        退款按相反方向冲回。借贷不平会立即暴露，是资金一致性的最后一道防线。
      </div>
      <div className="pp-kpi-grid">
        <KpiCard label="借方合计" value={yuan(balance?.debit || 0)} sub="通道应收 / 退款应付" tone="blue" />
        <KpiCard label="贷方合计" value={yuan(balance?.credit || 0)} sub="商户可结算 / 手续费收入" tone="green" />
        <KpiCard label="借贷平衡" value={balance?.balanced ? '平衡 ✓' : '不平衡'} sub={balance?.balanced ? '所有分录校验通过' : '请检查异常分录'} tone={balance?.balanced ? 'green' : 'red'} />
        <KpiCard label="分录数" value={`${data.data?.entries.length ?? 0} 条`} sub="最近 100 条" tone="amber" />
      </div>
      <Panel title="会计分录明细" sub="按记账时间倒序，按租户隔离" flush>
        <DataTable columns={columns} rows={data.data?.entries} empty={data.loading ? '加载中…' : '暂无分录'} />
      </Panel>
    </>
  );
}

function Tenants(): React.ReactElement {
  const [refreshKey, setRefreshKey] = useState(0);
  const data = useApi<Tenant[]>('/api/v1/console/tenants', refreshKey);
  const current = getTenantId();
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState('');

  async function copy(text: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(`${label} 已复制`);
    } catch {
      setCopied('浏览器未授权剪贴板，请手动复制');
    }
  }

  const columns: Column<Tenant>[] = [
    {
      key: 'name', title: '商户',
      render: (r) => (
        <div>
          <div className="pp-strong">{r.name}</div>
          <div className="pp-mono pp-muted" style={{ fontSize: 10.5 }}>{r.code}</div>
        </div>
      ),
    },
    { key: 'plan', title: '套餐', render: (r) => <span className="pp-pill">{r.plan}</span> },
    { key: 'status', title: '状态', render: (r) => <span className={r.status === 'active' ? 'pp-strong' : 'pp-error'}>{r.status === 'active' ? '正常' : r.status}</span> },
    { key: 'apps', title: '接入应用', render: (r) => <span className="pp-muted">{r.apps.length} 个</span> },
    { key: 'createdAt', title: '入驻时间', render: (r) => <span className="pp-muted">{shortTime(r.createdAt)}</span> },
    {
      key: 'id', title: '操作', align: 'right',
      render: (r) => (
        <button
          className="pp-link"
          onClick={() => { setTenantId(r.id); window.location.reload(); }}
        >
          {current === r.id ? '当前租户' : '切换至此'}
        </button>
      ),
    },
  ];

  const allApps: MerchantApp[] = (data.data || []).flatMap((t) => t.apps);
  return (
    <>
      <PageHead title="商户与密钥" desc="SaaS 多租户隔离 · 接入应用 · API Key / Secret · Webhook 地址" onRefresh={() => setRefreshKey((k) => k + 1)} />
      <div className="pp-alert warn">
        此页面展示的密钥仅用于本地沙箱演示。生产环境必须对 Secret 做不可逆哈希存储、密钥轮换与最小权限授权，
        严禁把密钥明文放在前端可读取的接口中。
      </div>
      {copied && <div className="pp-alert ok">{copied}</div>}
      <Panel title="租户列表" sub="切换右上角租户下拉框或点击「切换至此」，订单 / 账务 / 通知数据将整体切换" flush>
        <DataTable columns={columns} rows={data.data} empty={data.loading ? '加载中…' : '暂无租户'} />
      </Panel>
      <Panel title="接入应用凭据" sub="支付沙箱使用当前租户的第一组凭据进行真实 HMAC 签名调用" flush>
        <DataTable
          columns={[
            { key: 'name', title: '应用', render: (r: MerchantApp) => <span className="pp-strong">{r.name}</span> },
            { key: 'apiKey', title: 'API Key', render: (r: MerchantApp) => <span className="pp-mono">{r.apiKey}</span> },
            {
              key: 'apiSecret', title: 'API Secret',
              render: (r: MerchantApp) => (
                <span className="pp-flex">
                  <span className="pp-mono">{revealed[r.id] ? r.apiSecret : '••••••••••••••••'}</span>
                  <button className="pp-link" onClick={() => setRevealed({ ...revealed, [r.id]: !revealed[r.id] })}>
                    {revealed[r.id] ? '隐藏' : '显示'}
                  </button>
                  <button className="pp-link" onClick={() => void copy(r.apiSecret, 'API Secret')}>复制</button>
                </span>
              ),
            },
            { key: 'webhookUrl', title: '回调地址', render: (r: MerchantApp) => <span className="pp-mono pp-muted" style={{ fontSize: 10.5 }}>{r.webhookUrl}</span> },
          ] as Column<MerchantApp>[]}
          rows={allApps}
          empty="暂无接入应用"
        />
      </Panel>
      <Panel title="租户隔离实现" sub="共享内核 + 上下文边界">
        <div className="pp-stat-row"><span className="pp-muted">请求级租户标识</span><span className="pp-mono">X-Tenant-Id / X-Api-Key → tenantId</span></div>
        <div className="pp-stat-row"><span className="pp-muted">仓储层约束</span><span className="pp-strong">所有查询强制带 tenant_id 条件</span></div>
        <div className="pp-stat-row"><span className="pp-muted">聚合根校验</span><span className="pp-mono">order.assertTenant(tenantId)</span></div>
        <div className="pp-stat-row"><span className="pp-muted">越权返回</span><span className="pp-strong">404 / 403，不泄露其他租户数据</span></div>
      </Panel>
    </>
  );
}

function Audit(): React.ReactElement {
  const [refreshKey, setRefreshKey] = useState(0);
  const data = useApi<AuditEntry[]>('/api/v1/console/audit', refreshKey, 15_000);
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  const columns: Column<AuditEntry>[] = [
    { key: 'createdAt', title: '时间', render: (r) => <span className="pp-muted">{shortTime(r.createdAt)}</span> },
    { key: 'actor', title: '操作者', render: (r) => <span className="pp-pill">{r.actor}</span> },
    { key: 'action', title: '动作', render: (r) => <span className="pp-mono">{r.action}</span> },
    { key: 'resource', title: '资源', render: (r) => <span className="pp-mono pp-muted">{r.resource}</span> },
    { key: 'traceId', title: 'Trace ID', render: (r) => <span className="pp-mono pp-muted" style={{ fontSize: 10.5 }}>{r.traceId}</span> },
    {
      key: 'id', title: '详情', align: 'right',
      render: (r) => <button className="pp-link" onClick={() => setSelected(r)}>查看</button>,
    },
  ];

  return (
    <>
      <PageHead title="审计日志" desc="关键写操作全量留痕 · Trace ID 串联 · 15 秒自动刷新" onRefresh={() => setRefreshKey((k) => k + 1)} />
      <div className="pp-alert info">
        下单、回调、退款、关单、通道变更、故障注入、对账执行与 Webhook 投递均写入审计日志，
        按租户隔离并附带 traceId，便于跨限界上下文追踪一次完整调用链。
      </div>
      <Panel title="审计记录" sub={`最近 ${data.data?.length ?? 0} 条`} flush>
        <DataTable columns={columns} rows={data.data} empty={data.loading ? '加载中…' : '暂无审计记录'} />
      </Panel>
      {selected && (
        <Panel title={`事件详情 · ${selected.action}`} sub={`traceId ${selected.traceId}`}
          extra={<ActionButton label="关闭" onClick={() => setSelected(null)} />}>
          <div className="pp-code-block">
            {JSON.stringify(
              {
                actor: selected.actor,
                action: selected.action,
                resource: selected.resource,
                createdAt: selected.createdAt,
                detail: (() => { try { return JSON.parse(selected.detailJson); } catch { return selected.detailJson; } })(),
              },
              null, 2,
            )}
          </div>
        </Panel>
      )}
    </>
  );
}

export default function Operations({ section }: { section?: string }): React.ReactElement {
  switch (section) {
    case 'webhooks': return <Webhooks />;
    case 'reconciliation': return <Reconciliation />;
    case 'ledger': return <Ledger />;
    case 'tenants': return <Tenants />;
    case 'audit': return <Audit />;
    default: return <Webhooks />;
  }
}
