import { useCallback, useEffect, useRef, useState } from 'react';

type OpsTab = 'jobs' | 'brig' | 'storage' | 'exclusions' | 'schedule';

interface JobItem {
  id: string;
  status: string;
  error: string | null;
  outcome: string | null;
  candidate: { title: string; app: 'radarr' | 'sonarr'; path: string; sizeBytes: number };
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
  lastReport: null | { oversizedCount: number; oversizedBytes: number; orphanCount: number; orphanBytes: number; purgedQuarantineCount: number; warnings: string[]; notification: { status: string; error?: string } };
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

function Status({ value }: { value: string }) {
  return <span className={`ops-status ${value.replaceAll('_', '-')}`}>{value.replaceAll('_', ' ')}</span>;
}

export function OperationsDialog({ initialTab = 'jobs', onClose, onChanged }: { initialTab?: OpsTab; onClose: () => void; onChanged: () => Promise<void> }) {
  const [tab, setTab] = useState<OpsTab>(initialTab);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobDetails, setJobDetails] = useState<Record<string, JobItem[]>>({});
  const [records, setRecords] = useState<QuarantineRecord[]>([]);
  const [exclusions, setExclusions] = useState<Exclusion[]>([]);
  const [storage, setStorage] = useState<StorageResult | null>(null);
  const [schedule, setSchedule] = useState<ScheduleState | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const loadedJobIds = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const detailIds = [...loadedJobIds.current];
      const [jobData, quarantineData, exclusionData, scheduleData, ...details] = await Promise.all([
        api<{ jobs: Job[] }>('/api/jobs'),
        api<{ records: QuarantineRecord[] }>('/api/quarantine'),
        api<{ exclusions: Exclusion[] }>('/api/exclusions'),
        api<ScheduleState>('/api/schedule'),
        ...detailIds.map((id) => api<{ job: { items: JobItem[] } }>(`/api/jobs/${id}`).catch(() => null)),
      ]);
      setJobs(jobData.jobs);
      setRecords(quarantineData.records);
      setExclusions(exclusionData.exclusions);
      setSchedule(scheduleData);
      if (detailIds.length) setJobDetails(Object.fromEntries(detailIds.flatMap((id, index) => {
        const detail = details[index];
        return detail ? [[id, detail.job.items]] : [];
      })));
      setLoadError('');
    } catch (loadError) {
      setLoadError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function action(key: string, work: () => Promise<void>, refreshMain = false) {
    setBusy(key);
    setError('');
    try {
      await work();
      await load();
      if (refreshMain) await onChanged();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy('');
    }
  }

  async function checkStorage() {
    await action('storage', async () => setStorage(await api<StorageResult>('/api/storage/health')));
  }

  async function loadJob(id: string) {
    if (jobDetails[id]) return;
    loadedJobIds.current.add(id);
    await action(`job-${id}`, async () => {
      const result = await api<{ job: { items: JobItem[] } }>(`/api/jobs/${id}`);
      setJobDetails((current) => ({ ...current, [id]: result.job.items }));
    });
  }

  async function runScheduled() {
    await action('schedule', async () => { await api('/api/schedule/run', { method: 'POST', body: '{}' }); });
  }

  return (
    <div className="settings-backdrop" role="presentation">
      <section className="settings-dialog operations-dialog" role="dialog" aria-modal="true" aria-labelledby="operations-title">
        <header className="settings-header">
          <div><p className="eyebrow gold">SHIP’S OPERATIONS</p><h2 id="operations-title">Jobs, Brig & health</h2><p>Track work, recover quarantined files and inspect the storage beneath both holds.</p></div>
          <button type="button" className="settings-close" onClick={onClose} aria-label="Close operations">×</button>
        </header>
        <nav className="operations-tabs" aria-label="Operations sections">
          {(['jobs', 'brig', 'storage', 'exclusions', 'schedule'] as OpsTab[]).map((value) => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{value === 'brig' ? `Brig · ${records.length}` : value === 'jobs' ? `Jobs · ${jobs.filter((job) => ['queued', 'running', 'cancelling'].includes(job.status)).length}` : value}</button>)}
        </nav>
        <div className="settings-scroll operations-scroll">
          {(error || loadError) && <div className="notice error">{error || loadError}</div>}

          {tab === 'jobs' && <div className="ops-list">
            <p className="ops-explanation">Completed means file actions and search requests finished. Replacement download progress is shown separately inside each job.</p>
            {!jobs.length && <div className="ops-empty"><h3>No jobs yet</h3><p>Confirmed file actions will appear here and survive restarts.</p></div>}
            {jobs.map((job) => {
              const done = job.settledCount;
              const items = jobDetails[job.id];
              return <article className="job-card" key={job.id}>
                <div className="job-card-head"><div><h3>{job.title}</h3><p>{new Date(job.createdAt).toLocaleString()}</p></div><Status value={job.status} /></div>
                <div className="job-progress"><span style={{ width: `${job.itemCount ? done / job.itemCount * 100 : 0}%` }} /></div>
                <p className="job-count">{done} of {job.itemCount} item(s) settled</p>
                <div className="job-actions">
                  {['queued', 'running', 'cancelling'].includes(job.status) && <button className="ghost-button compact" disabled={Boolean(busy)} onClick={() => action(`cancel-${job.id}`, async () => { await api(`/api/jobs/${job.id}/cancel`, { method: 'POST', body: '{}' }); })}>Cancel remaining</button>}
                  {job.failedCount > 0 && !['queued', 'running', 'cancelling'].includes(job.status) && <button className="ghost-button compact" disabled={Boolean(busy)} onClick={() => action(`retry-${job.id}`, async () => { await api(`/api/jobs/${job.id}/retry`, { method: 'POST', body: '{}' }); })}>Retry failures</button>}
                </div>
                <details onToggle={(event) => event.currentTarget.open && loadJob(job.id)}><summary>{items ? 'Item progress' : 'Load item progress'}</summary>{items && <div className="job-items">{items.map((item) => <div key={item.id}><span className={`app-chip ${item.candidate.app}`}>{item.candidate.app}</span><div><strong>{item.candidate.title}</strong><small>{item.error || item.replacement?.detail || item.outcome || item.status}</small></div><Status value={item.replacement?.status ?? item.status} /></div>)}</div>}</details>
              </article>;
            })}
          </div>}

          {tab === 'brig' && <div className="ops-list">
            {!records.length && <div className="ops-empty"><h3>The Brig is empty</h3><p>Files quarantined by this version will be recoverable here. Older quarantine folders remain untouched.</p></div>}
            {records.map((record) => <article className="record-card" key={record.id}><div><span className={`app-chip ${record.app}`}>{record.app}</span><h3>{record.title}</h3><p title={record.originalPath}>{record.originalPath}</p><small>{formatBytes(record.sizeBytes)} · {new Date(record.quarantinedAt).toLocaleString()}</small></div><div className="record-actions"><button className="ghost-button compact" disabled={Boolean(busy)} onClick={() => action(`restore-${record.id}`, async () => { await api(`/api/quarantine/${record.id}/restore`, { method: 'POST', body: '{}' }); }, true)}>Restore</button><button className="danger-button compact" disabled={Boolean(busy)} onClick={() => window.confirm(`Permanently delete ${record.title} from quarantine?`) && action(`purge-${record.id}`, async () => { await api(`/api/quarantine/${record.id}`, { method: 'DELETE' }); })}>Purge</button></div></article>)}
          </div>}

          {tab === 'storage' && <div className="ops-list"><div className="ops-toolbar"><div><h3>Storage health</h3><p>Checks access, free space and whether hardlinks can cross each configured path.</p></div><button className="primary-button compact" disabled={busy === 'storage'} onClick={checkStorage}>{busy === 'storage' ? 'Checking…' : 'Run health check'}</button></div>{storage?.roots.map((root) => <article className="health-row" key={root.id}><div><span className={`app-chip ${root.app}`}>{root.app}</span><strong>{root.kind}</strong><p>{root.path}</p></div><div><Status value={root.error ? 'error' : root.readable && root.writable ? 'healthy' : 'warning'} /><small>{root.freeBytes === null ? root.error : `${formatBytes(root.freeBytes)} free`}</small></div></article>)}{storage?.compatibility.map((item) => <div className={`hardlink-check ${item.hardlinksPossible ? 'success' : 'warning'}`} key={`${item.app}-${item.downloadRoot}`}><strong>{item.hardlinksPossible ? 'Hardlinks possible' : 'Filesystem mismatch'}</strong><span>{item.downloadRoot}</span><p>{item.detail}</p></div>)}</div>}

          {tab === 'exclusions' && <div className="ops-list">{!exclusions.length && <div className="ops-empty"><h3>No permanent exclusions</h3><p>Exclude selected oversized items from the manifest’s batch controls.</p></div>}{exclusions.map((record) => <article className="record-card" key={record.id}><div><span className={`app-chip ${record.app}`}>{record.app}</span><h3>{record.title}</h3><p>{record.subtitle}</p><small>Excluded {new Date(record.createdAt).toLocaleString()}</small></div><button className="ghost-button compact" disabled={Boolean(busy)} onClick={() => action(`exclude-${record.id}`, async () => { await api(`/api/exclusions/${record.id}`, { method: 'DELETE' }); }, true)}>Include again</button></article>)}</div>}

          {tab === 'schedule' && <div className="ops-list"><div className="ops-toolbar"><div><h3>Scheduled reports</h3><p>Reports never delete findings. Optional Brig retention is managed separately in Settings.</p></div><button className="primary-button compact" disabled={busy === 'schedule'} onClick={runScheduled}>{busy === 'schedule' ? 'Scanning…' : 'Run report now'}</button></div>{schedule?.lastReport ? <article className="schedule-report"><h3>Latest report</h3><div><strong>{schedule.lastReport.oversizedCount}</strong><span>oversized · {formatBytes(schedule.lastReport.oversizedBytes)}</span></div><div><strong>{schedule.lastReport.orphanCount}</strong><span>orphans · {formatBytes(schedule.lastReport.orphanBytes)}</span></div><p>Notification: {schedule.lastReport.notification.status}{schedule.lastReport.notification.error ? ` · ${schedule.lastReport.notification.error}` : ''}</p>{schedule.lastReport.warnings?.map((warning, index) => <p className="notice warning" key={index}>{warning}</p>)}<small>Last run {schedule.lastRunAt ? new Date(schedule.lastRunAt).toLocaleString() : 'never'}{schedule.nextRunAt ? ` · next ${new Date(schedule.nextRunAt).toLocaleString()}` : ''}</small></article> : <div className="ops-empty"><h3>No reports yet</h3><p>Run one now or enable scheduled scans in Settings.</p></div>}</div>}
        </div>
      </section>
    </div>
  );
}
