import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { ModalDialog } from './ModalDialog';
import { OperationsDialog } from './OperationsDialog';
import { SettingsDialog } from './SettingsDialog';

type AppKind = 'radarr' | 'sonarr';
type Tab = 'oversized' | 'orphans';
type OrphanAction = 'quarantine' | 'permanent';
type ConfirmationStage = 'closed' | 'choose' | 'permanent';
type ReplacementStatus = 'available' | 'none' | 'unsupported' | 'error';

interface ReplacementRelease {
  title: string;
  sizeBytes: number;
  quality: string | null;
}

interface ReplacementVerdict {
  id: string;
  status: ReplacementStatus;
  reason: string | null;
  inspected: number;
  compliantCount: number;
  multiEpisode: boolean;
  checkedAt: string;
  best: ReplacementRelease | null;
}
type ConnectionState = 'checking' | 'connected' | 'error' | 'not-configured';
const manifestTabs: Tab[] = ['oversized', 'orphans'];
const arrConnectionRecheckMs = 30_000;

interface ConnectionStatus {
  state: ConnectionState;
  error: string | null;
}

const emptyArrConnections = (): Record<AppKind, ConnectionStatus> => ({
  radarr: { state: 'not-configured', error: null },
  sonarr: { state: 'not-configured', error: null },
});

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
  hardlinkMinAgeHours: number;
  oversizeRequireReplacement: boolean;
  protected: boolean;
}

function pendingArrConnections(config: PublicConfig): Record<AppKind, ConnectionStatus> {
  return {
    radarr: { state: config.radarr.configured ? 'checking' : 'not-configured', error: null },
    sonarr: { state: config.sonarr.configured ? 'checking' : 'not-configured', error: null },
  };
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

type ManifestItem = OversizedItem | OrphanItem;

interface QBittorrentPathDetail {
  name: string | null;
  hash: string | null;
  hashPrefix: string | null;
  state: string | null;
  reason: 'metadata-pending' | 'missing-content-path' | 'unmappable-content-path';
  rawPath: string | null;
}

interface QBittorrentSafety {
  checked: boolean;
  metadataPendingCount: number;
  metadataPendingTorrents: QBittorrentPathDetail[];
  metadataPendingOmittedCount: number;
  unresolvedIncompleteCount: number;
  unresolvedIncompleteTorrents: QBittorrentPathDetail[];
  unresolvedIncompleteOmittedCount: number;
  detailLimit: number;
  warning: string | null;
}

interface IgnoreSummary {
  count: number;
  totalSizeBytes: number;
  unknownSizeCount: number;
  totalOverageBytes: number;
  unknownOverageCount: number;
}

const emptyIgnoreSummary = (): IgnoreSummary => ({
  count: 0,
  totalSizeBytes: 0,
  unknownSizeCount: 0,
  totalOverageBytes: 0,
  unknownOverageCount: 0,
});

function normalizeIgnoreSummary(summary?: IgnoreSummary): IgnoreSummary {
  if (!summary) return emptyIgnoreSummary();
  const count = Number.isFinite(summary.count) ? Math.max(0, Math.trunc(summary.count)) : 0;
  return {
    count,
    totalSizeBytes: Number.isFinite(summary.totalSizeBytes) ? Math.max(0, summary.totalSizeBytes) : 0,
    unknownSizeCount: Number.isFinite(summary.unknownSizeCount)
      ? Math.min(count, Math.max(0, Math.trunc(summary.unknownSizeCount)))
      : 0,
    totalOverageBytes: Number.isFinite(summary.totalOverageBytes) ? Math.max(0, summary.totalOverageBytes) : 0,
    unknownOverageCount: Number.isFinite(summary.unknownOverageCount)
      ? Math.min(count, Math.max(0, Math.trunc(summary.unknownOverageCount)))
      : 0,
  };
}

function ignoreOverageRefreshKey(summary: IgnoreSummary) {
  return [
    summary.count,
    summary.totalSizeBytes,
    summary.unknownSizeCount,
    summary.totalOverageBytes,
    summary.unknownOverageCount,
  ].join(':');
}

interface ScanData {
  scannedAt: string;
  config: PublicConfig;
  connections: Record<AppKind, { status: 'connected' | 'error' | 'not-configured'; version: string | null; error: string | null }>;
  oversized: OversizedItem[];
  orphans: OrphanItem[];
  roots: Array<{ app: AppKind; kind: 'library' | 'download'; path: string; filesScanned: number }>;
  qbittorrentSafety: QBittorrentSafety;
  ignoreSummary?: IgnoreSummary;
  warnings: string[];
}

class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
  });
  const data = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : `Request failed with HTTP ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return data as T;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const order = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** order).toFixed(order >= 3 ? 2 : 1)} ${units[order]}`;
}

const MIB = 1024 ** 2;

