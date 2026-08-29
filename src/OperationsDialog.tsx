import { useCallback, useEffect, useRef, useState } from 'react';
import { ModalDialog } from './ModalDialog';

type OpsTab = 'jobs' | 'brig' | 'storage' | 'exclusions' | 'schedule';

const opsTabs: OpsTab[] = ['jobs', 'brig', 'storage', 'exclusions', 'schedule'];
const opsTabLabels: Record<OpsTab, string> = {
  jobs: 'Jobs',
  brig: 'Quarantine',
  storage: 'Storage health',
  exclusions: 'Exclusions',
  schedule: 'Maintenance',
};
const activeJobStatuses = new Set(['queued', 'running', 'cancelling']);
const jobStatusLabels: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  cancelling: 'Cancelling',
  completed: 'Completed',
  completed_with_errors: 'Completed with errors',
  cancelled: 'Cancelled',
};
const itemStatusLabels: Record<string, string> = {
  waiting: 'Waiting',
  deleting: 'Removing',
  deleted: 'Removed',
  processing: 'Processing',
  removed: 'Removed',
  searching: 'Requesting search',
  complete: 'Cleanup complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};
const itemPhaseLabels: Record<string, string> = {
  waiting: 'Waiting',
  deleting: 'Removing tracked file',
  deleted: 'Tracked file removed',
  processing: 'Processing untracked file',
  quarantined: 'Moved to quarantine',
  delete_requested: 'Removal requested',
  arr_removed: 'Removed and blocklisted',
  removed_confirmed: 'Removal confirmed',
  search_requested: 'Replacement search requested',
  search_queued: 'Replacement search queued',
};
const replacementStatusLabels: Record<string, string> = {
  pending: 'Search pending',
  searching: 'Searching',
  download_queued: 'Replacement queued',
  downloaded: 'Replacement downloaded',
  search_failed: 'Search failed',
  no_result: 'No replacement found',
  unknown: 'Replacement status unknown',
};
const notificationStatusLabels: Record<string, string> = {
  pending: 'Pending',
  sent: 'Sent',
  failed: 'Failed',
  'not-configured': 'Not configured',
  'skipped-clear': 'Skipped because no findings were reported',
};
const outcomeLabels: Record<string, string> = {
  'Moved to the Brig.': 'Moved to quarantine.',
};

interface JobItem {
  id: string;
  status: string;
  phase?: string;
  error: string | null;
  outcome: string | null;
  candidate: {
    title: string;
    app: 'radarr' | 'sonarr';
    path?: string;
    sizeBytes?: number;
    category?: string;
    reason?: string;
  };
  replacement: null | { status: string; detail: string | null };
}

interface Job {
  id: string;
  type: string;
  title: string;
  status: string;
  createdAt: string;
  itemCount: number;
  settledCount: number;
  failedCount: number;
}

interface QuarantineRecord {
  id: string;
  app: 'radarr' | 'sonarr';
  title: string;
  sizeBytes: number;
  originalPath: string;
  quarantinePath: string;
  quarantinedAt: string;
}

interface Exclusion {
  id: string;
  app: 'radarr' | 'sonarr';
  title: string;
  subtitle: string;
  createdAt: string;
}

interface StorageResult {
  checkedAt: string;
  roots: Array<{ id: string; app: string; kind: string; path: string; readable: boolean; writable: boolean; freeBytes: number | null; error: string | null }>;
  compatibility: Array<{ app: string; downloadRoot: string; hardlinksPossible: boolean; matchingLibraryRoots: string[]; detail: string }>;
}

interface ScheduleState {
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastReport: null | { oversizedCount: number; oversizedBytes: number; orphanCount: number; orphanBytes: number; purgedQuarantineCount?: number; warnings: string[]; notification: { status: string; error?: string } };
}

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed with HTTP ${response.status}`);
  return body as T;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const order = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** order).toFixed(order >= 3 ? 2 : 1)} ${units[order]}`;
}

