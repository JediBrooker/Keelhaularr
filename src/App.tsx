import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { ModalDialog } from './ModalDialog';
import { OperationsDialog } from './OperationsDialog';
import { SettingsDialog } from './SettingsDialog';

type AppKind = 'radarr' | 'sonarr';
type Tab = 'oversized' | 'orphans';
const manifestTabs: Tab[] = ['oversized', 'orphans'];

function skipToMain(event: MouseEvent<HTMLAnchorElement> | KeyboardEvent<HTMLAnchorElement>) {
  event.preventDefault();
  document.getElementById('main-content')?.focus();
}

interface PublicConnectionConfig {
  configured: boolean;
  maxMbPerMinute: number;
  toleranceGib: number;
  useArrQualityDefinitions: boolean;
  includeUnmonitored: boolean;
  mediaRoots: string[];
  downloadRoots: string[];
}

interface PublicConfig {
  radarr: PublicConnectionConfig;
  sonarr: PublicConnectionConfig;
  qbittorrent: { configured: boolean };
  orphanAction: 'quarantine' | 'permanent';
  hardlinkMinAgeHours: number;
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
  limitSource: string;
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
  source: 'library' | 'download';
}

interface ScanData {
  scannedAt: string;
  config: PublicConfig;
  connections: Record<AppKind, { status: string; version: string | null; error: string | null }>;
  oversized: OversizedItem[];
  orphans: OrphanItem[];
  roots: Array<{ app: AppKind; kind: 'library' | 'download'; path: string; filesScanned: number }>;
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
              Username
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required autoFocus />
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary-button wide" disabled={busy} type="submit">
              {busy ? 'Signing in…' : 'Sign in'}
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
  const label = state === 'connected' ? 'Connected' : state === 'error' ? 'Error' : state === 'configured' ? 'Configured' : 'Not set';
  return (
    <div className={`status-pill ${state}`} title={scan?.connections[app]?.error ?? undefined}>
      <span /> {app === 'radarr' ? 'Radarr' : 'Sonarr'} <em>{label}</em>
    </div>
  );
}

