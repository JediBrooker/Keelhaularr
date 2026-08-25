import { FormEvent, useEffect, useMemo, useState } from 'react';

type AppKind = 'radarr' | 'sonarr';
type Tab = 'oversized' | 'orphans';

interface PublicConnectionConfig {
  configured: boolean;
  maxMbPerMinute: number;
  toleranceGib: number;
  includeUnmonitored: boolean;
  mediaRoots: string[];
}

interface PublicConfig {
  radarr: PublicConnectionConfig;
  sonarr: PublicConnectionConfig;
  orphanAction: 'quarantine' | 'permanent';
  protected: boolean;
}

interface OversizedItem {
  id: string;
  app: AppKind;
  title: string;
  subtitle: string;
  path: string;
  sizeBytes: number;
  configuredLimitBytes: number;
  toleranceBytes: number;
  limitBytes: number;
  overageBytes: number;
  runtimeMinutes: number;
  maxMbPerMinute: number;
}

interface OrphanItem {
  id: string;
  app: AppKind;
  title: string;
  subtitle: string;
  path: string;
  relativePath: string;
  root: string;
  sizeBytes: number;
  modifiedAt: string;
}

interface ScanData {
  scannedAt: string;
  config: PublicConfig;
  connections: Record<AppKind, { status: string; version: string | null; error: string | null }>;
  oversized: OversizedItem[];
  orphans: OrphanItem[];
  roots: Array<{ app: AppKind; path: string; filesScanned: number }>;
  warnings: string[];
}

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Request failed with HTTP ${response.status}`);
  return data as T;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const order = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** order).toFixed(order >= 3 ? 2 : 1)} ${units[order]}`;
}

function AppBadge({ app }: { app: AppKind }) {
  return <span className={`app-chip ${app}`}>{app === 'radarr' ? 'Radarr' : 'Sonarr'}</span>;
}

function Login({ setupRequired, onLogin }: { setupRequired: boolean; onLogin: () => void }) {
  const [username, setUsername] = useState('captain');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      onLogin();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : String(loginError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-emblem" aria-hidden="true"><span>K</span></div>
        <p className="eyebrow gold">CAPTAIN’S EYES ONLY</p>
        <h1>Welcome aboard<br />Keelhaularr</h1>
        <p className="login-copy">Sign in to inspect the Radarr and Sonarr cargo holds.</p>
        {setupRequired ? (
          <div className="setup-message" role="alert">
            Set <code>APP_PASSWORD</code> in the server’s <code>.env</code> file, then restart Keelhaularr.
          </div>
        ) : (
          <form onSubmit={submit} className="login-form">
            <label>
              Captain’s name
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
            </label>
            <label>
              Secret phrase
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required autoFocus />
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary-button wide" disabled={busy} type="submit">
              {busy ? 'Opening the hatch…' : 'Board the deck'}
            </button>
          </form>
        )}
        <p className="login-foot">The *arr cargo control deck</p>
      </section>
    </main>
  );
}

function ConnectionPill({ app, scan, configured }: {
  app: AppKind;
  scan: ScanData | null;
  configured: boolean;
}) {
  const state = scan?.connections[app]?.status ?? (configured ? 'configured' : 'not-configured');
  const label = state === 'connected' ? 'Connected' : state === 'error' ? 'Error' : state === 'configured' ? 'Ready' : 'Not set';
  return (
    <div className={`status-pill ${state}`} title={scan?.connections[app]?.error ?? undefined}>
      <span /> {app === 'radarr' ? 'Radarr' : 'Sonarr'} <em>{label}</em>
    </div>
  );
}