// Turns the raw numbers into a reading of WHY a file is oversized: how many times
// over its own limit it is, and the bitrate it actually uses versus what is allowed.
function oversizeDiagnosis(item: OversizedItem) {
  const parts: string[] = [];
  if (item.limitBytes > 0) parts.push(`${(item.sizeBytes / item.limitBytes).toFixed(1)}× its limit`);
  if (item.runtimeMinutes > 0 && item.maxMbPerMinute > 0) {
    const observed = Math.round(item.sizeBytes / item.runtimeMinutes / MIB);
    parts.push(`${observed} vs ${Math.round(item.maxMbPerMinute)} MB/min`);
  }
  return parts.join(' · ');
}

function limitSourceExplanation(item: OversizedItem) {
  const basis = item.limitSource === 'arr-quality-definition'
    ? `the ${item.app === 'radarr' ? 'Radarr' : 'Sonarr'} quality definition for this file`
    : item.limitSource === 'keelhaularr-fallback'
      ? 'the Keelhaularr fallback, because no matching quality definition was found'
      : 'your configured MB/min';
  return `${Math.round(item.maxMbPerMinute)} MB/min from ${basis}, × ${item.runtimeMinutes} min runtime, + ${formatBytes(item.toleranceBytes)} tolerance.`;
}