function ConfirmDialog({ open, tab, count, action, busy, onCancel, onConfirm }: {
  open: boolean;
  tab: Tab;
  count: number;
  action: 'quarantine' | 'permanent';
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const oversized = tab === 'oversized';
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  return (
    <ModalDialog
      open={open}
      labelledBy="confirm-title"
      describedBy="confirm-description"
      className="confirm-modal"
      dialogRef={dialogRef}
      initialFocusRef={cancelRef}
      dismissible={!busy}
      onDismiss={() => { if (!busy) onCancel(); }}
    >
      <section className="confirm-dialog">
        <div className="danger-emblem" aria-hidden="true">☠</div>
        <p className="eyebrow coral">DELETION CONFIRMATION</p>
        <h2 id="confirm-title">{oversized ? 'Remove selected files and search again?' : action === 'permanent' ? 'Delete selected untracked files permanently?' : 'Quarantine selected untracked files?'}</h2>
        <p id="confirm-description">
          {oversized
            ? `${count} tracked file(s) will be deleted through their *arr app, then searched again.`
            : action === 'permanent'
              ? `${count} untracked file(s) will be permanently removed from disk. This cannot be undone.`
              : `${count} untracked file(s) will be moved into Keelhaularr’s quarantine area.`}
        </p>
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" className="ghost-button" onClick={() => dialogRef.current?.close()} disabled={busy}>CANCEL</button>
          <button type="button" className="danger-button" onClick={onConfirm} disabled={busy}>
            {busy ? 'CONFIRMING…' : 'CONFIRM'}
          </button>
        </div>
      </section>
    </ModalDialog>
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
  const [showSettings, setShowSettings] = useState(false);
  const [showOperations, setShowOperations] = useState(false);
  const [operationsTab, setOperationsTab] = useState<'jobs' | 'brig' | 'storage' | 'exclusions' | 'schedule'>('jobs');
  const [jobsAwaitingRefresh, setJobsAwaitingRefresh] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [minimumGib, setMinimumGib] = useState('0');
  const [sort, setSort] = useState<'largest' | 'overage' | 'title' | 'oldest'>('largest');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const scanRequestId = useRef(0);

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
        if (!statusData.config.radarr.configured && !statusData.config.sonarr.configured) setShowSettings(true);
        setAuth('signed-in');
      })
      .catch((authError) => {
        setError(authError instanceof Error ? authError.message : String(authError));
        setAuth('signed-out');
      });
  }, []);

  const source = tab === 'oversized' ? scan?.oversized ?? [] : scan?.orphans ?? [];
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const minimum = Math.max(0, Number(minimumGib) || 0) * 1024 ** 3;
    const filtered = source.filter((item) => (
      (filter === 'all' || item.app === filter)
      && (!needle || `${item.title} ${item.subtitle} ${item.path}`.toLowerCase().includes(needle))
      && (tab === 'oversized' ? (item as OversizedItem).overageBytes >= minimum : item.sizeBytes >= minimum)
    ));
    return [...filtered].sort((left, right) => {
      if (sort === 'title') return left.title.localeCompare(right.title);
      if (sort === 'oldest') return new Date((left as OrphanItem).modifiedAt ?? 0).getTime() - new Date((right as OrphanItem).modifiedAt ?? 0).getTime();
      if (sort === 'overage') return Number((right as OversizedItem).overageBytes ?? right.sizeBytes) - Number((left as OversizedItem).overageBytes ?? left.sizeBytes);
      return right.sizeBytes - left.sizeBytes;
    });
  }, [filter, minimumGib, query, scan, sort, tab]);
  const selectedVisible = visible.filter((item) => selected.has(item.id));
  const scanHasConnectionError = Boolean(scan && (
    scan.connections.radarr.status === 'error' || scan.connections.sonarr.status === 'error'
  ));
  const scanHasNoConfiguredApps = Boolean(scan
    && !scan.config.radarr.configured
    && !scan.config.sonarr.configured);
  const scanIsIncomplete = Boolean(scan?.warnings.length) || scanHasConnectionError || scanHasNoConfiguredApps;
  const totalOversized = scan?.oversized.reduce((sum, item) => sum + item.sizeBytes, 0) ?? 0;
  const totalOrphans = scan?.orphans.reduce((sum, item) => sum + item.sizeBytes, 0) ?? 0;

  async function signedIn() {
    const statusData = await api<{ config: PublicConfig }>('/api/status');
    setConfig(statusData.config);
    if (!statusData.config.radarr.configured && !statusData.config.sonarr.configured) setShowSettings(true);
    setAuth('signed-in');
  }

  async function logout() {
    scanRequestId.current += 1;
    setScanning(false);
    setJobsAwaitingRefresh([]);
    await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
    scanRequestId.current += 1;
    setScanning(false);
    setAuth('signed-out');
    setScan(null);
    setConfig(null);
  }

  async function settingsSaved() {
    scanRequestId.current += 1;
    setScanning(false);
    const statusData = await api<{ config: PublicConfig }>('/api/status');
    setConfig(statusData.config);
    setScan(null);
    setSelected(new Set());
    setMessage('Standing orders changed. Run a fresh scan when ready.');
    setError('');
  }

  async function runScan() {
    const requestId = ++scanRequestId.current;
    setScanning(true);
    setError('');
    setMessage('');
    try {
      const data = await api<ScanData>('/api/scan', { method: 'POST', body: '{}' });
      if (requestId !== scanRequestId.current) return false;
      setScan(data);
      setConfig(data.config);
      setSelected(new Set());
      setMessage(`Manifest refreshed at ${new Date(data.scannedAt).toLocaleTimeString()}.`);
      return true;
    } catch (scanError) {
      if (requestId !== scanRequestId.current) return false;
      if (scanError instanceof Error && scanError.message.includes('Sign in')) setAuth('signed-out');
      setError(scanError instanceof Error ? scanError.message : String(scanError));
      return false;
    } finally {
      if (requestId === scanRequestId.current) setScanning(false);
    }
  }

  useEffect(() => {
    if (auth !== 'signed-in' || !jobsAwaitingRefresh.length) return;
    let stopped = false;
    let timer: number | undefined;
    let refreshRetryDelay = 3000;

    const poll = async () => {
      try {
        const result = await api<{ jobs: Array<{ id: string; completedAt: string | null }> }>('/api/jobs');
        if (stopped) return;
        const completionTimes = new Map(result.jobs.map((job) => [job.id, job.completedAt]));
        const allJobsSettled = jobsAwaitingRefresh.every((id) => Boolean(completionTimes.get(id)));
        if (allJobsSettled) {
          const refreshed = await runScan();
          if (stopped) return;
          if (refreshed) {
            setJobsAwaitingRefresh((current) => current === jobsAwaitingRefresh ? [] : current);
            return;
          }
          timer = window.setTimeout(poll, refreshRetryDelay);
          refreshRetryDelay = Math.min(refreshRetryDelay * 2, 60000);
          return;
        }
      } catch (pollError) {
        if (pollError instanceof Error && pollError.message.includes('Sign in')) {
          setAuth('signed-out');
          return;
        }
        // A transient polling error should not make the dashboard give up on refreshing.
      }
      if (!stopped) timer = window.setTimeout(poll, 3000);
    };

    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [auth, jobsAwaitingRefresh]);

  function refreshWhenJobSettles(id: string) {
    setJobsAwaitingRefresh((current) => [...current.filter((jobId) => jobId !== id), id]);
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

  function selectFirst(count: number) {
    setSelected(new Set(visible.slice(0, count).map((item) => item.id)));
  }

  function selectManifestTab(next: Tab) {
    setTab(next);
    setSort('largest');
    setSelected(new Set());
  }

  function handleManifestTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: Tab) {
    const currentIndex = manifestTabs.indexOf(current);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % manifestTabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + manifestTabs.length) % manifestTabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = manifestTabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = manifestTabs[nextIndex];
    selectManifestTab(next);
    window.requestAnimationFrame(() => document.getElementById(`manifest-tab-${next}`)?.focus());
  }

  function clearFilters() {
    setFilter('all');
    setQuery('');
    setMinimumGib('0');
  }

  async function excludeSelection() {
    if (tab !== 'oversized' || !selectedVisible.length) return;
    setApplying(true);
    setError('');
    try {
      await api('/api/exclusions', { method: 'POST', body: JSON.stringify({ ids: selectedVisible.map((item) => item.id) }) });
      setMessage(`${selectedVisible.length} item(s) excluded from future oversize scans.`);
      await runScan();
    } catch (excludeError) {
      setError(excludeError instanceof Error ? excludeError.message : String(excludeError));
    } finally {
      setApplying(false);
    }
  }

  async function applySelection() {
    setApplying(true);
    setError('');
    try {
      const endpoint = tab === 'oversized' ? '/api/oversized/apply' : '/api/orphans/apply';
      const result = await api<{ job: { id: string; title: string } }>(endpoint, {
        method: 'POST',
        body: JSON.stringify({ ids: selectedVisible.map((item) => item.id) }),
      });
      refreshWhenJobSettles(result.job.id);
      setMessage(`${result.job.title} started. Progress is saved and can be followed in Operations → Jobs.`);
      setConfirming(false);
      setSelected(new Set());
      setOperationsTab('jobs');
      setShowOperations(true);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : String(applyError));
    } finally {
      setApplying(false);
    }
  }

  if (auth === 'loading') return <main className="loading-page"><div className="wheel">K</div><p>Raising the gangway…</p></main>;
  if (auth === 'signed-out') return <Login setupRequired={setupRequired} onLogin={signedIn} />;

  return (
    <>
      <a
        className="skip-link"
        href="#main-content"
        onClick={skipToMain}
        onKeyDown={(event) => { if (event.key === 'Enter') skipToMain(event); }}
      >Skip to main content</a>
      <main id="main-content" className="shell" tabIndex={-1}>
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
          <button className="text-button" onClick={() => { setOperationsTab('jobs'); setShowOperations(true); }}>Operations</button>
          <button className="text-button settings-button" onClick={() => setShowSettings(true)}>Settings</button>
          <button className="text-button" onClick={logout}>Sign out</button>
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow gold">THE *ARR CARGO DECK</p>
          <h2>Keep the treasure.<br />Toss the ballast.</h2>
          <p className="hero-copy">Review files over configured size limits and files not tracked by Radarr or Sonarr. Nothing changes without confirmation.</p>
        </div>
        <button className="primary-button scan-button" onClick={runScan} disabled={scanning}>
          <span aria-hidden="true" className={scanning ? 'spin' : ''}>↻</span>
          {scanning ? 'Scanning Radarr & Sonarr…' : 'Scan Radarr & Sonarr'}
        </button>
      </section>

      {(message || error) && <div className={`notice ${error ? 'error' : 'success'}`} role="status">{error || message}</div>}
      {scan?.warnings.map((warning) => <div className="notice warning" key={warning}>{warning}</div>)}

      <section className="stat-grid" aria-label="Scan summary">
        <article className="stat-card accent"><p>Files over size limits</p><strong>{scan?.oversized.length ?? '—'}</strong><span>{scan ? formatBytes(totalOversized) : 'Scan to inspect'}</span></article>
        <article className="stat-card"><p>Untracked files</p><strong>{scan?.orphans.length ?? '—'}</strong><span>{scan ? formatBytes(totalOrphans) : 'Not tracked by either app'}</span></article>
        <article className="stat-card"><p>Size rules</p><div className="dual-orders"><strong>{config?.radarr.maxMbPerMinute ?? '—'} <small>Radarr</small></strong><strong>{config?.sonarr.maxMbPerMinute ?? '—'} <small>Sonarr</small></strong></div><span>MB/min before per-app tolerance</span></article>
      </section>

      <section className="manifest" aria-labelledby="manifest-title">
        <div className="manifest-head">
          <div>
            <p className="eyebrow">SCAN RESULTS</p>
            <h3 id="manifest-title">{tab === 'oversized' ? 'Tracked files over configured size limits' : 'Files not tracked by Radarr or Sonarr'}</h3>
          </div>
          {selectedVisible.length > 0 && <button className="danger-button" disabled={scanning || applying} onClick={() => setConfirming(true)}>
            {tab === 'oversized' ? 'Remove & search again' : config?.orphanAction === 'permanent' ? 'Delete permanently' : 'Quarantine'} · {selectedVisible.length}
          </button>}
        </div>

        <div className="manifest-tools">
          <div className="tabs" role="tablist" aria-label="Scan result type">
            {manifestTabs.map((value) => <button
              key={value}
              id={`manifest-tab-${value}`}
              type="button"
              role="tab"
              aria-selected={tab === value}
              aria-controls={`manifest-panel-${value}`}
              tabIndex={tab === value ? 0 : -1}
              className={tab === value ? 'active' : ''}
              onClick={() => selectManifestTab(value)}
              onKeyDown={(event) => handleManifestTabKeyDown(event, value)}
            >
              {value === 'oversized' ? 'Size limits' : 'Untracked files'} <span>{value === 'oversized' ? scan?.oversized.length ?? 0 : scan?.orphans.length ?? 0}</span>
            </button>)}
          </div>
        </div>

        {manifestTabs.map((value) => <div
          key={value}
          id={`manifest-panel-${value}`}
          role="tabpanel"
          aria-labelledby={`manifest-tab-${value}`}
          tabIndex={0}
          hidden={tab !== value}
          className="manifest-panel"
        >
          {tab === value && <>
            {scan && <>
              <div className="result-tools">
                <div className="filters" role="group" aria-label="Filter by application">
                  {(['all', 'radarr', 'sonarr'] as const).map((filterValue) => <button type="button" key={filterValue} aria-pressed={filter === filterValue} className={filter === filterValue ? 'active' : ''} onClick={() => setFilter(filterValue)}>{filterValue === 'all' ? 'Both apps' : filterValue === 'radarr' ? 'Radarr' : 'Sonarr'}</button>)}
                </div>
              </div>
              <div className="manifest-filters">
                <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, quality or path" aria-label="Search scan results" />
                <label>Minimum {tab === 'oversized' ? 'overage' : 'size'}<span><input inputMode="decimal" value={minimumGib} onChange={(event) => setMinimumGib(event.target.value)} /> GiB</span></label>
                <label>Sort<select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="largest">Largest first</option>{tab === 'oversized' && <option value="overage">Most over limit</option>}<option value="title">Title</option>{tab === 'orphans' && <option value="oldest">Oldest first</option>}</select></label>
                <div className="batch-tools"><button type="button" onClick={() => selectFirst(25)} disabled={!visible.length}>Select first 25</button><button type="button" onClick={() => selectFirst(100)} disabled={!visible.length}>Select first 100</button>{tab === 'oversized' && <button type="button" onClick={excludeSelection} disabled={!selectedVisible.length || applying}>Exclude selected</button>}</div>
              </div>
            </>}

            {!scan ? (
              <div className="empty-state"><div aria-hidden="true">⌁</div><h4>No scan results yet</h4><p>Use “Scan Radarr & Sonarr” above to inspect files against the configured rules.</p></div>
            ) : source.length === 0 && scanHasNoConfiguredApps ? (
              <div className="empty-state"><div aria-hidden="true">!</div><h4>Scan incomplete</h4><p>Connect Radarr or Sonarr in Settings before treating this view as clear.</p><button type="button" className="ghost-button" onClick={() => setShowSettings(true)}>Open Settings</button></div>
            ) : source.length === 0 && scanIsIncomplete ? (
              <div className="empty-state"><div aria-hidden="true">!</div><h4>Scan incomplete</h4><p>No files were returned for this view. Review the connection errors or warnings above before treating it as clear.</p></div>
            ) : source.length === 0 ? (
              <div className="empty-state clear"><div aria-hidden="true">✓</div><h4>All clear</h4><p>No {tab === 'oversized' ? 'files exceed the configured size limits' : 'untracked files need attention'}.</p></div>
            ) : visible.length === 0 ? (
              <div className="empty-state"><div aria-hidden="true">⌕</div><h4>No matching files</h4><p>{source.length} file(s) are hidden by the current filters.</p><button type="button" className="ghost-button" onClick={clearFilters}>Clear filters</button></div>
            ) : tab === 'oversized' ? (
              <OversizedTable items={visible as OversizedItem[]} selected={selected} onToggle={toggle} onToggleAll={toggleAll} />
            ) : (
              <OrphanTable items={visible as OrphanItem[]} selected={selected} onToggle={toggle} onToggleAll={toggleAll} action={config?.orphanAction ?? 'quarantine'} />
            )}

            <p className="safety-note"><span aria-hidden="true">⚓</span>{tab === 'oversized' ? 'Tracked files are removed through Radarr or Sonarr, then searched again using that app’s existing profiles.' : config?.orphanAction === 'permanent' ? 'Permanent deletion is enabled. Selected files are revalidated immediately before deletion.' : 'Selected untracked files are revalidated immediately before moving to quarantine.'}</p>
          </>}
        </div>)}
      </section>

      <footer><span>Keelhaularr</span> · Library file changes require confirmation · Every file action is revalidated server-side</footer>
      <ConfirmDialog open={confirming} tab={tab} count={selectedVisible.length} action={config?.orphanAction ?? 'quarantine'} busy={applying} onCancel={() => setConfirming(false)} onConfirm={applySelection} />
      {showSettings && <SettingsDialog onboarding={!config?.radarr.configured && !config?.sonarr.configured} onClose={() => setShowSettings(false)} onSaved={settingsSaved} />}
      {showOperations && <OperationsDialog initialTab={operationsTab} onClose={() => setShowOperations(false)} onChanged={async () => { if (scan) await runScan(); }} onJobQueued={refreshWhenJobSettles} />}
      </main>
    </>
  );
}

