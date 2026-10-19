import { useEffect, useState } from 'react';

// Settings and status for the download automations that took over from Cleanuparr:
// failed-import cleanup, the content blocker, seeding cleanup, unlinked-torrent cleanup,
// the ignore lists they share, and ntfy. Every feature is off and in dry run until
// switched, and the preview shows what each would do before anything is saved.

export const CLEANUPARR_BLOCKLIST_URL = 'https://cleanuparr.pages.dev/static/blacklist';

export interface IgnoreList {
  categories: string[];
  tags: string[];
  hashes: string[];
}

interface SeedingRule {
  category: string;
  maxRatio: number;
  minSeedHours: number;
  maxSeedHours: number;
  maxInactiveDays: number;
  minSeeders: number;
  deleteFiles: boolean;
}

export interface AutomationSettings {
  downloadIgnore: IgnoreList;
  strikeInactivityHours: number;
  failedImports: {
    enabled: boolean; dryRun: boolean; intervalMinutes: number; maxStrikes: number; forceImportAttempts: number;
    ignorePrivate: boolean; deletePrivate: boolean; ignoredMessages: string[]; ignore: IgnoreList;
  };
  contentBlocker: {
    enabled: boolean; dryRun: boolean; intervalSeconds: number; mode: 'blocklist' | 'allowlist'; listUrl: string;
    refreshHours: number; patterns: string[]; ignorePrivate: boolean; removeWhenAllBlocked: boolean;
    syncExcludedFileNames: boolean; ignore: IgnoreList;
  };
  seedingCleanup: { enabled: boolean; dryRun: boolean; intervalMinutes: number; rules: SeedingRule[]; ignore: IgnoreList };
  unlinkedCleanup: {
    enabled: boolean; dryRun: boolean; intervalMinutes: number; categories: string[]; tags: string[];
    ignoredRoots: string[]; minCompletedHours: number; deleteFiles: boolean; ignore: IgnoreList;
  };
}

export interface NtfySettings {
  urlConfigured: boolean;
  tokenConfigured: boolean;
  priority: number;
  downloadEvents: boolean;
  scanReports: boolean;
}

interface IgnoreForm {
  categories: string[];
  tagsText: string;
  hashesText: string;
}

interface SeedingRuleRow {
  category: string;
  maxRatio: string;
  minSeedHours: string;
  maxSeedHours: string;
  maxInactiveDays: string;
  minSeeders: string;
  deleteFiles: boolean;
}

export interface AutomationForm {
  downloadIgnore: IgnoreForm;
  strikeInactivityHours: string;
  failedImports: {
    enabled: boolean; dryRun: boolean; intervalMinutes: string; maxStrikes: string; forceImportAttempts: string;
    ignorePrivate: boolean; deletePrivate: boolean; ignoredMessagesText: string; ignore: IgnoreForm;
  };
  contentBlocker: {
    enabled: boolean; dryRun: boolean; intervalSeconds: string; mode: 'blocklist' | 'allowlist'; listUrl: string;
    refreshHours: string; patternsText: string; ignorePrivate: boolean; removeWhenAllBlocked: boolean;
    syncExcludedFileNames: boolean; ignore: IgnoreForm;
  };
  seedingCleanup: { enabled: boolean; dryRun: boolean; intervalMinutes: string; rules: SeedingRuleRow[]; ignore: IgnoreForm };
  unlinkedCleanup: {
    enabled: boolean; dryRun: boolean; intervalMinutes: string; categories: string[]; tagsText: string;
    ignoredRootsText: string; minCompletedHours: string; deleteFiles: boolean; ignore: IgnoreForm;
  };
}

export interface NtfyForm extends NtfySettings {
  url: string;
  clearUrl: boolean;
  token: string;
  clearToken: boolean;
  priorityText: string;
}

const text = (value: number) => value.toString();
const limitText = (value: number) => (value < 0 ? '' : value.toString());

function ignoreForm(list: IgnoreList): IgnoreForm {
  return { categories: [...list.categories], tagsText: list.tags.join(', '), hashesText: list.hashes.join('\n') };
}

function seedingRow(rule: SeedingRule): SeedingRuleRow {
  return {
    category: rule.category,
    maxRatio: limitText(rule.maxRatio),
    minSeedHours: text(rule.minSeedHours),
    maxSeedHours: limitText(rule.maxSeedHours),
    maxInactiveDays: limitText(rule.maxInactiveDays),
    minSeeders: text(rule.minSeeders),
    deleteFiles: rule.deleteFiles,
  };
}

