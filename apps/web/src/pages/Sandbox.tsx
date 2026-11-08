import React, { useState } from 'react';
import {
  apiGet, apiPost, shortTime, signedMerchantApi, useApi, yuan,
} from '../api/client';
import type { MerchantApp, PaymentOrder, PaymentAttempt } from '../types';
import {
  ActionButton, DataTable, Input, KpiCard, Modal, Panel, QrMock,
  StatusBadge, type Column,
} from '../components/ui';

type CallbackMode = 'normal' | 'duplicate' | 'out_of_order' | 'tamper_amount';

const MODE_LABELS: Record<CallbackMode, string> = {
  normal: '正常回调',
  duplicate: '重复回调（幂等）',
  out_of_order: '乱序回调（迟到失败）',
  tamper_amount: '篡改金额（防护）',
};

function newOutTradeNo(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `SBOX${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${Math.floor(Math.random() * 900 + 100)}`;
}

export default function Sandbox(): React.ReactElement {
  const creds = useApi<MerchantApp[]>('/api/v1/console/credentials');
  const [outTradeNo, setOutTradeNo] = useState(newOutTradeNo());
  const [subject, setSubject] = useState('云枢平台 · 测试商品');
  const [amountYuan, setAmountYuan] = useState('88.00');
  const [method, setMethod] = useState('QRCODE');
  const [order, setOrder] = useState<PaymentOrder | null>(null);
  const [attempts, setAttempts] = useState<PaymentAttempt[]>([]);
  const [lastBody, setLastBody] = useState<Record<string, unknown> | null>(null);
  const [lastKey, setLastKey] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [callbackResults, setCallbackResults] = useState<unknown[]>([]);
  const [mode, setMode] = useState<CallbackMode>('normal');
  const [outcome, setOutcome] = useState<'SUCCESS' | 'FAILURE'>('SUCCESS');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [specOpen, setSpecOpen] = useState(false);

  const pushLog = (line: string) =>
    setLog((prev) => [`${new Date().toLocaleTimeString('zh-CN')}  ${line}`, ...prev].slice(0, 14));

  async function refreshOrder(id: string): Promise<void> {
    const detail = await apiGet<PaymentOrder & { attempts: PaymentAttempt[] }>(
      `/api/v1/console/orders/${id}`,
    );
    setOrder(detail);
    setAttempts(detail.attempts || []);
  }

  async function createPayment(replay: boolean): Promise<void> {
    const cred = creds.data?.[0];
    if (!cred) {
      setError('尚未加载商户凭据');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body = replay && lastBody
        ? lastBody
        : {
            outTradeNo: replay ? outTradeNo : newOutTradeNo(),
            subject,
            amountCents: Math.round(Number(amountYuan) * 100),
            currency: 'CNY',
            method,
            metadata: { source: 'saas-console-sandbox' },
          };
      const key = replay && lastKey ? lastKey : `idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await signedMerchantApi<PaymentOrder>(
        'POST', '/api/v1/payments', body, cred, key,
      );
      setOrder(result);
      setLastBody(body);
      setLastKey(key);
      setOutTradeNo(String(body.outTradeNo));
      await refreshOrder(result.id);
      setCallbackResults([]);
      pushLog(
        replay
          ? `幂等重放 → 返回首次结果 ${result.outTradeNo}（未重复创建订单）`
          : `HMAC 签名下单成功 → ${result.outTradeNo} · 路由 ${result.channelCode} · ${yuan(result.amountCents)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushLog(`下单失败：${message}`);
    } finally {
      setBusy(false);
    }
  }

  async function simulate(selectedMode: CallbackMode, selectedOutcome: 'SUCCESS' | 'FAILURE'): Promise<void> {
    if (!order) {
      setError('请先创建支付订单');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await apiPost<{ results: unknown[]; order: PaymentOrder }>(
        '/api/v1/console/sandbox/callback',
        { orderId: order.id, outcome: selectedOutcome, mode: selectedMode },
      );
      setCallbackResults(result.results);
      setOrder(result.order);
      await refreshOrder(order.id);
      pushLog(`模拟回调 [${MODE_LABELS[selectedMode]} / ${selectedOutcome}] → ${result.results.length} 次投递`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushLog(`回调失败：${message}`);
    } finally {
      setBusy(false);
    }
  }

  const attemptColumns: Column<PaymentAttempt>[] = [
    { key: 'attemptNo', title: '尝试' },
    { key: 'channelCode', title: '通道', render: (r) => <span className="pp-mono">{r.channelCode}</span> },
    { key: 'outcome', title: '结果' },
    { key: 'latencyMs', title: '耗时', align: 'right', render: (r) => <span>{r.latencyMs} ms</span> },
    { key: 'errorCode', title: '错误码', render: (r) => <span className="pp-muted">{r.errorCode || '—'}</span> },
  ];

  return (
    <>
      <div className="pp-page-head">
        <div>
          <h2>支付沙箱</h2>
          <p>用浏览器 Web Crypto 真实计算 HMAC-SHA256 签名调用商户开放 API，完整跑通下单 → 路由 → 回调 → 入账 → 通知</p>
        </div>
        <ActionButton label="查看签名规范" onClick={() => setSpecOpen(true)} />
      </div>

      <div className="pp-alert info">
        合规边界：本沙箱仅使用模拟通道，不接任何真实资金、不实现个人收款码免签 / 异地收款 / 二清资金池。
        持牌通道仅保留适配器接口与配置位。
      </div>
      {error && <div className="pp-alert danger">{error}</div>}

      <div className="pp-grid-2">
        <Panel title="① 创建支付订单" sub="POST /api/v1/payments · 需 HMAC 签名 + Idempotency-Key">
          <div className="pp-form-grid">
            <Input label="商户订单号" value={outTradeNo} onChange={setOutTradeNo} />
            <Input label="金额（元）" value={amountYuan} onChange={setAmountYuan} placeholder="88.00" />
          </div>
          <Input label="商品标题" value={subject} onChange={setSubject} />
          <div className="pp-form-row">
            <label className="pp-form-label">支付方式</label>
            <select className="pp-select" style={{ width: '100%' }} value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="QRCODE">QRCODE · 扫码</option>
              <option value="H5">H5 · 手机网页</option>
              <option value="JSAPI">JSAPI · 公众号</option>
              <option value="WEB">WEB · PC 网银</option>
            </select>
          </div>
          <div className="pp-flex pp-wrap" style={{ marginTop: 4 }}>
            <ActionButton label="创建支付订单" variant="primary" disabled={busy} onClick={() => void createPayment(false)} />
            <ActionButton label="用同一幂等键重放" disabled={!lastKey || busy} onClick={() => void createPayment(true)} />
          </div>
          <div className="pp-alert warn" style={{ marginTop: 16, marginBottom: 0 }}>
            当前接入应用：<span className="pp-mono">{creds.data?.[0]?.apiKey || '加载中…'}</span><br />
            签名算法：HMAC-SHA256( METHOD \n PATH \n TIMESTAMP \n NONCE \n SHA256(稳定序列化 body) )
          </div>
        </Panel>

        <Panel title="② 收银台凭证" sub="通道适配器返回的二维码 / 收银台链接">
          {order ? (
            <>
              <QrMock value={order.credential?.value || order.id} />
              <div style={{ textAlign: 'center', marginTop: 12 }}>
                <StatusBadge status={order.status} />
                <div className="pp-strong" style={{ fontSize: 22, marginTop: 8 }}>{yuan(order.amountCents)}</div>
                <div className="pp-muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                  {order.channelName || order.channelCode} · 凭证有效期至 {shortTime(order.credential?.expiresAt || null)}
                </div>
                <div className="pp-mono pp-muted" style={{ fontSize: 10.5, marginTop: 6, wordBreak: 'break-all' }}>
                  {order.channelTradeNo}
                </div>
              </div>
            </>
          ) : (
            <div className="pp-empty">创建订单后这里会显示二维码凭证</div>
          )}
        </Panel>
      </div>

      <div className="pp-grid-2">
        <Panel title="③ 模拟通道回调" sub="回调报文带通道侧 HMAC 签名，服务端验签 + 幂等 + 金额核对">
          <div className="pp-form-grid">
            <div className="pp-form-row">
              <label className="pp-form-label">演练模式</label>
              <select className="pp-select" style={{ width: '100%' }} value={mode} onChange={(e) => setMode(e.target.value as CallbackMode)}>
                {(Object.keys(MODE_LABELS) as CallbackMode[]).map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
              </select>
            </div>
            <div className="pp-form-row">
              <label className="pp-form-label">回调结果</label>
              <select className="pp-select" style={{ width: '100%' }} value={outcome} onChange={(e) => setOutcome(e.target.value as 'SUCCESS' | 'FAILURE')}>
                <option value="SUCCESS">SUCCESS · 支付成功</option>
                <option value="FAILURE">FAILURE · 支付失败</option>
              </select>
            </div>
          </div>
          <div className="pp-flex pp-wrap">
            <ActionButton label="发送回调" variant="primary" disabled={!order || busy} onClick={() => void simulate(mode, outcome)} />
            <ActionButton label="重复回调" disabled={!order || busy} onClick={() => void simulate('duplicate', 'SUCCESS')} />
            <ActionButton label="乱序回调" disabled={!order || busy} onClick={() => void simulate('out_of_order', 'SUCCESS')} />
            <ActionButton label="金额篡改" disabled={!order || busy} onClick={() => void simulate('tamper_amount', 'SUCCESS')} />
          </div>
          {callbackResults.length > 0 && (
            <div className="pp-code-block" style={{ marginTop: 14 }}>
              {JSON.stringify(callbackResults, null, 2)}
            </div>
          )}
        </Panel>

        <Panel title="④ 路由轨迹与执行日志" sub="failover 尝试记录 + 沙箱操作流水">
          <DataTable columns={attemptColumns} rows={attempts} empty="尚未发起支付" />
          <div className="pp-code-block" style={{ marginTop: 12, maxHeight: 150 }}>
            {log.length ? log.join('\n') : '等待操作…'}
          </div>
        </Panel>
      </div>

      {order && (
        <div className="pp-kpi-grid">
          <KpiCard label="订单状态" value={order.status} sub={`聚合版本 v${order.version}`} tone="blue" />
          <KpiCard label="路由通道" value={order.channelCode || '—'} sub={order.channelName || ''} tone="green" />
          <KpiCard label="订单金额" value={yuan(order.amountCents)} sub={order.subject} tone="amber" />
          <KpiCard label="支付方式" value={order.method} sub={`创建于 ${shortTime(order.createdAt)}`} tone="blue" />
        </div>
      )}

      {specOpen && (
        <Modal
          title="商户 API 签名规范"
          onClose={() => setSpecOpen(false)}
          footer={<ActionButton label="关闭" variant="primary" onClick={() => setSpecOpen(false)} />}
        >
          <div className="pp-alert info">
            前端使用 Web Crypto API 计算签名，后端 <span className="pp-mono">authenticateMerchant</span> 用同一规范串校验，
            并做 5 分钟时间戳窗口与 nonce 防重放。这不是模拟请求。
          </div>
          <div className="pp-code-block">{`POST /api/v1/payments
X-Api-Key: pk_live_demo_001
X-Timestamp: <unix 秒>
X-Nonce: <随机唯一值>
X-Signature: HMAC_SHA256(apiSecret, canonical)
Idempotency-Key: <业务唯一键>

canonical =
  METHOD + "\\n" +
  PATH + "\\n" +
  TIMESTAMP + "\\n" +
  NONCE + "\\n" +
  SHA256_HEX(stableStringify(body))

幂等：同 key + 同请求体哈希 → 返回首次结果
      同 key + 不同请求体     → 409 IDEMPOTENCY_CONFLICT`}</div>
        </Modal>
      )}
    </>
  );
}