function ConfirmDialog({ tab, count, action, busy, onCancel, onConfirm }: {
  tab: Tab;
  count: number;
  action: 'quarantine' | 'permanent';
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const phrase = tab === 'oversized' ? 'KEELHAUL' : action === 'permanent' ? 'ABANDON SHIP' : 'TO THE BRIG';
  const [input, setInput] = useState('');
  const oversized = tab === 'oversized';
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="danger-emblem" aria-hidden="true">☠</div>
        <p className="eyebrow coral">FINAL CAPTAIN’S ORDER</p>
        <h2 id="confirm-title">{oversized ? 'Keelhaul selected cargo?' : action === 'permanent' ? 'Permanently delete orphans?' : 'Move orphans to quarantine?'}</h2>
        <p>
          {oversized
            ? `${count} tracked file(s) will be deleted through their *arr app, then searched again.`
            : action === 'permanent'
              ? `${count} untracked file(s) will be permanently removed from disk. This cannot be undone.`
              : `${count} untracked file(s) will be moved into Keelhaularr’s quarantine area.`}
        </p>
        <label className="confirm-label">
          Type <strong>{phrase}</strong> to continue
          <input value={input} onChange={(event) => setInput(event.target.value)} autoFocus autoComplete="off" />
        </label>
        <div className="dialog-actions">
          <button className="ghost-button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="danger-button" onClick={onConfirm} disabled={busy || input !== phrase}>
            {busy ? 'Carrying out order…' : 'Confirm order'}
          </button>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState<'loading' | 'signed-out' | 'signed-in'>('loading');
  const [setupRequired, setSetupRequired] = useState(false);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [scan, setScan] = useState<ScanData | null>(null);
  const [tab, setTab] = useState<Tab>('oversized');
  const [filter, setFilter] = useState<'all' | AppKind>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ authenticated: boolean; setupRequired: boolean }>('/api/auth/status')
      .then(async (status) => {
        setSetupRequired(status.setupRequired);
        if (!status.authenticated) {
          setAuth('signed-out');
          return;
        }
        const statusData = await api<{ config: PublicConfig }>('/api/status');
        setConfig(statusData.config);
        setAuth('signed-in');
      })
      .catch((authError) => {
        setError(authError instanceof Error ? authError.message : String(authError));
        setAuth('signed-out');
      });
  }, []);

  const visible = useMemo(() => {
    const source = tab === 'oversized' ? scan?.oversized ?? [] : scan?.orphans ?? [];
    return filter === 'all' ? source : source.filter((item) => item.app === filter);
  }, [filter, scan, tab]);
  const selectedVisible = visible.filter((item) => selected.has(item.id));
  const totalOversized = scan?.oversized.reduce((sum, item) => sum + item.sizeBytes, 0) ?? 0;
  const totalOrphans = scan?.orphans.reduce((sum, item) => sum + item.sizeBytes, 0) ?? 0;

  async function signedIn() {
    const statusData = await api<{ config: PublicConfig }>('/api/status');
    setConfig(statusData.config);
    setAuth('signed-in');
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
    setAuth('signed-out');
    setScan(null);
    setConfig(null);
  }

  async function runScan() {
    setScanning(true);
    setError('');
    setMessage('');
    try {
      const data = await api<ScanData>('/api/scan', { method: 'POST', body: '{}' });
      setScan(data);
      setConfig(data.config);
      setSelected(new Set());
      setMessage(`Manifest refreshed at ${new Date(data.scannedAt).toLocaleTimeString()}.`);
    } catch (scanError) {
      if (scanError instanceof Error && scanError.message.includes('Sign in')) setAuth('signed-out');
      setError(scanError instanceof Error ? scanError.message : String(scanError));
    } finally {
      setScanning(false);
    }
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((current) => {
      const next = new Set(current);
      const allSelected = visible.length > 0 && visible.every((item) => next.has(item.id));
      visible.forEach((item) => allSelected ? next.delete(item.id) : next.add(item.id));
      return next;
    });
  }

  async function applySelection() {
    setApplying(true);
    setError('');
    try {
      const endpoint = tab === 'oversized' ? '/api/oversized/apply' : '/api/orphans/apply';
      const result = await api<{ results: Array<{ status: string }>; matched: number }>(endpoint, {
        method: 'POST',
        body: JSON.stringify({ ids: selectedVisible.map((item) => item.id) }),
      });
      const succeeded = result.results.filter((item) => item.status !== 'failed').length;
      const failed = result.results.length - succeeded;
      setMessage(`${succeeded} file(s) handled${failed ? `; ${failed} failed` : ''}. Rescanning the holds…`);
      setConfirming(false);
      await runScan();
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : String(applyError));
    } finally {
      setApplying(false);
    }
  }

  if (auth === 'loading') return <main className="loading-page"><div className="wheel">K</div><p>Raising the gangway…</p></main>;
  if (auth === 'signed-out') return <Login setupRequired={setupRequired} onLogin={signedIn} />;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">K</span>
          <div><p className="eyebrow">THE OVERBOARD OFFICER</p><h1>Keelhaularr</h1></div>
        </div>
        <div className="header-actions">
          <div className="connection-cluster">
            <ConnectionPill app="radarr" scan={scan} configured={Boolean(config?.radarr.configured)} />
            <ConnectionPill app="sonarr" scan={scan} configured={Boolean(config?.sonarr.configured)} />
          </div>
          <button className="text-button" onClick={logout}>Sign out</button>
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow gold">THE *ARR CARGO DECK</p>
          <h2>Keep the treasure.<br />Toss the ballast.</h2>
          <p className="hero-copy">Inspect oversized tracked media and untracked files across both holds. Nothing leaves the ship without your order.</p>
        </div>
        <button className="primary-button scan-button" onClick={runScan} disabled={scanning}>
          <span aria-hidden="true" className={scanning ? 'spin' : ''}>↻</span>
          {scanning ? 'Sounding the holds…' : 'Scan both holds'}
        </button>
      </section>

      {(message || error) && <div className={`notice ${error ? 'error' : 'success'}`} role="status">{error || message}</div>}
      {scan?.warnings.map((warning) => <div className="notice warning" key={warning}>{warning}</div>)}

      <section className="stat-grid" aria-label="Cargo summary">
        <article className="stat-card accent"><p>Oversized cargo</p><strong>{scan?.oversized.length ?? '—'}</strong><span>{scan ? formatBytes(totalOversized) : 'run a scan to inspect'}</span></article>
        <article className="stat-card"><p>Orphan watch</p><strong>{scan?.orphans.length ?? '—'}</strong><span>{scan ? formatBytes(totalOrphans) : 'untracked media files'}</span></article>
        <article className="stat-card"><p>Standing orders</p><div className="dual-orders"><strong>{config?.radarr.maxMbPerMinute ?? '—'} <small>Radarr</small></strong><strong>{config?.sonarr.maxMbPerMinute ?? '—'} <small>Sonarr</small></strong></div><span>oversize tolerance applied per hold</span></article>
      </section>

      <section className="manifest">
        <div className="manifest-head">
          <div>
            <p className="eyebrow">CARGO MANIFEST</p>
            <h3>{tab === 'oversized' ? 'Tracked files over standing orders' : 'Media not tracked by either captain'}</h3>
          </div>
          <button className="danger-button" disabled={!selectedVisible.length || scanning} onClick={() => setConfirming(true)}>
            {tab === 'oversized' ? 'Keelhaul' : config?.orphanAction === 'permanent' ? 'Delete' : 'Quarantine'} selected · {selectedVisible.length}
          </button>
        </div>

        <div className="manifest-tools">
          <div className="tabs" role="tablist">
            <button className={tab === 'oversized' ? 'active' : ''} onClick={() => { setTab('oversized'); setSelected(new Set()); }}>Oversized <span>{scan?.oversized.length ?? 0}</span></button>
            <button className={tab === 'orphans' ? 'active' : ''} onClick={() => { setTab('orphans'); setSelected(new Set()); }}>Orphan watch <span>{scan?.orphans.length ?? 0}</span></button>
          </div>
          <div className="filters" aria-label="Filter by application">
            {(['all', 'radarr', 'sonarr'] as const).map((value) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value === 'all' ? 'Both holds' : value}</button>)}
          </div>
        </div>

        {!scan ? (
          <div className="empty-state"><div aria-hidden="true">⌁</div><h4>No manifest yet</h4><p>Scan both holds to compare real files with your current standing orders.</p><button className="primary-button" onClick={runScan}>Begin first scan</button></div>
        ) : visible.length === 0 ? (
          <div className="empty-state clear"><div aria-hidden="true">✓</div><h4>All clear in this hold</h4><p>No matching cargo needs your attention.</p></div>
        ) : tab === 'oversized' ? (
          <OversizedTable items={visible as OversizedItem[]} selected={selected} onToggle={toggle} onToggleAll={toggleAll} />
        ) : (
          <OrphanTable items={visible as OrphanItem[]} selected={selected} onToggle={toggle} onToggleAll={toggleAll} action={config?.orphanAction ?? 'quarantine'} />
        )}

        <p className="safety-note"><span aria-hidden="true">⚓</span>{tab === 'oversized' ? 'Tracked files are deleted through Radarr or Sonarr, then searched again using that app’s existing profiles.' : config?.orphanAction === 'permanent' ? 'Permanent orphan removal is enabled. Selected files are revalidated immediately before deletion.' : 'Orphans are moved to quarantine by default. Selected files are revalidated immediately before moving.'}</p>
      </section>

      <section className="orders-panel">
        <div><p className="eyebrow">STANDING ORDERS</p><h3>Server-side settings</h3></div>
        {(['radarr', 'sonarr'] as AppKind[]).map((app) => {
          const item = config?.[app];
          return <article key={app}><AppBadge app={app} /><strong>{item?.maxMbPerMinute ?? '—'} MB/min</strong><span>+ {item?.toleranceGib ?? '—'} GiB tolerance</span><span>{item?.mediaRoots.length ? `${item.mediaRoots.length} media root(s)` : 'orphan scan off'}</span></article>;
        })}
        <article><span className="app-chip orphan">Orphans</span><strong>{config?.orphanAction ?? '—'}</strong><span>configured in .env</span></article>
      </section>

      <footer><span>Keelhaularr</span> · No automatic deletions · Every order is revalidated server-side</footer>
      {confirming && <ConfirmDialog tab={tab} count={selectedVisible.length} action={config?.orphanAction ?? 'quarantine'} busy={applying} onCancel={() => setConfirming(false)} onConfirm={applySelection} />}
    </main>
  );
}