export function automationForm(settings: AutomationSettings): AutomationForm {
  const { failedImports: failed, contentBlocker: blocker, seedingCleanup: seeding, unlinkedCleanup: unlinked } = settings;
  return {
    downloadIgnore: ignoreForm(settings.downloadIgnore),
    strikeInactivityHours: text(settings.strikeInactivityHours),
    failedImports: {
      enabled: failed.enabled, dryRun: failed.dryRun, intervalMinutes: text(failed.intervalMinutes),
      maxStrikes: text(failed.maxStrikes), forceImportAttempts: text(failed.forceImportAttempts),
      ignorePrivate: failed.ignorePrivate, deletePrivate: failed.deletePrivate,
      ignoredMessagesText: failed.ignoredMessages.join('\n'), ignore: ignoreForm(failed.ignore),
    },
    contentBlocker: {
      enabled: blocker.enabled, dryRun: blocker.dryRun, intervalSeconds: text(blocker.intervalSeconds), mode: blocker.mode,
      listUrl: blocker.listUrl, refreshHours: text(blocker.refreshHours), patternsText: blocker.patterns.join('\n'),
      ignorePrivate: blocker.ignorePrivate, removeWhenAllBlocked: blocker.removeWhenAllBlocked,
      syncExcludedFileNames: blocker.syncExcludedFileNames, ignore: ignoreForm(blocker.ignore),
    },
    seedingCleanup: {
      enabled: seeding.enabled, dryRun: seeding.dryRun, intervalMinutes: text(seeding.intervalMinutes),
      rules: seeding.rules.map(seedingRow), ignore: ignoreForm(seeding.ignore),
    },
    unlinkedCleanup: {
      enabled: unlinked.enabled, dryRun: unlinked.dryRun, intervalMinutes: text(unlinked.intervalMinutes),
      categories: [...unlinked.categories], tagsText: unlinked.tags.join(', '), ignoredRootsText: unlinked.ignoredRoots.join('\n'),
      minCompletedHours: text(unlinked.minCompletedHours), deleteFiles: unlinked.deleteFiles, ignore: ignoreForm(unlinked.ignore),
    },
  };
}

export function ntfyForm(settings: NtfySettings): NtfyForm {
  return { ...settings, url: '', clearUrl: false, token: '', clearToken: false, priorityText: text(settings.priority) };
}

function number(value: string, label: string) {
  const output = Number(value);
  if (!value.trim() || !Number.isFinite(output)) throw new Error(`${label} must be a number.`);
  return output;
}

// Blank means "no limit", which the server spells -1.
function limit(value: string, label: string) {
  return value.trim() ? number(value, label) : -1;
}

