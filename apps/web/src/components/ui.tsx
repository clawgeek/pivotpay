import React from 'react';
import { Badge, Button, Card, TextInput, Switch } from '@astryxdesign/core';
import { yuan, shortTime } from '../api/client';
import type { PaymentStatus } from '../types';

export function Panel(props: {
  title: string;
  sub?: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
  flush?: boolean;
}): React.ReactElement {
  return (
    <Card className="pp-panel">
      <div className="pp-panel-head">
        <div>
          <div className="pp-panel-title">{props.title}</div>
          {props.sub && <div className="pp-panel-sub">{props.sub}</div>}
        </div>
        {props.extra}
      </div>
      <div className={`pp-panel-body${props.flush ? ' flush' : ''}`}>
        {props.children}
      </div>
    </Card>
  );
}

export function KpiCard(props: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'blue' | 'green' | 'amber' | 'red';
}): React.ReactElement {
  const colors: Record<string, string> = {
    blue: '#2563eb', green: '#16a34a', amber: '#d97706', red: '#dc2626',
  };
  return (
    <div className="pp-kpi">
      <span className="pp-kpi-accent" style={{ background: colors[props.tone || 'blue'] }} />
      <div className="pp-kpi-label">{props.label}</div>
      <div className="pp-kpi-value">{props.value}</div>
      {props.sub && <div className="pp-kpi-sub">{props.sub}</div>}
    </div>
  );
}

const STATUS_META: Record<string, { label: string; variant: 'neutral' | 'info' | 'success' | 'warning' | 'error' }> = {
  CREATED: { label: '待支付', variant: 'neutral' },
  PAYING: { label: '处理中', variant: 'info' },
  PAID: { label: '支付成功', variant: 'success' },
  PARTIAL_REFUNDED: { label: '部分退款', variant: 'warning' },
  REFUNDED: { label: '已全额退款', variant: 'warning' },
  FAILED: { label: '支付失败', variant: 'error' },
  CLOSED: { label: '已关单', variant: 'neutral' },
};

export function StatusBadge({ status }: { status: PaymentStatus | string }): React.ReactElement {
  const meta = STATUS_META[status] || { label: status, variant: 'neutral' as const };
  return <Badge label={meta.label} variant={meta.variant} />;
}

const STATE_META: Record<string, { label: string; variant: 'success' | 'error' | 'warning' | 'neutral' }> = {
  CLOSED: { label: '熔断关闭 · 正常', variant: 'success' },
  OPEN: { label: '熔断打开 · 隔离', variant: 'error' },
  HALF_OPEN: { label: '半开 · 探测中', variant: 'warning' },
};

export function BreakerBadge({ state }: { state: string }): React.ReactElement {
  const meta = STATE_META[state] || { label: state, variant: 'neutral' as const };
  return <Badge label={meta.label} variant={meta.variant} />;
}

export interface Column<T> {
  key: string;
  title: string;
  width?: number;
  align?: 'right';
  render?: (row: T) => React.ReactNode;
}