function fallbackLabel(value: string) {
  const words = value.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown';
}

function statusLabel(value: string, labels: Record<string, string>) {
  return labels[value] ?? `Unknown (${fallbackLabel(value)})`;
}

function Status({ value, label }: { value: string; label: string }) {
  return <span className={`ops-status ${value.replaceAll('_', '-')}`}>{label}</span>;
}

function JobItemRow({ item, recovery }: { item: JobItem; recovery: boolean }) {
  const phase = item.phase ?? item.status;
  const category = item.candidate.category === ''
    ? 'Uncategorized'
    : item.candidate.category === undefined ? 'Unknown category' : `Category ${JSON.stringify(item.candidate.category)}`;
  const reason = item.candidate.reason === 'slow'
    ? 'Slow download'
    : item.candidate.reason === 'stalled' ? 'Stalled download' : 'Automatic replacement candidate';
  const terminal = ['failed', 'cancelled', 'skipped'].includes(item.status);
  let badgeValue = item.status;
  let badgeLabel = statusLabel(item.status, itemStatusLabels);
  if (recovery && !terminal) {
    if (phase === 'search_queued' && item.replacement) {
      badgeValue = item.replacement.status;
      badgeLabel = statusLabel(item.replacement.status, replacementStatusLabels);
    } else {
      badgeValue = phase;
      badgeLabel = statusLabel(phase, itemPhaseLabels);
    }
  } else if (!recovery && item.replacement) {
    badgeValue = item.replacement.status;
    badgeLabel = statusLabel(item.replacement.status, replacementStatusLabels);
  }
  const detail = item.error
    || item.replacement?.detail
    || (item.outcome ? outcomeLabels[item.outcome] ?? item.outcome : null)
    || statusLabel(item.status, itemStatusLabels);
  return <div>
    <span className={`app-chip ${item.candidate.app}`}>{item.candidate.app}</span>
    <div>
      <strong>{item.candidate.title}</strong>
      {recovery && <small>{reason} · {category} · Phase: {statusLabel(phase, itemPhaseLabels)}</small>}
      <small>{detail}</small>
    </div>
    <Status value={badgeValue} label={badgeLabel} />
  </div>;
}