function formatGib(bytes: number) {
  const gib = bytes / 1024 ** 3;
  return `${gib > 0 && gib < 0.01 ? '<0.01' : gib.toFixed(2)} GiB`;
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

function ConnectionPill({ name, state, error }: {
  name: string;
  state: ConnectionState;
  error?: string | null;
}) {
  const label = state === 'connected'
    ? 'Connected'
    : state === 'error'
      ? 'Not connected'
      : state === 'checking'
        ? 'Checking'
        : 'Not set';
  return (
    <div className={`status-pill ${state}`} title={error ?? undefined}>
      <span aria-hidden="true" /><strong>{name}</strong><em>{label}</em>
    </div>
  );
}

function QBittorrentTorrentList({ items, omittedCount }: { items: QBittorrentPathDetail[]; omittedCount: number }) {
  const reasonLabel = (reason: QBittorrentPathDetail['reason']) => reason === 'metadata-pending'
    ? 'Fetching metadata; no content path yet'
    : reason === 'missing-content-path'
      ? 'No content path reported'
      : 'Content path does not match a safe mapping';
  return (
    <div className="qb-safety-details">
      <ul>
        {items.map((item, index) => (
          <li key={`${item.hash ?? item.name ?? 'torrent'}-${index}`}>
            <strong>{item.name ?? 'Unnamed torrent'}</strong>
            <span>
              {item.hashPrefix ? <code title={item.hash ?? undefined}>{item.hashPrefix}</code> : 'No hash reported'}
              {' · '}{item.state ? <code>{item.state}</code> : 'Unknown state'}
              {' · '}{reasonLabel(item.reason)}
            </span>
            {item.rawPath && <code className="qb-raw-path">{item.rawPath}</code>}
          </li>
        ))}
      </ul>
      {omittedCount > 0 && <p>{omittedCount} additional torrent{omittedCount === 1 ? '' : 's'} omitted from this bounded detail list.</p>}
    </div>
  );
}

function QBittorrentSafetyNotices({ safety }: { safety: QBittorrentSafety }) {
  return (
    <>
      {safety.metadataPendingCount > 0 && (
        <details className="notice info qb-safety-notice">
          <summary>
            {safety.metadataPendingCount} qBittorrent torrent{safety.metadataPendingCount === 1 ? ' is' : 's are'} fetching metadata
          </summary>
          <p>These torrents do not have content paths yet, so they did not block this scan. Keelhaularr checks qBittorrent again immediately before changing a download file.</p>
          <QBittorrentTorrentList items={safety.metadataPendingTorrents} omittedCount={safety.metadataPendingOmittedCount} />
        </details>
      )}
      {safety.unresolvedIncompleteCount > 0 && (
        <details className="notice warning qb-safety-notice">
          <summary>
            {safety.unresolvedIncompleteCount} incomplete qBittorrent torrent path{safety.unresolvedIncompleteCount === 1 ? '' : 's'} could not be resolved
          </summary>
          <p>Completed-download folders were skipped to protect active downloads; this qBittorrent issue did not block library-folder scanning. Check Settings → Connections → qBittorrent → Path mapping.</p>
          <QBittorrentTorrentList items={safety.unresolvedIncompleteTorrents} omittedCount={safety.unresolvedIncompleteOmittedCount} />
        </details>
      )}
    </>
  );
}

function ReplacementChip({ verdict, checking }: { verdict?: ReplacementVerdict; checking: boolean }) {
  if (checking) return <span className="replacement-chip pending">Checking indexers…</span>;
  if (!verdict) return <span className="replacement-chip unknown">Replacement not checked</span>;
  if (verdict.status === 'available' && verdict.best) {
    return (
      <span
        className="replacement-chip available"
        title={`${verdict.best.title}${verdict.best.quality ? ` · ${verdict.best.quality}` : ''}`}
      >
        Replacement · {formatBytes(verdict.best.sizeBytes)}
      </span>
    );
  }
  if (verdict.status === 'none') {
    return <span className="replacement-chip none" title={verdict.reason ?? undefined}>No compliant replacement</span>;
  }
  return (
    <span className="replacement-chip error" title={verdict.reason ?? undefined}>
      {verdict.status === 'unsupported' ? 'Replacement cannot be judged' : 'Replacement check failed'}
    </span>
  );
}

function ConfirmDialog({ stage, tab, count, busy, replacementSummary, requireReplacement, onCancel, onQuarantine, onChoosePermanent, onConfirmPermanent }: {
  stage: ConfirmationStage;
  tab: Tab;
  count: number;
  busy: boolean;
  onCancel: () => void;
  replacementSummary: { checked: number; available: number } | null;
  requireReplacement: boolean;
  onQuarantine: () => void;
  onChoosePermanent: () => void;
  onConfirmPermanent: () => void;
}) {
  const oversized = tab === 'oversized';
  const finalPermanentConfirmation = stage === 'permanent';
  const unavailable = replacementSummary ? replacementSummary.checked - replacementSummary.available : 0;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (stage === 'closed') return;
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [stage]);

  return (
    <ModalDialog
      open={stage !== 'closed'}
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
        <p className="eyebrow coral">{finalPermanentConfirmation ? 'FINAL DELETION CONFIRMATION' : oversized ? 'OVERSIZED-FILE HANDLING' : 'UNTRACKED-FILE HANDLING'}</p>
        <h2 id="confirm-title">
          {finalPermanentConfirmation
            ? oversized
              ? 'Permanently delete the selected tracked files?'
              : 'Permanently delete the selected untracked files?'
            : oversized
              ? 'How should these oversized files be handled?'
              : 'How should these untracked files be handled?'}
        </h2>
        <p id="confirm-description">
          {finalPermanentConfirmation
            ? oversized
              ? `${count} tracked file(s) will be removed through their *arr app and are NOT recoverable from the Brig. A replacement search is still requested.`
              : `${count} untracked file(s) will be permanently removed from disk. This cannot be undone.`
            : oversized
              ? `${count} tracked file(s) can be moved to the recoverable Brig or removed permanently. Either way a replacement search is requested afterwards.`
              : `${count} untracked file(s) can be moved to recoverable quarantine or deleted permanently.`}
        </p>
        {oversized && replacementSummary && (
          <p className={`confirm-note ${unavailable > 0 ? 'warn' : 'ok'}`}>
            {unavailable > 0
              ? `${unavailable} of ${replacementSummary.checked} checked file(s) have no compliant replacement available right now.`
              : `All ${replacementSummary.checked} checked file(s) have a compliant replacement available.`}
          </p>
        )}
        {oversized && requireReplacement && (
          <p className="confirm-note ok">
            Each file is re-checked for a compliant replacement immediately before it is removed. Any file without one is preserved.
          </p>
        )}
        <div className={`dialog-actions ${!finalPermanentConfirmation ? 'orphan-choice-actions' : ''}`}>
          <button ref={cancelRef} type="button" className="ghost-button" onClick={() => dialogRef.current?.close()} disabled={busy}>CANCEL</button>
          {finalPermanentConfirmation ? (
            <button type="button" className="danger-button" onClick={onConfirmPermanent} disabled={busy}>
              {busy ? 'DELETING…' : 'DELETE PERMANENTLY'}
            </button>
          ) : <>
            <button type="button" className="primary-button" onClick={onQuarantine} disabled={busy}>
              {busy ? 'QUARANTINING…' : 'QUARANTINE'}
            </button>
            <button type="button" className="danger-button" onClick={onChoosePermanent} disabled={busy}>DELETE PERMANENTLY</button>
          </>}
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
  const [ignoreSummary, setIgnoreSummary] = useState<IgnoreSummary>(emptyIgnoreSummary);
  const [ignoreOverageRefreshState, setIgnoreOverageRefreshState] = useState<'idle' | 'refreshing' | 'settled'>('idle');
  const [tab, setTab] = useState<Tab>('oversized');
  const [filter, setFilter] = useState<'all' | AppKind>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmationStage, setConfirmationStage] = useState<ConfirmationStage>('closed');
  const [replacements, setReplacements] = useState<Record<string, ReplacementVerdict>>({});
  const [checkingReplacements, setCheckingReplacements] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showOperations, setShowOperations] = useState(false);
  const [operationsTab, setOperationsTab] = useState<'jobs' | 'brig' | 'storage' | 'exclusions' | 'schedule'>('jobs');
  const [jobsAwaitingRefresh, setJobsAwaitingRefresh] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [minimumGib, setMinimumGib] = useState('0');
  const [sort, setSort] = useState<'largest' | 'overage' | 'title' | 'oldest'>('largest');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [arrConnections, setArrConnections] = useState<Record<AppKind, ConnectionStatus>>(emptyArrConnections);
  const [qbittorrentConnection, setQbittorrentConnection] = useState<{
    state: ConnectionState;
    error: string | null;
  }>({ state: 'not-configured', error: null });
  const [arrConnectionProbeRevision, setArrConnectionProbeRevision] = useState(0);
  const [qbittorrentProbeRevision, setQbittorrentProbeRevision] = useState(0);
  const scanRequestId = useRef(0);
  const arrConnectionsRequestId = useRef(0);
  const qbittorrentRequestId = useRef(0);
  const showArrConnectionChecking = useRef(true);
  const lastAutomaticArrProbeAt = useRef(0);
  const attemptedIgnoreOverageRefreshes = useRef(new Set<string>());
  const pendingIgnoreOverageRefreshes = useRef(new Set<string>());
  const ignoreOverageRefreshSession = useRef(0);

  useEffect(() => {
    api<{ authenticated: boolean; setupRequired: boolean }>('/api/auth/status')
      .then(async (status) => {
        setSetupRequired(status.setupRequired);
        if (!status.authenticated) {
          setAuth('signed-out');
          return;
        }
        const statusData = await api<{ config: PublicConfig; ignoreSummary?: IgnoreSummary }>('/api/status');
        setConfig(statusData.config);
        setIgnoreSummary(normalizeIgnoreSummary(statusData.ignoreSummary));
        setArrConnections(pendingArrConnections(statusData.config));
        if (!statusData.config.radarr.configured && !statusData.config.sonarr.configured) setShowSettings(true);
        setAuth('signed-in');
      })
      .catch((authError) => {
        setError(authError instanceof Error ? authError.message : String(authError));
        setAuth('signed-out');
      });
  }, []);

  useEffect(() => {
    if (auth !== 'signed-in') {
      attemptedIgnoreOverageRefreshes.current.clear();
      pendingIgnoreOverageRefreshes.current.clear();
      ignoreOverageRefreshSession.current += 1;
      setIgnoreOverageRefreshState('idle');
      return;
    }
    if (ignoreSummary.unknownOverageCount === 0) {
      setIgnoreOverageRefreshState('idle');
      return;
    }

    const stateKey = ignoreOverageRefreshKey(ignoreSummary);
    if (attemptedIgnoreOverageRefreshes.current.has(stateKey)) {
      setIgnoreOverageRefreshState(pendingIgnoreOverageRefreshes.current.has(stateKey) ? 'refreshing' : 'settled');
      return;
    }

    attemptedIgnoreOverageRefreshes.current.add(stateKey);
    pendingIgnoreOverageRefreshes.current.add(stateKey);
    const session = ignoreOverageRefreshSession.current;
    setIgnoreOverageRefreshState('refreshing');
    void api<{ ignoreSummary?: IgnoreSummary }>('/api/exclusions/refresh', {
      method: 'POST',
      body: '{}',
    }).then((result) => {
      if (session !== ignoreOverageRefreshSession.current) return;
      pendingIgnoreOverageRefreshes.current.delete(stateKey);
      const refreshedSummary = normalizeIgnoreSummary(result.ignoreSummary);
      attemptedIgnoreOverageRefreshes.current.add(ignoreOverageRefreshKey(refreshedSummary));
      setIgnoreSummary(refreshedSummary);
      setIgnoreOverageRefreshState(refreshedSummary.unknownOverageCount > 0 ? 'settled' : 'idle');
    }).catch((refreshError) => {
      if (session !== ignoreOverageRefreshSession.current) return;
      pendingIgnoreOverageRefreshes.current.delete(stateKey);
      if (refreshError instanceof ApiError && refreshError.status === 401) {
        setAuth('signed-out');
        setConfig(null);
        setScan(null);
        return;
      }
      // The summary remains usable, but must continue to identify unresolved overages honestly.
      setIgnoreOverageRefreshState('settled');
    });
  }, [auth, ignoreSummary]);

  useEffect(() => {
    const requestId = ++arrConnectionsRequestId.current;
    if (auth !== 'signed-in' || !config) {
      showArrConnectionChecking.current = true;
      setArrConnections(emptyArrConnections());
      return;
    }

    const configured = {
      radarr: config.radarr.configured,
      sonarr: config.sonarr.configured,
    };
    const shouldShowChecking = showArrConnectionChecking.current;
    showArrConnectionChecking.current = true;
    if (shouldShowChecking) setArrConnections(pendingArrConnections(config));
    if (!configured.radarr && !configured.sonarr) return;

    const controller = new AbortController();
    api<{
      connections: Record<AppKind, {
        status: 'connected' | 'error' | 'not-configured';
        version: string | null;
        error: string | null;
      }>;
    }>('/api/connections/status', { signal: controller.signal })
      .then(({ connections }) => {
        if (requestId !== arrConnectionsRequestId.current) return;
        setArrConnections({
          radarr: { state: connections.radarr.status, error: connections.radarr.error },
          sonarr: { state: connections.sonarr.status, error: connections.sonarr.error },
        });
      })
      .catch((connectionError) => {
        if (controller.signal.aborted || requestId !== arrConnectionsRequestId.current) return;
        if (connectionError instanceof ApiError && connectionError.status === 401) {
          setAuth('signed-out');
          setConfig(null);
          setScan(null);
          return;
        }
        const connectionErrorMessage = connectionError instanceof Error
          ? connectionError.message
          : String(connectionError);
        setArrConnections({
          radarr: {
            state: configured.radarr ? 'error' : 'not-configured',
            error: configured.radarr ? connectionErrorMessage : null,
          },
          sonarr: {
            state: configured.sonarr ? 'error' : 'not-configured',
            error: configured.sonarr ? connectionErrorMessage : null,
          },
        });
      });

    return () => controller.abort();
  }, [auth, config?.radarr.configured, config?.sonarr.configured, arrConnectionProbeRevision]);

  useEffect(() => {
    if (auth !== 'signed-in' || !config
      || (!config.radarr.configured && !config.sonarr.configured)) return;

    function requestAutomaticProbe() {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastAutomaticArrProbeAt.current < 1_000) return;
      lastAutomaticArrProbeAt.current = now;
      showArrConnectionChecking.current = false;
      setArrConnectionProbeRevision((current) => current + 1);
    }

    const interval = window.setInterval(requestAutomaticProbe, arrConnectionRecheckMs);
    window.addEventListener('focus', requestAutomaticProbe);
    document.addEventListener('visibilitychange', requestAutomaticProbe);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', requestAutomaticProbe);
      document.removeEventListener('visibilitychange', requestAutomaticProbe);
    };
  }, [auth, config?.radarr.configured, config?.sonarr.configured]);

  useEffect(() => {
    const requestId = ++qbittorrentRequestId.current;
    if (auth !== 'signed-in' || !config?.qbittorrent.configured) {
      setQbittorrentConnection({ state: 'not-configured', error: null });
      return;
    }

    const controller = new AbortController();
    setQbittorrentConnection({ state: 'checking', error: null });
    api<{
      status: 'connected';
      version: string | null;
      totalTorrentCount: number;
      incompleteTorrentCount: number;
      metadataPendingCount: number;
      unresolvedIncompleteCount: number;
    }>('/api/qbittorrent/status', { signal: controller.signal })
      .then(() => {
        if (requestId === qbittorrentRequestId.current) {
          setQbittorrentConnection({ state: 'connected', error: null });
        }
      })
      .catch((connectionError) => {
        if (controller.signal.aborted || requestId !== qbittorrentRequestId.current) return;
        if (connectionError instanceof ApiError && connectionError.status === 401) {
          setAuth('signed-out');
          setConfig(null);
          setScan(null);
          return;
        }
        setQbittorrentConnection({
          state: 'error',
          error: connectionError instanceof Error ? connectionError.message : String(connectionError),
        });
      });

    return () => controller.abort();
  }, [auth, config, qbittorrentProbeRevision]);

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
  const ignoredFilesLabel = `${ignoreSummary.count} file${ignoreSummary.count === 1 ? '' : 's'}`;
  const ignoredSizeLabel = formatGib(ignoreSummary.totalSizeBytes);
  const ignoredOverageLabel = formatGib(ignoreSummary.totalOverageBytes);
  const unknownSizeText = ignoreSummary.unknownSizeCount > 0
    ? ` · ${ignoreSummary.unknownSizeCount} size${ignoreSummary.unknownSizeCount === 1 ? '' : 's'} unknown`
    : '';
  const ignoreSummarySizeText = `${ignoredFilesLabel} · ${ignoredSizeLabel}${ignoreSummary.unknownSizeCount > 0 ? ' known' : ' total'}${unknownSizeText}`;
  const ignoreSummaryOverageText = ignoreOverageRefreshState === 'refreshing'
    ? 'Calculating overage…'
    : ignoreSummary.unknownOverageCount > 0
      ? ignoreSummary.totalOverageBytes > 0
        ? `At least ${ignoredOverageLabel} over limit · ${ignoreSummary.unknownOverageCount} pending`
        : `Overage unavailable for ${ignoreSummary.unknownOverageCount} file${ignoreSummary.unknownOverageCount === 1 ? '' : 's'}`
      : `${ignoredOverageLabel} over limit`;
  const ignoreSummaryAccessibleLabel = [
    `Ignore list: ${ignoredFilesLabel}.`,
    ignoreSummary.unknownSizeCount > 0
      ? `${ignoredSizeLabel} across files with known sizes; ${ignoreSummary.unknownSizeCount} file${ignoreSummary.unknownSizeCount === 1 ? '' : 's'} with unknown size.`
      : `${ignoredSizeLabel} total.`,
    ignoreOverageRefreshState === 'refreshing'
      ? 'Calculating overage against configured size limits.'
      : ignoreSummary.unknownOverageCount > 0
        ? ignoreSummary.totalOverageBytes > 0
          ? `At least ${ignoredOverageLabel} over configured size limits; ${ignoreSummary.unknownOverageCount} ignored size-limit file${ignoreSummary.unknownOverageCount === 1 ? '' : 's'} still have unavailable overage values.`
          : `Overage is unavailable for ${ignoreSummary.unknownOverageCount} ignored size-limit file${ignoreSummary.unknownOverageCount === 1 ? '' : 's'}.`
        : `${ignoredOverageLabel} over configured size limits across ignored size-limit files; untracked files are not included in this overage.`,
  ].filter(Boolean).join(' ');

  async function signedIn() {
    const statusData = await api<{ config: PublicConfig; ignoreSummary?: IgnoreSummary }>('/api/status');
    setConfig(statusData.config);
    setIgnoreSummary(normalizeIgnoreSummary(statusData.ignoreSummary));
    setArrConnections(pendingArrConnections(statusData.config));
    if (!statusData.config.radarr.configured && !statusData.config.sonarr.configured) setShowSettings(true);
    setAuth('signed-in');
  }

  async function logout() {
    scanRequestId.current += 1;
    arrConnectionsRequestId.current += 1;
    qbittorrentRequestId.current += 1;
    setScanning(false);
    setJobsAwaitingRefresh([]);
    await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
    scanRequestId.current += 1;
    setScanning(false);
    setAuth('signed-out');
    setScan(null);
    setConfig(null);
    setIgnoreSummary(emptyIgnoreSummary());
    setArrConnections(emptyArrConnections());
  }

  async function settingsSaved() {
    scanRequestId.current += 1;
    attemptedIgnoreOverageRefreshes.current.clear();
    pendingIgnoreOverageRefreshes.current.clear();
    ignoreOverageRefreshSession.current += 1;
    setIgnoreOverageRefreshState('idle');
    setScanning(false);
    const statusData = await api<{ config: PublicConfig; ignoreSummary?: IgnoreSummary }>('/api/status');
    setConfig(statusData.config);
    setIgnoreSummary(normalizeIgnoreSummary(statusData.ignoreSummary));
    setArrConnections(pendingArrConnections(statusData.config));
    setArrConnectionProbeRevision((current) => current + 1);
    setScan(null);
    setSelected(new Set());
    setMessage('Standing orders changed. Run a fresh scan when ready.');
    setError('');
  }

  function connectionTested(app: AppKind | 'qbittorrent') {
    if (app === 'qbittorrent') {
      setQbittorrentProbeRevision((current) => current + 1);
      return;
    }
    showArrConnectionChecking.current = false;
    setArrConnectionProbeRevision((current) => current + 1);
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
      setIgnoreSummary(normalizeIgnoreSummary(data.ignoreSummary));
      arrConnectionsRequestId.current += 1;
      setArrConnections({
        radarr: { state: data.connections.radarr.status, error: data.connections.radarr.error },
        sonarr: { state: data.connections.sonarr.status, error: data.connections.sonarr.error },
      });
      setSelected(new Set());
      setMessage(`Manifest refreshed at ${new Date(data.scannedAt).toLocaleTimeString()}.`);
      return true;
    } catch (scanError) {
      if (requestId !== scanRequestId.current) return false;
      if (scanError instanceof ApiError && scanError.status === 401) {
        setAuth('signed-out');
        setConfig(null);
        setScan(null);
        return false;
      }
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

  // Predicate-based selection. "first N" keeps whatever order the user sorted by;
  // the multiplier and wasted-space options pick by the numbers instead, which is
  // what you actually want when hunting for space.
  function applyQuickSelect(kind: string) {
    if (!kind) return;
    const wasted = (item: ManifestItem) => (
      tab === 'oversized' ? (item as OversizedItem).overageBytes : item.sizeBytes
    );
    let chosen: ManifestItem[] = [];
    if (kind === 'shown') chosen = visible;
    else if (kind === 'first25') chosen = visible.slice(0, 25);
    else if (kind === 'first100') chosen = visible.slice(0, 100);
    else if (kind === 'x2' || kind === 'x3') {
      const factor = kind === 'x2' ? 2 : 3;
      chosen = visible.filter((item) => {
        const oversizedItem = item as OversizedItem;
        return oversizedItem.limitBytes > 0 && oversizedItem.sizeBytes >= oversizedItem.limitBytes * factor;
      });
    } else if (kind === 'top10' || kind === 'top25') {
      const count = kind === 'top10' ? 10 : 25;
      chosen = [...visible].sort((left, right) => wasted(right) - wasted(left)).slice(0, count);
    }
    setSelected(new Set(chosen.map((item) => item.id)));
    if (!chosen.length) setMessage('No files in the current view matched that selection.');
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

  async function operationsChanged() {
    const statusData = await api<{ ignoreSummary?: IgnoreSummary }>('/api/status');
    setIgnoreSummary(normalizeIgnoreSummary(statusData.ignoreSummary));
    if (scan) await runScan();
  }

  // Interactive search hits live indexers, so this is always an explicit user action
  // and never fired automatically on scan.
  const REPLACEMENT_CHECK_LIMIT = 50;

  async function checkReplacements() {
    const batch = selectedVisible.slice(0, REPLACEMENT_CHECK_LIMIT).map((item) => item.id);
    if (!batch.length) return;
    setError('');
    setCheckingReplacements(batch);
    try {
      const result = await api<{ replacements: ReplacementVerdict[] }>('/api/oversized/replacements', {
        method: 'POST',
        body: JSON.stringify({ ids: batch }),
      });
      setReplacements((current) => {
        const next = { ...current };
        for (const verdict of result.replacements) next[verdict.id] = verdict;
        return next;
      });
      if (selectedVisible.length > REPLACEMENT_CHECK_LIMIT) {
        setMessage(`Checked the first ${REPLACEMENT_CHECK_LIMIT} of ${selectedVisible.length} selected files. Interactive search queries live indexers, so it runs in batches.`);
      }
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : String(checkError));
    } finally {
      setCheckingReplacements([]);
    }
  }

  const replacementSummary = useMemo(() => {
    if (tab !== 'oversized') return null;
    const checked = selectedVisible.filter((item) => replacements[item.id]);
    if (!checked.length) return null;
    return {
      checked: checked.length,
      available: checked.filter((item) => replacements[item.id].status === 'available').length,
    };
  }, [replacements, selectedVisible, tab]);

  async function ignoreSelection() {
    if (!selectedVisible.length) return;
    const ignoredCount = selectedVisible.length;
    setApplying(true);
    setError('');
    try {
      const result = await api<{ ignoreSummary?: IgnoreSummary }>('/api/exclusions', {
        method: 'POST',
        body: JSON.stringify({
          ids: selectedVisible.map((item) => item.id),
          scope: tab === 'orphans' ? 'orphan' : 'oversized',
        }),
      });
      setIgnoreSummary(normalizeIgnoreSummary(result.ignoreSummary));
      if (await runScan()) {
        setMessage(`${ignoredCount} file${ignoredCount === 1 ? '' : 's'} added to the ignore list. Manage or remove ignored files in Operations → Ignore list.`);
      }
    } catch (ignoreError) {
      setError(ignoreError instanceof Error ? ignoreError.message : String(ignoreError));
    } finally {
      setApplying(false);
    }
  }

  async function applySelection(orphanAction?: OrphanAction) {
    if (!orphanAction) return;
    setApplying(true);
    setError('');
    try {
      const endpoint = tab === 'oversized' ? '/api/oversized/apply' : '/api/orphans/apply';
      const result = await api<{ job: { id: string; title: string } }>(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          ids: selectedVisible.map((item) => item.id),
          action: orphanAction,
          confirmPermanent: orphanAction === 'permanent',
        }),
      });
      refreshWhenJobSettles(result.job.id);
      setMessage(`${result.job.title} started. Progress is saved and can be followed in Operations → Jobs.`);
      setConfirmationStage('closed');
      setSelected(new Set());
      setReplacements({});
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
            <ConnectionPill
              name="Radarr"
              state={arrConnections.radarr.state}
              error={arrConnections.radarr.error}
            />
            <ConnectionPill
              name="Sonarr"
              state={arrConnections.sonarr.state}
              error={arrConnections.sonarr.error}
            />
            <ConnectionPill name="qBittorrent" state={qbittorrentConnection.state} error={qbittorrentConnection.error} />
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
      {qbittorrentConnection.state === 'error' && qbittorrentConnection.error && (
        <div className="notice warning qb-connection-warning" role="alert">
          <div>
            <strong>qBittorrent is not connected.</strong>
            <span>{qbittorrentConnection.error} Open Settings → Connections → qBittorrent and test the connection.</span>
          </div>
          <button type="button" className="ghost-button compact" onClick={() => setShowSettings(true)}>Open Settings</button>
        </div>
      )}
      {scan?.warnings.filter((warning) => warning !== scan.qbittorrentSafety.warning).map((warning) => <div className="notice warning" key={warning}>{warning}</div>)}
      {scan && <QBittorrentSafetyNotices safety={scan.qbittorrentSafety} />}

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
          {selectedVisible.length > 0 && <button className="danger-button" disabled={scanning || applying} onClick={() => setConfirmationStage('choose')}>
            Handle selected · {selectedVisible.length}
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
          <button
            type="button"
            className="ghost-button compact ignore-list-summary-button"
            aria-label={ignoreSummaryAccessibleLabel}
            title={ignoreSummaryAccessibleLabel}
            onClick={() => { setOperationsTab('exclusions'); setShowOperations(true); }}
          >
            <span className="ignore-list-summary-title">Ignore list</span>
            <span className="ignore-list-summary-metrics" aria-hidden="true">
              <small>{ignoreSummarySizeText}</small>
              <small>{ignoreSummaryOverageText}</small>
            </span>
          </button>
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
                <div className="batch-tools"><label className="quick-select"><span className="sr-only">Quick select</span><select aria-label="Quick select" value="" disabled={!visible.length} onChange={(event) => { applyQuickSelect(event.target.value); event.currentTarget.value = ''; }}><option value="">Quick select…</option><option value="shown">Everything shown ({visible.length})</option>{tab === 'oversized' && <option value="x2">At least 2× its limit</option>}{tab === 'oversized' && <option value="x3">At least 3× its limit</option>}<option value="top10">Top 10 by wasted space</option><option value="top25">Top 25 by wasted space</option><option value="first25">First 25 in this order</option><option value="first100">First 100 in this order</option></select></label><button type="button" onClick={ignoreSelection} disabled={!selectedVisible.length || applying}>{applying ? 'Working…' : 'Ignore selected'}</button>{tab === 'oversized' && <button type="button" onClick={() => { void checkReplacements(); }} disabled={!selectedVisible.length || applying || checkingReplacements.length > 0} title="Ask Radarr/Sonarr whether a release exists that fits your size limit. Nothing is deleted.">{checkingReplacements.length ? 'Checking indexers…' : 'Check replacements'}</button>}</div>
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
              <OversizedTable items={visible as OversizedItem[]} selected={selected} onToggle={toggle} onToggleAll={toggleAll} replacements={replacements} checking={checkingReplacements} />
            ) : (
              <OrphanTable items={visible as OrphanItem[]} selected={selected} onToggle={toggle} onToggleAll={toggleAll} />
            )}

            <p className="safety-note"><span aria-hidden="true">⚓</span>{tab === 'oversized' ? 'Remove tracked files through Radarr or Sonarr and search again, or ignore them in future size-limit scans. Remove an item from Operations → Ignore list to include it again.' : 'Quarantine or permanently delete selected files, or ignore their paths in future untracked-file scans. Remove a path from Operations → Ignore list to include it again.'}</p>
          </>}
        </div>)}
      </section>

      <footer><span>Keelhaularr</span> · Library file changes require confirmation · Every file action is revalidated server-side</footer>
      <ConfirmDialog
        stage={confirmationStage}
        tab={tab}
        count={selectedVisible.length}
        busy={applying}
        replacementSummary={replacementSummary}
        requireReplacement={Boolean(config?.oversizeRequireReplacement)}
        onCancel={() => setConfirmationStage('closed')}
        onQuarantine={() => { void applySelection('quarantine'); }}
        onChoosePermanent={() => setConfirmationStage('permanent')}
        onConfirmPermanent={() => { void applySelection('permanent'); }}
      />
      {showSettings && <SettingsDialog onboarding={!config?.radarr.configured && !config?.sonarr.configured} onClose={() => setShowSettings(false)} onSaved={settingsSaved} onConnectionTested={connectionTested} />}
      {showOperations && <OperationsDialog initialTab={operationsTab} onClose={() => setShowOperations(false)} onChanged={operationsChanged} onJobQueued={refreshWhenJobSettles} />}
      </main>
    </>
  );
}