export function DataTable<T extends Record<string, any>>(props: {
  columns: Column<T>[];
  rows: T[] | null | undefined;
  empty?: string;
}): React.ReactElement {
  const rows = props.rows || [];
  if (rows.length === 0) {
    return <div className="pp-empty">{props.empty || '暂无数据'}</div>;
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="pp-data-table">
        <thead>
          <tr>
            {props.columns.map((col) => (
              <th
                key={col.key}
                style={{ width: col.width, textAlign: col.align === 'right' ? 'right' : undefined }}
              >
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={String(row.id ?? index)}>
              {props.columns.map((col) => (
                <td
                  key={col.key}
                  style={{ textAlign: col.align === 'right' ? 'right' : undefined }}
                >
                  {col.render ? col.render(row) : (row[col.key] as React.ReactNode)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="pp-modal-backdrop" onClick={props.onClose}>
      <div className="pp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pp-modal-head">
          <div className="pp-modal-title">{props.title}</div>
          <button className="pp-close" onClick={props.onClose} aria-label="关闭">×</button>
        </div>
        <div className="pp-modal-body">{props.children}</div>
        {props.footer && <div className="pp-modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

export function FormField(props: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}): React.ReactElement {
  return (
    <div className="pp-form-row">
      <label className="pp-form-label">{props.label}</label>
      {props.children}
      {props.hint && <div className="pp-muted" style={{ fontSize: 11, marginTop: 4 }}>{props.hint}</div>}
    </div>
  );
}

/** 用 Astryx TextInput 包装的受控输入框 */
export function Input(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'password' | 'email' | 'search' | 'tel' | 'url';
}): React.ReactElement {
  return (
    <TextInput
      label={props.label}
      value={props.value}
      onChange={(value: string) => props.onChange(value)}
      placeholder={props.placeholder}
      type={props.type || 'text'}
      width="100%"
    />
  );
}

export function Toggle(props: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}): React.ReactElement {
  return (
    <Switch
      label={props.label}
      value={props.value}
      onChange={(checked: boolean) => props.onChange(checked)}
    />
  );
}

export function ActionButton(props: {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
  disabled?: boolean;
}): React.ReactElement {
  return (
    <Button
      label={props.label}
      variant={props.variant || 'secondary'}
      size="md"
      isDisabled={props.disabled}
      onClick={props.onClick}
    />
  );
}

export function LineChart({ points }: { points: Array<{ day: string; amount: number }> }): React.ReactElement {
  const width = 640;
  const height = 148;
  const pad = 14;
  if (!points.length) return <div className="pp-empty">暂无趋势数据</div>;
  const max = Math.max(...points.map((p) => p.amount), 1);
  const stepX = (width - pad * 2) / Math.max(points.length - 1, 1);
  const coords = points.map((p, i) => [
    pad + i * stepX,
    height - pad - (p.amount / max) * (height - pad * 2),
  ]);
  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c[0]},${c[1]}`).join(' ');
  const area = `${line} L${coords[coords.length - 1][0]},${height - pad} L${coords[0][0]},${height - pad} Z`;
  return (
    <svg className="pp-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="ppArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={pad} x2={width - pad} y1={pad + f * (height - pad * 2)} y2={pad + f * (height - pad * 2)} stroke="#eef1f6" strokeWidth="1" />
      ))}
      <path d={area} fill="url(#ppArea)" />
      <path d={line} fill="none" stroke="#2563eb" strokeWidth="2.2" strokeLinejoin="round" />
      {coords.map((c, i) => (
        <circle key={i} cx={c[0]} cy={c[1]} r="3.2" fill="#fff" stroke="#2563eb" strokeWidth="2" />
      ))}
    </svg>
  );
}

/** 确定性伪二维码（纯 SVG，不依赖第三方库，仅用于沙箱收银台演示） */
export function QrMock({ value }: { value: string }): React.ReactElement {
  const size = 25;
  const cells: React.ReactElement[] = [];
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const inFinder = (r: number, c: number): boolean => {
    const zones = [[0, 0], [0, size - 7], [size - 7, 0]];
    return zones.some(([zr, zc]) => r >= zr && r < zr + 7 && c >= zc && c < zc + 7);
  };
  const finder = (r: number, c: number): boolean => {
    const zones = [[0, 0], [0, size - 7], [size - 7, 0]];
    for (const [zr, zc] of zones) {
      const dr = r - zr, dc = c - zc;
      if (dr >= 0 && dr < 7 && dc >= 0 && dc < 7) {
        const border = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        return border || core;
      }
    }
    return false;
  };
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      const on = inFinder(r, c)
        ? finder(r, c)
        : ((Math.imul(hash ^ (r * 73856093) ^ (c * 19349663), 2654435761) >>> 0) % 100) < 47;
      if (on) {
        cells.push(<rect key={`${r}-${c}`} x={c} y={r} width="1" height="1" fill="#0f172a" />);
      }
    }
  }
  return (
    <div className="pp-qr-frame">
      <svg viewBox={`-1 -1 ${size + 2} ${size + 2}`} width="100%" height="100%" shapeRendering="crispEdges">
        <rect x="-1" y="-1" width={size + 2} height={size + 2} fill="#fff" />
        {cells}
      </svg>
    </div>
  );
}

export function moneyCell(cents: number): React.ReactNode {
  return <span className="pp-strong">{yuan(cents)}</span>;
}

export function timeCell(iso: string | null): React.ReactNode {
  return <span className="pp-muted">{shortTime(iso)}</span>;
}
