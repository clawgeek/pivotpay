import React, { useEffect, useState } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { getTenantId, setTenantId, useApi } from './api/client';
import type { Tenant } from './types';
import Dashboard from './pages/Dashboard';
import Orders from './pages/Orders';
import Sandbox from './pages/Sandbox';
import Channels from './pages/Channels';
import Routing from './pages/Routing';
import Operations from './pages/Operations';

const NAV_GROUPS: Array<{ group: string; items: Array<{ id: string; label: string; icon: string }> }> = [
  {
    group: '总览',
    items: [{ id: 'dashboard', label: '经营驾驶舱', icon: '▦' }],
  },
  {
    group: '交易',
    items: [
      { id: 'orders', label: '支付订单', icon: '▤' },
      { id: 'sandbox', label: '支付沙箱', icon: '◈' },
    ],
  },
  {
    group: '通道与高可用',
    items: [
      { id: 'channels', label: '通道配置', icon: '◫' },
      { id: 'routing', label: '路由与熔断', icon: '◎' },
    ],
  },
  {
    group: '运营',
    items: [
      { id: 'webhooks', label: '回调通知', icon: '↻' },
      { id: 'reconciliation', label: '日终对账', icon: '☷' },
      { id: 'ledger', label: '账务流水', icon: '≡' },
    ],
  },
  {
    group: '系统',
    items: [
      { id: 'tenants', label: '商户与密钥', icon: '◉' },
      { id: 'audit', label: '审计日志', icon: '▣' },
    ],
  },
];

const PAGE_TITLES: Record<string, string> = Object.fromEntries(
  NAV_GROUPS.flatMap((g) => g.items.map((i) => [i.id, i.label])),
);

const PAGE_COMPONENTS: Record<string, React.ComponentType<{ section?: string }>> = {
  dashboard: Dashboard,
  orders: Orders,
  sandbox: Sandbox,
  channels: Channels,
  routing: Routing,
  webhooks: Operations,
  reconciliation: Operations,
  ledger: Operations,
  tenants: Operations,
  audit: Operations,
};

function currentPage(): string {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return PAGE_COMPONENTS[raw] ? raw : 'dashboard';
}

export default function App(): React.ReactElement {
  const [page, setPage] = useState(currentPage);
  const [tenantId, setTenant] = useState(getTenantId());
  const tenants = useApi<Tenant[]>('/api/v1/console/tenants');
  const health = useApi<{ status: string }>('/health/ready', 0, 10_000);

  useEffect(() => {
    const onHashChange = () => setPage(currentPage());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const go = (id: string) => {
    window.location.hash = `/${id}`;
    setPage(id);
  };

  const Page = PAGE_COMPONENTS[page] || Dashboard;
  const currentTenant = tenants.data?.find((t) => t.id === tenantId);
  const healthy = health.data?.status === 'ready';

  return (
    <Theme theme={neutralTheme}>
      <div className="pp-app">
        <aside className="pp-sidebar">
          <div className="pp-brand">
            <div className="pp-brand-title">
              <span className="pp-brand-logo">P</span>
              <span>云枢支付</span>
            </div>
            <div className="pp-brand-sub">PIVOTPAY · DDD CLOUD PAYMENT</div>
          </div>
          <nav className="pp-nav">
            {NAV_GROUPS.map((group) => (
              <React.Fragment key={group.group}>
                <div className="pp-nav-group">{group.group}</div>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    className={`pp-nav-item${page === item.id ? ' active' : ''}`}
                    onClick={() => go(item.id)}
                  >
                    <span className="pp-nav-icon">{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </React.Fragment>
            ))}
          </nav>
          <div className="pp-sidebar-foot">
            SaaS 多租户 · 沙箱环境<br />
            NestJS DDD · React 19 / Astryx
          </div>
        </aside>

        <div className="pp-main">
          <header className="pp-topbar">
            <h1>{PAGE_TITLES[page] || '经营驾驶舱'}</h1>
            <span className="pp-env">沙箱环境 · 无真实资金</span>
            <div className="pp-topbar-spacer" />
            <div className="pp-health">
              <span className={`pp-health-dot${healthy ? '' : ' down'}`} />
              {healthy ? '服务就绪' : '检查中'}
            </div>
            <select
              className="pp-select"
              value={tenantId}
              onChange={(e) => {
                setTenantId(e.target.value);
                setTenant(e.target.value);
              }}
              aria-label="切换租户"
            >
              {(tenants.data || []).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <span className="pp-muted" style={{ fontSize: 11.5 }}>
              {currentTenant?.plan === 'enterprise' ? '企业版' : currentTenant?.plan === 'standard' ? '标准版' : '入门版'}
            </span>
          </header>
          <main className="pp-content">
            <Page key={tenantId} section={page} />
          </main>
        </div>
      </div>
    </Theme>
  );
}