function SelectAll({ items, selected, onToggleAll }: { items: Array<{ id: string }>; selected: Set<string>; onToggleAll: () => void }) {
  const checked = items.length > 0 && items.every((item) => selected.has(item.id));
  return <input type="checkbox" checked={checked} onChange={onToggleAll} aria-label="Select all visible files" />;
}

function OversizedTable({ items, selected, onToggle, onToggleAll }: { items: OversizedItem[]; selected: Set<string>; onToggle: (id: string) => void; onToggleAll: () => void }) {
  return <div className="table-wrap"><table><thead><tr><th><SelectAll items={items} selected={selected} onToggleAll={onToggleAll} /></th><th>Title</th><th>App</th><th>Actual size</th><th>Allowed</th><th>Over by</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className={selected.has(item.id) ? 'selected-row' : ''}><td><input type="checkbox" checked={selected.has(item.id)} onChange={() => onToggle(item.id)} aria-label={`Select ${item.title}`} /></td><td><div className="movie-title" title={item.title}>{item.title}</div><div className="quality-chip" title={item.subtitle}>{item.subtitle}</div><div className="path-line" title={item.path}>{item.path}</div></td><td><AppBadge app={item.app} /></td><td className="numeric">{formatBytes(item.sizeBytes)}</td><td><div className="numeric muted">{formatBytes(item.limitBytes)}</div><div className="limit-note">{formatBytes(item.configuredLimitBytes)} + {formatBytes(item.toleranceBytes)}</div></td><td><span className="excess-chip">+{formatBytes(item.overageBytes)}</span></td></tr>)}</tbody></table></div>;
}

function OrphanTable({ items, selected, onToggle, onToggleAll, action }: { items: OrphanItem[]; selected: Set<string>; onToggle: (id: string) => void; onToggleAll: () => void; action: string }) {
  return <div className="table-wrap"><table><thead><tr><th><SelectAll items={items} selected={selected} onToggleAll={onToggleAll} /></th><th>Untracked file</th><th>App</th><th>Size</th><th>Modified</th><th>Action</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className={selected.has(item.id) ? 'selected-row' : ''}><td><input type="checkbox" checked={selected.has(item.id)} onChange={() => onToggle(item.id)} aria-label={`Select ${item.title}`} /></td><td><div className="movie-title" title={item.title}>{item.title}</div><div className="quality-chip">{item.source === 'download' ? 'Broken hardlink' : 'Untracked library file'}</div><div className="path-line" title={item.path}>{item.path}</div></td><td><AppBadge app={item.app} /></td><td className="numeric">{formatBytes(item.sizeBytes)}</td><td className="muted date-cell">{new Date(item.modifiedAt).toLocaleDateString()}</td><td><span className={`action-chip ${action}`}>{action === 'permanent' ? 'Delete permanently' : 'Quarantine'}</span></td></tr>)}</tbody></table></div>;
}