function SelectAll({ items, selected, onToggleAll }: { items: Array<{ id: string }>; selected: Set<string>; onToggleAll: () => void }) {
  const checked = items.length > 0 && items.every((item) => selected.has(item.id));
  return <input type="checkbox" checked={checked} onChange={onToggleAll} aria-label="Select all visible files" />;
}

function OversizedTable({ items, selected, onToggle, onToggleAll, replacements, checking }: { items: OversizedItem[]; selected: Set<string>; onToggle: (id: string) => void; onToggleAll: () => void; replacements: Record<string, ReplacementVerdict>; checking: string[] }) {
  const checkingIds = new Set(checking);
  return <div className="table-wrap"><table className="manifest-table"><thead><tr><th><SelectAll items={items} selected={selected} onToggleAll={onToggleAll} /></th><th>Title</th><th>App</th><th>Actual size</th><th>Allowed</th><th>Over by</th><th>Replacement</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className={selected.has(item.id) ? 'selected-row' : ''}><td className="cell-select"><input type="checkbox" checked={selected.has(item.id)} onChange={() => onToggle(item.id)} aria-label={`Select ${item.title}`} /></td><td data-label="Title"><div className="movie-title" title={item.title}>{item.title}</div><div className="quality-chip" title={item.subtitle}>{item.subtitle}</div><div className="path-line" title={item.path}>{item.path}</div></td><td data-label="App"><AppBadge app={item.app} /></td><td className="numeric" data-label="Actual size">{formatBytes(item.sizeBytes)}</td><td data-label="Allowed" title={limitSourceExplanation(item)}><div className="numeric muted">{formatBytes(item.limitBytes)}</div><div className="limit-note">{formatBytes(item.configuredLimitBytes)} + {formatBytes(item.toleranceBytes)}</div></td><td data-label="Over by"><span className="excess-chip">+{formatBytes(item.overageBytes)}</span><div className="diagnosis-line" title={limitSourceExplanation(item)}>{oversizeDiagnosis(item)}</div></td><td data-label="Replacement"><ReplacementChip verdict={replacements[item.id]} checking={checkingIds.has(item.id)} /></td></tr>)}</tbody></table></div>;
}

function OrphanTable({ items, selected, onToggle, onToggleAll }: { items: OrphanItem[]; selected: Set<string>; onToggle: (id: string) => void; onToggleAll: () => void }) {
  return <div className="table-wrap"><table className="manifest-table"><thead><tr><th><SelectAll items={items} selected={selected} onToggleAll={onToggleAll} /></th><th>Untracked file</th><th>App</th><th>Size</th><th>Modified</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className={selected.has(item.id) ? 'selected-row' : ''}><td className="cell-select"><input type="checkbox" checked={selected.has(item.id)} onChange={() => onToggle(item.id)} aria-label={`Select ${item.title}`} /></td><td data-label="Untracked file"><div className="movie-title" title={item.title}>{item.title}</div><div className="quality-chip">{item.source === 'download' ? 'Broken hardlink' : 'Untracked library file'}</div><div className="path-line" title={item.path}>{item.path}</div></td><td data-label="App"><AppBadge app={item.app} /></td><td className="numeric" data-label="Size">{formatBytes(item.sizeBytes)}</td><td className="muted date-cell" data-label="Modified">{new Date(item.modifiedAt).toLocaleDateString()}</td></tr>)}</tbody></table></div>;
}