export function OperationsDialog({ initialTab = 'jobs', onClose, onChanged, onJobQueued }: { initialTab?: OpsTab; onClose: () => void; onChanged: () => Promise<void>; onJobQueued: (id: string) => void }) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<OpsTab>(initialTab);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobDetails, setJobDetails] = useState<Record<string, JobItem[]>>({});
  const [openJobIds, setOpenJobIds] = useState<string[]>([]);
  const [records, setRecords] = useState<QuarantineRecord[]>([]);
  const [exclusions, setExclusions] = useState<Exclusion[]>([]);
  const [storage, setStorage] = useState<StorageResult | null>(null);
  const [schedule, setSchedule] = useState<ScheduleState | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [loadErrors, setLoadErrors] = useState<Partial<Record<OpsTab, string>>>({});
  const actionLockRef = useRef(false);

  const setLoadError = useCallback((section: OpsTab, value: string) => {
    setLoadErrors((current) => ({ ...current, [section]: value }));
  }, []);

  const loadJobs = useCallback(async (detailIds: string[] = []) => {
    try {
      const [jobData, ...details] = await Promise.all([
        api<{ jobs: Job[] }>('/api/jobs'),
        ...detailIds.map((id) => api<{ job: { items: JobItem[] } }>(`/api/jobs/${id}`).catch(() => null)),
      ]);
      setJobs(jobData.jobs);
      const availableJobIds = new Set(jobData.jobs.map((job) => job.id));
      setOpenJobIds((current) => {
        const next = current.filter((id) => availableJobIds.has(id));
        return next.length === current.length ? current : next;
      });
      setJobDetails((current) => {
        const entries = Object.entries(current).filter(([id]) => availableJobIds.has(id));
        return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
      });
      if (detailIds.length) {
        setJobDetails((current) => {
          const next = { ...current };
          detailIds.forEach((id, index) => {
            const detail = details[index];
            if (detail && availableJobIds.has(id)) next[id] = detail.job.items;
          });
          return next;
        });
      }
      setLoadError('jobs', '');
    } catch (loadError) {
      setLoadError('jobs', loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [setLoadError]);

  const loadQuarantine = useCallback(async () => {
    try {
      const result = await api<{ records: QuarantineRecord[] }>('/api/quarantine');
      setRecords(result.records);
      setLoadError('brig', '');
    } catch (loadError) {
      setLoadError('brig', loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [setLoadError]);

  const loadExclusions = useCallback(async () => {
    try {
      const result = await api<{ exclusions: Exclusion[] }>('/api/exclusions');
      setExclusions(result.exclusions);
      setLoadError('exclusions', '');
    } catch (loadError) {
      setLoadError('exclusions', loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [setLoadError]);

  const loadStorage = useCallback(async () => {
    try {
      setStorage(await api<StorageResult>('/api/storage/health'));
      setLoadError('storage', '');
    } catch (loadError) {
      setLoadError('storage', loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [setLoadError]);

  const loadSchedule = useCallback(async () => {
    try {
      setSchedule(await api<ScheduleState>('/api/schedule'));
      setLoadError('schedule', '');
    } catch (loadError) {
      setLoadError('schedule', loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [setLoadError]);

  useEffect(() => {
    if (tab === 'brig') void loadQuarantine();
    if (tab === 'storage') void loadStorage();
    if (tab === 'exclusions') void loadExclusions();
    if (tab === 'schedule') void loadSchedule();
  }, [loadExclusions, loadQuarantine, loadSchedule, loadStorage, tab]);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const interval = tab === 'jobs' ? 3000 : 15000;
    const poll = async () => {
      await loadJobs(tab === 'jobs' ? openJobIds : []);
      if (!stopped) timer = window.setTimeout(poll, interval);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadJobs, openJobIds, tab]);

  async function action(key: string, work: () => Promise<void>, refresh?: () => Promise<void>, refreshMain = false) {
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    setBusy(key);
    setError('');
    try {
      await work();
      if (refresh) await refresh();
      if (refreshMain) await onChanged();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      actionLockRef.current = false;
      setBusy('');
    }
  }

  async function checkStorage() {
    await action('storage', loadStorage);
  }

  function setJobDetailsOpen(id: string, open: boolean) {
    setOpenJobIds((current) => open
      ? current.includes(id) ? current : [...current, id]
      : current.filter((value) => value !== id));
  }

  function selectTab(value: OpsTab) {
    if (actionLockRef.current) return;
    if (value !== 'jobs') setOpenJobIds([]);
    setTab(value);
  }

  async function runScheduled() {
    await action('schedule', async () => { await api('/api/schedule/run', { method: 'POST', body: '{}' }); }, loadSchedule);
  }

  const activeJobCount = jobs.filter((job) => activeJobStatuses.has(job.status)).length;
  const currentLoadError = loadErrors[tab] ?? '';

  return (
    <ModalDialog
      open
      labelledBy="operations-title"
      describedBy="operations-description"
      className="settings-modal operations-modal"
      dialogRef={dialogRef}
      initialFocusRef={titleRef}
      onDismiss={onClose}
    >
      <section className="settings-dialog operations-dialog">
        <header className="settings-header">
          <div><p className="eyebrow gold">SHIP’S OPERATIONS</p><h2 ref={titleRef} id="operations-title" tabIndex={-1}>Jobs, quarantine & health</h2><p id="operations-description">Track file actions, restore quarantined files, and inspect storage and maintenance reports.</p></div>
          <button type="button" className="settings-close" onClick={() => dialogRef.current?.close()} aria-label="Close operations">×</button>
        </header>
        <nav className="operations-tabs" aria-label="Operations sections">
          {opsTabs.map((value) => {
            const count = value === 'jobs' ? activeJobCount : value === 'brig' ? records.length : null;
            return <button type="button" key={value} className={tab === value ? 'active' : ''} aria-current={tab === value ? 'page' : undefined} disabled={Boolean(busy)} onClick={() => selectTab(value)}>{opsTabLabels[value]}{count === null ? '' : ` · ${count}`}</button>;
          })}
        </nav>
        <div className="settings-scroll operations-scroll">
          {(error || currentLoadError) && <div className="notice error" role="alert">{error || currentLoadError}</div>}

          {tab === 'jobs' && <div className="ops-list">
            <p className="ops-explanation">A completed job means its cleanup actions and replacement search requests finished. Any later replacement download progress appears inside the job.</p>
            {!jobs.length && <div className="ops-empty"><h3>No jobs yet</h3><p>Confirmed file actions and automatic replacements will appear here and persist across restarts.</p></div>}
            {jobs.map((job) => {
              const finished = job.settledCount;
              const items = jobDetails[job.id];
              return <article className="job-card" key={job.id}>
                <div className="job-card-head"><div><h3>{job.title}</h3><p>{new Date(job.createdAt).toLocaleString()}</p></div><Status value={job.status} label={statusLabel(job.status, jobStatusLabels)} /></div>
                <div className="job-progress"><span style={{ width: `${job.itemCount ? finished / job.itemCount * 100 : 0}%` }} /></div>
                <p className="job-count">{finished} of {job.itemCount} item(s) finished</p>
                <div className="job-actions">
                  {activeJobStatuses.has(job.status) && <button type="button" className="ghost-button compact" disabled={Boolean(busy)} onClick={() => action(`cancel-${job.id}`, async () => { await api(`/api/jobs/${job.id}/cancel`, { method: 'POST', body: '{}' }); }, () => loadJobs(openJobIds))}>Cancel remaining</button>}
                  {job.failedCount > 0 && !activeJobStatuses.has(job.status) && <button type="button" className="ghost-button compact" disabled={Boolean(busy)} onClick={() => action(`retry-${job.id}`, async () => { const result = await api<{ job: { id: string } }>(`/api/jobs/${job.id}/retry`, { method: 'POST', body: '{}' }); onJobQueued(result.job.id); }, () => loadJobs(openJobIds))}>Retry failures</button>}
                </div>
                <details onToggle={(event) => setJobDetailsOpen(job.id, event.currentTarget.open)}><summary>{items ? 'Item progress' : 'Load item progress'}</summary>{items && <div className="job-items">{items.map((item) => <JobItemRow item={item} recovery={job.type === 'qbittorrent-recovery'} key={item.id} />)}</div>}</details>
              </article>;
            })}
          </div>}

          {tab === 'brig' && <div className="ops-list">
            {!records.length && <div className="ops-empty"><h3>Quarantine is empty</h3><p>Files quarantined by this version can be restored here. Older quarantine folders remain untouched.</p></div>}
            {records.map((record) => <article className="record-card" key={record.id}><div><span className={`app-chip ${record.app}`}>{record.app}</span><h3>{record.title}</h3><p title={record.originalPath}>{record.originalPath}</p><small>{formatBytes(record.sizeBytes)} · {new Date(record.quarantinedAt).toLocaleString()}</small></div><div className="record-actions"><button type="button" className="ghost-button compact" disabled={Boolean(busy)} onClick={() => action(`restore-${record.id}`, async () => { await api(`/api/quarantine/${record.id}/restore`, { method: 'POST', body: '{}' }); }, loadQuarantine, true)}>Restore</button><button type="button" className="danger-button compact" disabled={Boolean(busy)} onClick={() => window.confirm(`Permanently delete ${record.title} from quarantine?`) && action(`purge-${record.id}`, async () => { await api(`/api/quarantine/${record.id}`, { method: 'DELETE' }); }, loadQuarantine)}>Delete permanently</button></div></article>)}
          </div>}

          {tab === 'storage' && <div className="ops-list"><div className="ops-toolbar"><div><h3>Storage health</h3><p>Checks access, free space, and whether hardlinks can cross each configured path.</p></div><button type="button" className="primary-button compact" disabled={Boolean(busy)} onClick={checkStorage}>{busy === 'storage' ? 'Checking…' : 'Run health check'}</button></div>{storage?.roots.map((root) => {
            const health = root.error ? 'error' : root.readable && root.writable ? 'healthy' : 'warning';
            return <article className="health-row" key={root.id}><div><span className={`app-chip ${root.app}`}>{root.app}</span><strong>{fallbackLabel(root.kind)}</strong><p>{root.path}</p></div><div><Status value={health} label={statusLabel(health, { healthy: 'Healthy', warning: 'Needs attention', error: 'Error' })} /><small>{root.freeBytes === null ? root.error : `${formatBytes(root.freeBytes)} free`}</small></div></article>;
          })}{storage?.compatibility.map((item) => <div className={`hardlink-check ${item.hardlinksPossible ? 'success' : 'warning'}`} key={`${item.app}-${item.downloadRoot}`}><strong>{item.hardlinksPossible ? 'Hardlinks possible' : 'Filesystem mismatch'}</strong><span>{item.downloadRoot}</span><p>{item.detail}</p></div>)}</div>}

          {tab === 'exclusions' && <div className="ops-list">{!exclusions.length && <div className="ops-empty"><h3>No exclusions</h3><p>Use the scan result batch controls to exclude selected files from size-limit findings.</p></div>}{exclusions.map((record) => <article className="record-card" key={record.id}><div><span className={`app-chip ${record.app}`}>{record.app}</span><h3>{record.title}</h3><p>{record.subtitle}</p><small>Excluded {new Date(record.createdAt).toLocaleString()}</small></div><button type="button" className="ghost-button compact" disabled={Boolean(busy)} onClick={() => action(`exclude-${record.id}`, async () => { await api(`/api/exclusions/${record.id}`, { method: 'DELETE' }); }, loadExclusions, true)}>Remove exclusion</button></article>)}</div>}

          {tab === 'schedule' && <div className="ops-list"><div className="ops-toolbar"><div><h3>Scheduled maintenance</h3><p>Scheduled and manual maintenance scan for findings, apply configured quarantine retention, and may permanently delete expired quarantined files.</p></div><button type="button" className="primary-button compact" disabled={Boolean(busy)} onClick={runScheduled}>{busy === 'schedule' ? 'Running maintenance…' : 'Run maintenance now'}</button></div>{schedule?.lastReport ? <article className="schedule-report"><h3>Latest maintenance run</h3><div><strong>{schedule.lastReport.oversizedCount}</strong><span>over size limits · {formatBytes(schedule.lastReport.oversizedBytes)}</span></div><div><strong>{schedule.lastReport.orphanCount}</strong><span>untracked · {formatBytes(schedule.lastReport.orphanBytes)}</span></div>{typeof schedule.lastReport.purgedQuarantineCount === 'number' && <div><strong>{schedule.lastReport.purgedQuarantineCount}</strong><span>expired quarantine file(s) permanently deleted</span></div>}<p>Notification: {statusLabel(schedule.lastReport.notification.status, notificationStatusLabels)}{schedule.lastReport.notification.error ? ` · ${schedule.lastReport.notification.error}` : ''}</p>{schedule.lastReport.warnings?.map((warning, index) => <p className="notice warning" key={index}>{warning}</p>)}<small>Last run {schedule.lastRunAt ? new Date(schedule.lastRunAt).toLocaleString() : 'never'}{schedule.nextRunAt ? ` · next ${new Date(schedule.nextRunAt).toLocaleString()}` : ''}</small></article> : <div className="ops-empty"><h3>No maintenance runs yet</h3><p>Run maintenance now or enable scheduled maintenance in Settings.</p></div>}</div>}
        </div>
      </section>
    </ModalDialog>
  );
}