function SelectAll({ items, selected, onToggleAll }: { items: Array<{ id: string }>; selected: Set<string>; onToggleAll: () => void }) {
  const checked = items.length > 0 && items.every((item) => selected.has(item.id));
  return <input type="checkbox" checked={checked} onChange={onToggleAll} aria-label="Select all visible files" />;
}

function OversizedTable({ items, selected, onToggle, onToggleAll }: { items: OversizedItem[]; selected: Set<string>; onToggle: (id: string) => void; onToggleAll: () => void }) {
  return <div className="table-wrap"><table><thead><tr><th><SelectAll items={items} selected={selected} onToggleAll={onToggleAll} /></th><th>Title</th><th>Hold</th><th>Actual size</th><th>Allowed</th><th>Over by</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className={selected.has(item.id) ? 'selected-row' : ''}><td><input type="checkbox" checked={selected.has(item.id)} onChange={() => onToggle(item.id)} aria-label={`Select ${item.title}`} /></td><td><div className="movie-title">{item.title}</div><div className="quality-chip">{item.subtitle}</div><div className="path-line" title={item.path}>{item.path}</div></td><td><AppBadge app={item.app} /></td><td className="numeric">{formatBytes(item.sizeBytes)}</td><td><div className="numeric muted">{formatBytes(item.limitBytes)}</div><div className="limit-note">{formatBytes(item.configuredLimitBytes)} + {formatBytes(item.toleranceBytes)}</div></td><td><span className="excess-chip">+{formatBytes(item.overageBytes)}</span></td></tr>)}</tbody></table></div>;
}

function OrphanTable({ items, selected, onToggle, onToggleAll, action }: { items: OrphanItem[]; selected: Set<string>; onToggle: (id: string) => void; onToggleAll: () => void; action: string }) {
  return <div className="table-wrap"><table><thead><tr><th><SelectAll items={items} selected={selected} onToggleAll={onToggleAll} /></th><th>Untracked media</th><th>Hold</th><th>Size</th><th>Modified</th><th>Action</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className={selected.has(item.id) ? 'selected-row' : ''}><td><input type="checkbox" checked={selected.has(item.id)} onChange={() => onToggle(item.id)} aria-label={`Select ${item.title}`} /></td><td><div className="movie-title">{item.title}</div><div className="path-line" title={item.path}>{item.path}</div></td><td><AppBadge app={item.app} /></td><td className="numeric">{formatBytes(item.sizeBytes)}</td><td className="muted date-cell">{new Date(item.modifiedAt).toLocaleDateString()}</td><td><span className={`action-chip ${action}`}>{action}</span></td></tr>)}</tbody></table></div>;
}