function lines(value: string) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function commaList(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function ignorePayload(form: IgnoreForm): IgnoreList {
  return { categories: [...form.categories], tags: commaList(form.tagsText), hashes: lines(form.hashesText).map((hash) => hash.toLowerCase()) };
}

export function automationPayload(form: AutomationForm) {
  const { failedImports: failed, contentBlocker: blocker, seedingCleanup: seeding, unlinkedCleanup: unlinked } = form;
  return {
    downloadIgnore: ignorePayload(form.downloadIgnore),
    strikeInactivityHours: number(form.strikeInactivityHours, 'Strike inactivity window'),
    failedImports: {
      enabled: failed.enabled, dryRun: failed.dryRun,
      intervalMinutes: number(failed.intervalMinutes, 'Failed-import check interval'),
      maxStrikes: number(failed.maxStrikes, 'Failed-import strikes'),
      forceImportAttempts: number(failed.forceImportAttempts, 'Forced import attempts'),
      ignorePrivate: failed.ignorePrivate, deletePrivate: failed.deletePrivate,
      ignoredMessages: lines(failed.ignoredMessagesText), ignore: ignorePayload(failed.ignore),
    },
    contentBlocker: {
      enabled: blocker.enabled, dryRun: blocker.dryRun,
      intervalSeconds: number(blocker.intervalSeconds, 'Content blocker check interval'),
      mode: blocker.mode, listUrl: blocker.listUrl.trim(),
      refreshHours: number(blocker.refreshHours, 'Content blocker list refresh'),
      patterns: lines(blocker.patternsText), ignorePrivate: blocker.ignorePrivate,
      removeWhenAllBlocked: blocker.removeWhenAllBlocked, syncExcludedFileNames: blocker.syncExcludedFileNames,
      ignore: ignorePayload(blocker.ignore),
    },
    seedingCleanup: {
      enabled: seeding.enabled, dryRun: seeding.dryRun,
      intervalMinutes: number(seeding.intervalMinutes, 'Seeding cleanup interval'),
      rules: seeding.rules.map((rule, index) => ({
        category: rule.category,
        maxRatio: limit(rule.maxRatio, `Seeding rule ${index + 1} maximum ratio`),
        minSeedHours: number(rule.minSeedHours || '0', `Seeding rule ${index + 1} minimum seed time`),
        maxSeedHours: limit(rule.maxSeedHours, `Seeding rule ${index + 1} maximum seed time`),
        maxInactiveDays: limit(rule.maxInactiveDays, `Seeding rule ${index + 1} maximum inactive days`),
        minSeeders: number(rule.minSeeders || '0', `Seeding rule ${index + 1} minimum seeders`),
        deleteFiles: rule.deleteFiles,
      })),
      ignore: ignorePayload(seeding.ignore),
    },
    unlinkedCleanup: {
      enabled: unlinked.enabled, dryRun: unlinked.dryRun,
      intervalMinutes: number(unlinked.intervalMinutes, 'Unlinked cleanup interval'),
      categories: [...unlinked.categories], tags: commaList(unlinked.tagsText), ignoredRoots: lines(unlinked.ignoredRootsText),
      minCompletedHours: number(unlinked.minCompletedHours, 'Unlinked cleanup minimum age'),
      deleteFiles: unlinked.deleteFiles, ignore: ignorePayload(unlinked.ignore),
    },
  };
}

export function ntfyPayload(form: NtfyForm) {
  return {
    url: form.url.trim(), clearUrl: form.clearUrl, token: form.token, clearToken: form.clearToken,
    priority: number(form.priorityText, 'ntfy priority'), downloadEvents: form.downloadEvents, scanReports: form.scanReports,
  };
}

// Cleanuparr's values as Christian ran them, for putting a feature back to known-good
// numbers. Switches, dry run, and ignore lists are left as they are.
function withCleanuparrValues(form: AutomationForm): AutomationForm {
  return {
    ...form,
    strikeInactivityHours: '24',
    failedImports: { ...form.failedImports, intervalMinutes: '5', maxStrikes: '3', forceImportAttempts: '3', ignorePrivate: true, deletePrivate: false },
    contentBlocker: { ...form.contentBlocker, mode: 'blocklist', listUrl: CLEANUPARR_BLOCKLIST_URL, ignorePrivate: true, removeWhenAllBlocked: true },
  };
}

type FeatureKey = 'failedImports' | 'contentBlocker' | 'seedingCleanup' | 'unlinkedCleanup';

interface Decision {
  hash: string;
  title: string;
  category: string;
  verdict: 'act' | 'would-act' | 'strike' | 'attempt' | 'ignored' | 'preserved' | 'waiting';
  action?: string;
  detail: string;
  at?: string;
}

interface FeatureStatus {
  label: string;
  enabled: boolean;
  dryRun: boolean;
  blockedBy: 'off' | 'qbittorrent' | 'arr' | null;
  lastRunAt: string | null;
  lastError: string | null;
  decisions: Decision[];
  history: { days: number; doneCount: number; failedCount: number; inProgressCount: number };
  strikes?: Array<{ hash: string; count: number; attempts: number }>;
  blocklist?: { url: string | null; fetchedAt: string | null; lineCount: number; error: string | null; patternCount: number | null };
}

const verdictLabels: Record<Decision['verdict'], string> = {
  act: 'Acting',
  'would-act': 'Would act',
  strike: 'Struck',
  attempt: 'Import retried',
  ignored: 'Ignored',
  preserved: 'Kept',
  waiting: 'Waiting',
};

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Request failed with HTTP ${response.status}`);
  return data as T;
}

function ago(iso: string | null) {
  const minutes = iso ? Math.round((Date.now() - Date.parse(iso)) / 60_000) : Number.NaN;
  if (!Number.isFinite(minutes)) return 'never';
  if (minutes < 2) return 'just now';
  if (minutes < 90) return `${minutes} minutes ago`;
  return `${Math.round(minutes / 60)} hours ago`;
}

function DecisionList({ decisions, empty }: { decisions: Decision[]; empty: string }) {
  if (!decisions.length) return <p>{empty}</p>;
  return <ul className="automation-decisions">{decisions.map((decision, index) => <li key={`${decision.hash}:${index}`}>
    <span className={`decision-verdict ${decision.verdict}`}>{verdictLabels[decision.verdict] ?? decision.verdict}</span>
    <strong>{decision.title}</strong> {decision.detail}
  </li>)}</ul>;
}

function FeatureStatusLine({ status, formEnabled, formDryRun }: { status: FeatureStatus | undefined; formEnabled: boolean; formDryRun: boolean }) {
  if (!status) return <div className="recovery-status" role="status">Checking status…</div>;
  const savedOn = status.blockedBy !== 'off';
  if (formEnabled !== savedOn || (formEnabled && formDryRun !== status.dryRun)) {
    return <div className="recovery-status" role="status">Changed here. Save the settings to apply it.</div>;
  }
  if (status.blockedBy === 'off') return <div className="recovery-status" role="status">Off. Use Preview to see what it would do.</div>;
  if (status.blockedBy === 'qbittorrent') return <div className="recovery-status warning" role="status">On, but there is no saved qBittorrent connection.</div>;
  if (status.blockedBy === 'arr') return <div className="recovery-status warning" role="status">On, but neither Radarr nor Sonarr is connected.</div>;
  return (
    <div className={`recovery-status ${status.lastError ? 'warning' : ''}`} role="status">
      <p><strong>{status.dryRun ? 'Dry run: recording what it would do, changing nothing.' : 'On.'}</strong> Last checked {ago(status.lastRunAt)}.
        {!status.dryRun && ` In the last ${status.history.days} days: ${status.history.doneCount} done, ${status.history.failedCount} failed${status.history.inProgressCount ? `, ${status.history.inProgressCount} in progress` : ''}.`}</p>
      {status.lastError && <p>The last check failed: {status.lastError}</p>}
      {status.blocklist && <p>Blocklist: {status.blocklist.error && !status.blocklist.lineCount ? `not downloaded (${status.blocklist.error})` : `${status.blocklist.patternCount ?? status.blocklist.lineCount} patterns, fetched ${ago(status.blocklist.fetchedAt)}${status.blocklist.error ? `; last refresh failed: ${status.blocklist.error}` : ''}`}.</p>}
      {status.decisions.length > 0 && <details>
        <summary>Recent decisions ({status.decisions.length})</summary>
        <DecisionList decisions={status.decisions} empty="" />
      </details>}
    </div>
  );
}

function IgnoreEditor({ title, value, categories, onChange }: {
  title: string;
  value: IgnoreForm;
  categories: string[];
  onChange: (next: IgnoreForm) => void;
}) {
  const options = [...new Set([...categories, ...value.categories])];
  return (
    <details className="automation-ignore">
      <summary>{title}{value.categories.length || value.tagsText.trim() || value.hashesText.trim() ? ' (in use)' : ''}</summary>
      <div className="category-options">
        {options.map((name) => <label className="category-option" key={`ignore\u0000${name}`}>
          <input type="checkbox" checked={value.categories.includes(name)} onChange={(event) => onChange({
            ...value,
            categories: event.target.checked ? [...value.categories, name] : value.categories.filter((item) => item !== name),
          })} />
          <span><strong className="category-name">{name === '' ? 'Uncategorized' : name}</strong><small>Ignore this category</small></span>
        </label>)}
        {!options.length && <p className="category-state">Save or test qBittorrent to choose categories.</p>}
      </div>
      <div className="settings-grid">
        <label className="field">Tags <span>comma separated, any case</span><input value={value.tagsText} onChange={(event) => onChange({ ...value, tagsText: event.target.value })} /></label>
        <label className="field">Torrent hashes <span>one per line</span><textarea rows={2} value={value.hashesText} onChange={(event) => onChange({ ...value, hashesText: event.target.value })} /></label>
      </div>
    </details>
  );
}

function CategoryChooser({ label, hint, selected, categories, onChange }: {
  label: string; hint: string; selected: string[]; categories: string[]; onChange: (next: string[]) => void;
}) {
  const options = [...new Set([...categories, ...selected])];
  return (
    <div className="category-picker">
      <div className="category-picker-head"><div><strong>{label}</strong><span>{hint}</span></div></div>
      <div className="category-options">
        {options.map((name) => <label className="category-option" key={`${label}\u0000${name}`}>
          <input type="checkbox" checked={selected.includes(name)} onChange={(event) => onChange(event.target.checked ? [...selected, name] : selected.filter((item) => item !== name))} />
          <span><strong className="category-name">{name === '' ? 'Uncategorized' : name}</strong></span>
        </label>)}
        {!options.length && <p className="category-state">Save or test qBittorrent to choose categories.</p>}
      </div>
    </div>
  );
}

function FeatureHead({ chip, title, enabled, dryRun, description, onEnabled, onDryRun }: {
  chip: string; title: string; enabled: boolean; dryRun: boolean; description: string;
  onEnabled: (value: boolean) => void; onDryRun: (value: boolean) => void;
}) {
  return <>
    <div className="settings-section-head"><div><span className="app-chip qbittorrent">{chip}</span><h3>{title}</h3></div></div>
    <label className="check-row feature-toggle recovery-toggle">
      <input type="checkbox" checked={enabled} onChange={(event) => onEnabled(event.target.checked)} />
      <span><strong>Turn on {title.toLowerCase()}</strong><small>{description}</small></span>
    </label>
    <label className="check-row"><input type="checkbox" checked={dryRun} onChange={(event) => onDryRun(event.target.checked)} />Dry run: record what it would do and why, change nothing</label>
  </>;
}

export function DownloadAutomationSettings({ form, ntfy, categories, statusRevision, onChange, onNtfyChange }: {
  form: AutomationForm;
  ntfy: NtfyForm;
  categories: string[];
  statusRevision: number;
  onChange: (next: AutomationForm) => void;
  onNtfyChange: (next: NtfyForm) => void;
}) {
  const [status, setStatus] = useState<Partial<Record<FeatureKey, FeatureStatus>>>({});
  const [statusError, setStatusError] = useState('');
  const [preview, setPreview] = useState<{ previewedAt: string; features: Partial<Record<FeatureKey, { error: string | null; decisions: Decision[] }>> } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [ntfyMessage, setNtfyMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = () => request<{ features: Record<FeatureKey, FeatureStatus> }>('/api/automation/status')
      .then((result) => { if (!cancelled) { setStatus(result.features); setStatusError(''); } })
      .catch((error) => { if (!cancelled) setStatusError(error instanceof Error ? error.message : String(error)); });
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [statusRevision]);

  async function runPreview() {
    setPreviewing(true);
    setPreviewError('');
    try {
      setPreview(await request('/api/automation/preview', { method: 'POST', body: '{}' }));
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewing(false);
    }
  }

  async function testNtfy() {
    setNtfyMessage('Sending…');
    try {
      await request('/api/notifications/ntfy/test', { method: 'POST', body: JSON.stringify({ url: ntfy.url.trim(), token: ntfy.token }) });
      setNtfyMessage('Test notification sent.');
    } catch (error) {
      setNtfyMessage(error instanceof Error ? error.message : String(error));
    }
  }

  const set = <K extends FeatureKey>(key: K, patch: Partial<AutomationForm[K]>) => onChange({ ...form, [key]: { ...form[key], ...patch } });
  const failed = form.failedImports;
  const blocker = form.contentBlocker;
  const seeding = form.seedingCleanup;
  const unlinked = form.unlinkedCleanup;
  const updateRule = (index: number, patch: Partial<SeedingRuleRow>) => set('seedingCleanup', {
    rules: seeding.rules.map((rule, position) => (position === index ? { ...rule, ...patch } : rule)),
  });
  const previewFor = (key: FeatureKey) => preview?.features[key];
  const PreviewResult = ({ feature }: { feature: FeatureKey }) => {
    const result = previewFor(feature);
    if (!result) return null;
    return <div className="recovery-status" role="status"><p><strong>Preview {ago(preview?.previewedAt ?? null)}:</strong>{result.error ? ` could not run: ${result.error}` : ''}</p>
      {!result.error && <DecisionList decisions={result.decisions} empty="Nothing would be touched right now." />}</div>;
  };

  return <>
    <section className="settings-section">
      <div className="settings-section-head"><div><p className="eyebrow">DOWNLOAD AUTOMATION</p><h3>Shared rules</h3></div>
        <div className="automation-actions">
          <button type="button" className="ghost-button compact" onClick={() => onChange(withCleanuparrValues(form))}>Use Cleanuparr values</button>
          <button type="button" className="ghost-button compact" onClick={runPreview} disabled={previewing}>{previewing ? 'Previewing…' : 'Preview all'}</button>
        </div>
      </div>
      <p className="field-hint">Preview judges every feature below against qBittorrent and Radarr/Sonarr right now, as if each were on and in dry run, using the saved settings. It adds no strikes and changes nothing.</p>
      {previewError && <p className="notice error" role="alert">{previewError}</p>}
      {statusError && <p className="notice error" role="alert">Could not read the automation status: {statusError}</p>}
      <div className="settings-grid three">
        <label className="field">Strikes expire after (hours) <span>with no new strike</span><input type="number" min="1" max="8760" value={form.strikeInactivityHours} onChange={(event) => onChange({ ...form, strikeInactivityHours: event.target.value })} /></label>
      </div>
      <IgnoreEditor title="Global ignore list: never touched by any automation, including automatic replacement" value={form.downloadIgnore} categories={categories} onChange={(next) => onChange({ ...form, downloadIgnore: next })} />
    </section>

    <section className="settings-section">
      <FeatureHead chip="Arr" title="Failed-import cleanup" enabled={failed.enabled} dryRun={failed.dryRun}
        description="Removes finished downloads that Radarr/Sonarr cannot import, after a forced import and a number of strikes. Each is blocklisted and searched for again."
        onEnabled={(enabled) => set('failedImports', { enabled })} onDryRun={(dryRun) => set('failedImports', { dryRun })} />
      <FeatureStatusLine status={status.failedImports} formEnabled={failed.enabled} formDryRun={failed.dryRun} />
      <PreviewResult feature="failedImports" />
      <div className="settings-grid three">
        <label className="field">Check every (minutes)<input type="number" min="1" max="1440" value={failed.intervalMinutes} onChange={(event) => set('failedImports', { intervalMinutes: event.target.value })} /></label>
        <label className="field">Strikes before removal<input type="number" min="1" max="100" value={failed.maxStrikes} onChange={(event) => set('failedImports', { maxStrikes: event.target.value })} /></label>
        <label className="field">Forced import attempts first <span>0 strikes straight away</span><input type="number" min="0" max="10" value={failed.forceImportAttempts} onChange={(event) => set('failedImports', { forceImportAttempts: event.target.value })} /></label>
      </div>
      <label className="check-row"><input type="checkbox" checked={failed.ignorePrivate} onChange={(event) => set('failedImports', { ignorePrivate: event.target.checked })} />Ignore private-tracker torrents</label>
      {!failed.ignorePrivate && <label className="check-row"><input type="checkbox" checked={failed.deletePrivate} onChange={(event) => set('failedImports', { deletePrivate: event.target.checked })} />Also delete private torrents from qBittorrent (otherwise they keep seeding)</label>}
      <label className="field wide-field">Ignore imports whose message contains <span>one phrase per line</span><textarea rows={2} value={failed.ignoredMessagesText} onChange={(event) => set('failedImports', { ignoredMessagesText: event.target.value })} /></label>
      <IgnoreEditor title="Failed-import ignore list" value={failed.ignore} categories={categories} onChange={(ignore) => set('failedImports', { ignore })} />
    </section>

    <section className="settings-section">
      <FeatureHead chip="qBittorrent" title="Content blocker" enabled={blocker.enabled} dryRun={blocker.dryRun}
        description="Sets blocked files in new Radarr/Sonarr torrents to do not download. A torrent whose every file is blocked is removed, blocklisted, and searched for again."
        onEnabled={(enabled) => set('contentBlocker', { enabled })} onDryRun={(dryRun) => set('contentBlocker', { dryRun })} />
      <FeatureStatusLine status={status.contentBlocker} formEnabled={blocker.enabled} formDryRun={blocker.dryRun} />
      <PreviewResult feature="contentBlocker" />
      <div className="settings-grid three">
        <label className="field">Check every (seconds)<input type="number" min="10" max="86400" value={blocker.intervalSeconds} onChange={(event) => set('contentBlocker', { intervalSeconds: event.target.value })} /></label>
        <label className="field">Mode<select value={blocker.mode} onChange={(event) => set('contentBlocker', { mode: event.target.value as 'blocklist' | 'allowlist' })}><option value="blocklist">Block files that match</option><option value="allowlist">Block files that do not match</option></select></label>
        <label className="field">Refresh the list every (hours)<input type="number" min="1" max="168" value={blocker.refreshHours} onChange={(event) => set('contentBlocker', { refreshHours: event.target.value })} /></label>
        <label className="field wide-field">Pattern list URL <span>blank uses only the patterns below</span><input type="url" value={blocker.listUrl} onChange={(event) => set('contentBlocker', { listUrl: event.target.value })} placeholder={CLEANUPARR_BLOCKLIST_URL} /></label>
        <label className="field wide-field">Extra patterns <span>one per line: *.exe, *sample.mkv, or regex:…</span><textarea rows={3} value={blocker.patternsText} onChange={(event) => set('contentBlocker', { patternsText: event.target.value })} /></label>
      </div>
      <label className="check-row"><input type="checkbox" checked={blocker.ignorePrivate} onChange={(event) => set('contentBlocker', { ignorePrivate: event.target.checked })} />Ignore private-tracker torrents</label>
      <label className="check-row"><input type="checkbox" checked={blocker.removeWhenAllBlocked} onChange={(event) => set('contentBlocker', { removeWhenAllBlocked: event.target.checked })} />Remove and blocklist a torrent when every file is blocked</label>
      <label className="check-row"><input type="checkbox" checked={blocker.syncExcludedFileNames} onChange={(event) => set('contentBlocker', { syncExcludedFileNames: event.target.checked })} />Blocklist sync: copy the wildcard patterns into qBittorrent's own excluded file names (changes a qBittorrent preference)</label>
      <IgnoreEditor title="Content blocker ignore list" value={blocker.ignore} categories={categories} onChange={(ignore) => set('contentBlocker', { ignore })} />
    </section>

    <section className="settings-section">
      <FeatureHead chip="qBittorrent" title="Seeding cleanup" enabled={seeding.enabled} dryRun={seeding.dryRun}
        description="Removes finished torrents once their category's rule says they have seeded enough. Never touches an incomplete torrent or one Radarr/Sonarr has not imported yet."
        onEnabled={(enabled) => set('seedingCleanup', { enabled })} onDryRun={(dryRun) => set('seedingCleanup', { dryRun })} />
      <FeatureStatusLine status={status.seedingCleanup} formEnabled={seeding.enabled} formDryRun={seeding.dryRun} />
      <PreviewResult feature="seedingCleanup" />
      <div className="settings-grid three">
        <label className="field">Check every (minutes)<input type="number" min="1" max="1440" value={seeding.intervalMinutes} onChange={(event) => set('seedingCleanup', { intervalMinutes: event.target.value })} /></label>
      </div>
      <p className="field-hint">Leave a limit blank to turn it off. A maximum ratio of 0 removes a torrent as soon as it is finished and imported. Categories without a rule are never touched.</p>
      {seeding.rules.map((rule, index) => <div className="size-rule-row seeding-rule" key={`seeding-${index}`}>
        <label className="field">Category<select value={rule.category} onChange={(event) => updateRule(index, { category: event.target.value })}>
          {[...new Set([...categories, rule.category])].map((name) => <option key={name} value={name}>{name === '' ? 'Uncategorized' : name}</option>)}
        </select></label>
        <label className="field">Max ratio<input inputMode="decimal" value={rule.maxRatio} onChange={(event) => updateRule(index, { maxRatio: event.target.value })} placeholder="off" /></label>
        <label className="field">Min seed (h)<input inputMode="decimal" value={rule.minSeedHours} onChange={(event) => updateRule(index, { minSeedHours: event.target.value })} /></label>
        <label className="field">Max seed (h)<input inputMode="decimal" value={rule.maxSeedHours} onChange={(event) => updateRule(index, { maxSeedHours: event.target.value })} placeholder="off" /></label>
        <label className="field">Max inactive (days)<input inputMode="decimal" value={rule.maxInactiveDays} onChange={(event) => updateRule(index, { maxInactiveDays: event.target.value })} placeholder="off" /></label>
        <label className="field">Min seeders<input inputMode="numeric" value={rule.minSeeders} onChange={(event) => updateRule(index, { minSeeders: event.target.value })} /></label>
        <label className="check-row"><input type="checkbox" checked={rule.deleteFiles} onChange={(event) => updateRule(index, { deleteFiles: event.target.checked })} />Delete files</label>
        <button type="button" className="ghost-button compact" onClick={() => set('seedingCleanup', { rules: seeding.rules.filter((_, position) => position !== index) })}>Remove rule</button>
      </div>)}
      <button type="button" className="ghost-button compact" onClick={() => set('seedingCleanup', {
        rules: [...seeding.rules, { category: categories.find((name) => !seeding.rules.some((rule) => rule.category === name)) ?? '', maxRatio: '', minSeedHours: '0', maxSeedHours: '', maxInactiveDays: '', minSeeders: '0', deleteFiles: true }],
      })}>Add category rule</button>
      <p className="field-hint">Deleting files frees nothing while the library holds a hardlink, and is refused for any media file that is its own last copy unless Radarr/Sonarr recorded importing it.</p>
      <IgnoreEditor title="Seeding cleanup ignore list" value={seeding.ignore} categories={categories} onChange={(ignore) => set('seedingCleanup', { ignore })} />
    </section>

    <section className="settings-section">
      <FeatureHead chip="qBittorrent" title="Unlinked-torrent cleanup" enabled={unlinked.enabled} dryRun={unlinked.dryRun}
        description="Removes finished torrents whose media files are no longer hardlinked into any library, once Radarr/Sonarr has recorded importing them."
        onEnabled={(enabled) => set('unlinkedCleanup', { enabled })} onDryRun={(dryRun) => set('unlinkedCleanup', { dryRun })} />
      <FeatureStatusLine status={status.unlinkedCleanup} formEnabled={unlinked.enabled} formDryRun={unlinked.dryRun} />
      <PreviewResult feature="unlinkedCleanup" />
      <div className="settings-grid three">
        <label className="field">Check every (minutes)<input type="number" min="5" max="10080" value={unlinked.intervalMinutes} onChange={(event) => set('unlinkedCleanup', { intervalMinutes: event.target.value })} /></label>
        <label className="field">Finished at least (hours) ago<input type="number" min="0" max="8760" step="0.5" value={unlinked.minCompletedHours} onChange={(event) => set('unlinkedCleanup', { minCompletedHours: event.target.value })} /></label>
        <label className="field">Only with tags <span>comma separated; blank for any</span><input value={unlinked.tagsText} onChange={(event) => set('unlinkedCleanup', { tagsText: event.target.value })} /></label>
        <label className="field wide-field">Ignored folders <span>one local path per line</span><textarea rows={2} value={unlinked.ignoredRootsText} onChange={(event) => set('unlinkedCleanup', { ignoredRootsText: event.target.value })} /></label>
      </div>
      <CategoryChooser label="Only these categories" hint="None selected means every category." selected={unlinked.categories} categories={categories} onChange={(next) => set('unlinkedCleanup', { categories: next })} />
      <label className="check-row"><input type="checkbox" checked={unlinked.deleteFiles} onChange={(event) => set('unlinkedCleanup', { deleteFiles: event.target.checked })} />Delete the files too (this is what frees the space)</label>
      <IgnoreEditor title="Unlinked cleanup ignore list" value={unlinked.ignore} categories={categories} onChange={(ignore) => set('unlinkedCleanup', { ignore })} />
    </section>

    <section className="settings-section">
      <div className="settings-section-head"><div><p className="eyebrow">NOTIFICATIONS</p><h3>ntfy</h3></div></div>
      <div className="settings-grid three">
        <label className="field wide-field">Server and topic <span>for example https://ntfy.sh/your-topic</span><input type="url" value={ntfy.url} onChange={(event) => onNtfyChange({ ...ntfy, url: event.target.value })} placeholder={ntfy.urlConfigured ? 'Saved — leave blank to keep it' : 'https://ntfy.sh/…'} /></label>
        <label className="field">Access token <span>optional</span><input type="password" value={ntfy.token} onChange={(event) => onNtfyChange({ ...ntfy, token: event.target.value })} placeholder={ntfy.tokenConfigured ? 'Saved' : ''} autoComplete="off" /></label>
        <label className="field">Priority<select value={ntfy.priorityText} onChange={(event) => onNtfyChange({ ...ntfy, priorityText: event.target.value })}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      </div>
      <label className="check-row"><input type="checkbox" checked={ntfy.downloadEvents} onChange={(event) => onNtfyChange({ ...ntfy, downloadEvents: event.target.checked })} />Notify on removals and blocked content</label>
      <label className="check-row"><input type="checkbox" checked={ntfy.scanReports} onChange={(event) => onNtfyChange({ ...ntfy, scanReports: event.target.checked })} />Also send scheduled scan reports</label>
      {ntfy.urlConfigured && <label className="check-row"><input type="checkbox" checked={ntfy.clearUrl} onChange={(event) => onNtfyChange({ ...ntfy, clearUrl: event.target.checked })} />Remove saved ntfy topic</label>}
      {ntfy.tokenConfigured && <label className="check-row"><input type="checkbox" checked={ntfy.clearToken} onChange={(event) => onNtfyChange({ ...ntfy, clearToken: event.target.checked })} />Remove saved access token</label>}
      <div className="automation-actions"><button type="button" className="ghost-button compact" onClick={testNtfy} disabled={!ntfy.url.trim() && !ntfy.urlConfigured}>Send test notification</button>{ntfyMessage && <span role="status">{ntfyMessage}</span>}</div>
    </section>
  </>;
}
