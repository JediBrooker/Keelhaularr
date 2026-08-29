import { FormEvent, useEffect, useRef, useState } from 'react';
import { DirectoryInput } from './DirectoryInput';
import { ModalDialog } from './ModalDialog';

type AppKind = 'radarr' | 'sonarr';
type TestKind = AppKind | 'qbittorrent';
type SettingsSectionKey = 'connections' | 'cleanup' | 'automation' | 'account' | 'system';

const settingsSectionLabels: Record<SettingsSectionKey, string> = {
  connections: 'Connections',
  cleanup: 'Cleanup rules',
  automation: 'Automation',
  account: 'Account',
  system: 'System',
};
const settingsSectionOrder: SettingsSectionKey[] = ['connections', 'cleanup', 'automation', 'account', 'system'];

interface PathMap {
  from: string;
  to: string;
}

interface QBittorrentRecoverySettings {
  enabled: boolean;
  slowSpeedKibPerSecond: number;
  slowMinutes: number;
  stalledMinutes: number;
  excludedCategories: string[];
}

interface QBittorrentCategory {
  name: string;
  savePath: string;
  synthetic?: boolean;
}

interface QBittorrentCategoryDiscovery {
  categories: QBittorrentCategory[];
  loading: boolean;
  loaded: boolean;
  error: string;
}

interface ConnectionSettings {
  url: string;
  apiKeyConfigured: boolean;
  maxMbPerMinuteOverride: number | null;
  toleranceGibOverride: number | null;
  useArrQualityDefinitions: boolean;
  includeUnmonitored: boolean;
  mediaRoots: string[];
  downloadRoots: string[];
  pathMaps: PathMap[];
}

interface QBittorrentSettings {
  url: string;
  username: string;
  passwordConfigured: boolean;
  pathMaps: PathMap[];
  recovery: QBittorrentRecoverySettings;
}

interface SettingsData {
  account: {
    username: string;
    passwordConfigured: boolean;
    sessionDays: number;
    cookieSecure: boolean;
  };
  defaults: {
    maxMbPerMinute: number;
    toleranceGib: number;
  };
  radarr: ConnectionSettings;
  sonarr: ConnectionSettings;
  qbittorrent: QBittorrentSettings;
  orphan: {
    trashDir: string;
    ignoreDirectories: string[];
    maxFiles: number;
    mediaExtensions: string[];
    hardlinkMinAgeHours: number;
    retentionDays: number;
  };
  schedule: {
    enabled: boolean;
    intervalHours: number;
    notificationType: 'generic' | 'discord' | 'gotify';
    webhookConfigured: boolean;
    notifyWhenClear: boolean;
  };
  server: {
    port: number;
    portManagedByDocker: boolean;
    storageRoots: string[];
  };
}

interface ConnectionForm {
  url: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  clearApiKey: boolean;
  maxMbPerMinuteOverride: string;
  toleranceGibOverride: string;
  useArrQualityDefinitions: boolean;
  includeUnmonitored: boolean;
  mediaRoots: string[];
  downloadRoots: string[];
  pathMapsText: string;
}

interface QBittorrentForm {
  url: string;
  username: string;
  password: string;
  passwordConfigured: boolean;
  clearPassword: boolean;
  pathMapsText: string;
  recovery: {
    enabled: boolean;
    slowSpeedKibPerSecond: string;
    slowMinutes: string;
    stalledMinutes: string;
    excludedCategories: string[];
  };
}

interface SettingsForm {
  account: {
    username: string;
    newPassword: string;
    passwordConfigured: boolean;
    sessionDays: string;
    cookieSecure: boolean;
    rotateSessions: boolean;
  };
  defaults: {
    maxMbPerMinute: string;
    toleranceGib: string;
  };
  radarr: ConnectionForm;
  sonarr: ConnectionForm;
  qbittorrent: QBittorrentForm;
  orphan: {
    trashDir: string;
    ignoreDirectoriesText: string;
    maxFiles: string;
    mediaExtensionsText: string;
    hardlinkMinAgeHours: string;
    retentionDays: string;
  };
  schedule: {
    enabled: boolean;
    intervalHours: string;
    notificationType: 'generic' | 'discord' | 'gotify';
    webhookUrl: string;
    webhookConfigured: boolean;
    clearWebhook: boolean;
    notifyWhenClear: boolean;
  };
  server: SettingsData['server'];
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

function connectionForm(settings: ConnectionSettings): ConnectionForm {
  return {
    url: settings.url,
    apiKey: '',
    apiKeyConfigured: settings.apiKeyConfigured,
    clearApiKey: false,
    maxMbPerMinuteOverride: settings.maxMbPerMinuteOverride?.toString() ?? '',
    toleranceGibOverride: settings.toleranceGibOverride?.toString() ?? '',
    useArrQualityDefinitions: settings.useArrQualityDefinitions,
    includeUnmonitored: settings.includeUnmonitored,
    mediaRoots: settings.mediaRoots,
    downloadRoots: settings.downloadRoots,
    pathMapsText: settings.pathMaps.map(({ from, to }) => `${from}=>${to}`).join('\n'),
  };
}

function qbittorrentForm(settings: QBittorrentSettings): QBittorrentForm {
  return {
    url: settings.url,
    username: settings.username,
    password: '',
    passwordConfigured: settings.passwordConfigured,
    clearPassword: false,
    pathMapsText: settings.pathMaps.map(({ from, to }) => `${from}=>${to}`).join('\n'),
    recovery: {
      enabled: settings.recovery.enabled,
      slowSpeedKibPerSecond: settings.recovery.slowSpeedKibPerSecond.toString(),
      slowMinutes: settings.recovery.slowMinutes.toString(),
      stalledMinutes: settings.recovery.stalledMinutes.toString(),
      excludedCategories: [...settings.recovery.excludedCategories],
    },
  };
}

function formFromSettings(settings: SettingsData): SettingsForm {
  return {
    account: {
      username: settings.account.username,
      newPassword: '',
      passwordConfigured: settings.account.passwordConfigured,
      sessionDays: settings.account.sessionDays.toString(),
      cookieSecure: settings.account.cookieSecure,
      rotateSessions: false,
    },
    defaults: {
      maxMbPerMinute: settings.defaults.maxMbPerMinute.toString(),
      toleranceGib: settings.defaults.toleranceGib.toString(),
    },
    radarr: connectionForm(settings.radarr),
    sonarr: connectionForm(settings.sonarr),
    qbittorrent: qbittorrentForm(settings.qbittorrent),
    orphan: {
      trashDir: settings.orphan.trashDir,
      ignoreDirectoriesText: settings.orphan.ignoreDirectories.join(', '),
      maxFiles: settings.orphan.maxFiles.toString(),
      mediaExtensionsText: settings.orphan.mediaExtensions.join(', '),
      hardlinkMinAgeHours: settings.orphan.hardlinkMinAgeHours.toString(),
      retentionDays: settings.orphan.retentionDays.toString(),
    },
    schedule: {
      enabled: settings.schedule.enabled,
      intervalHours: settings.schedule.intervalHours.toString(),
      notificationType: settings.schedule.notificationType,
      webhookUrl: '',
      webhookConfigured: settings.schedule.webhookConfigured,
      clearWebhook: false,
      notifyWhenClear: settings.schedule.notifyWhenClear,
    },
    server: settings.server,
  };
}

function listFromText(value: string, pattern: RegExp) {
  return value.split(pattern).map((item) => item.trim()).filter(Boolean);
}

function pathMapsFromText(value: string, label: string) {
  return listFromText(value, /\n/).map((line) => {
    const separator = line.indexOf('=>');
    if (separator <= 0 || separator === line.length - 2) {
      throw new Error(`${label} path maps must use /remote/path=>/container/path, one per line.`);
    }
    return { from: line.slice(0, separator).trim(), to: line.slice(separator + 2).trim() };
  });
}

function numeric(value: string, label: string) {
  const output = Number(value);
  if (!value.trim() || !Number.isFinite(output)) throw new Error(`${label} must be a number.`);
  return output;
}

function optionalNumeric(value: string, label: string) {
  return value.trim() ? numeric(value, label) : null;
}

function FolderList({ title, appLabel, hint, values, placeholder, addLabel, emptyMessage, onChange }: {
  title: string;
  appLabel: string;
  hint: string;
  values: string[];
  placeholder: string;
  addLabel: string;
  emptyMessage: string;
  onChange: (next: string[]) => void;
}) {
  const update = (index: number, value: string) => onChange(values.map((item, itemIndex) => itemIndex === index ? value : item));
  const remove = (index: number) => onChange(values.filter((_, itemIndex) => itemIndex !== index));
  return (
    <div className="folder-list wide-field">
      <div className="folder-list-heading"><div><strong>{title}</strong><span>{hint} · Type a path to browse</span></div><button type="button" className="add-path-button" onClick={() => onChange([...values, ''])}>+ {addLabel}</button></div>
      {values.length ? <div className="folder-rows">{values.map((value, index) => (
        <div className="folder-row" key={`${title}-${index}`}>
          <DirectoryInput value={value} onChange={(next) => update(index, next)} placeholder={placeholder} label={`${appLabel} ${title.toLowerCase()} ${index + 1}`} />
          <button type="button" onClick={() => remove(index)} aria-label={`Remove ${appLabel} ${title.toLowerCase()} ${index + 1}`}>Remove</button>
        </div>
      ))}</div> : <p className="empty-folder-list">{emptyMessage}</p>}
    </div>
  );
}

function ArrConnectionSection({ app, form, testing, testMessage, onChange, onTest }: {
  app: AppKind;
  form: ConnectionForm;
  testing: boolean;
  testMessage: string;
  onChange: (next: ConnectionForm) => void;
  onTest: () => void;
}) {
  const label = app === 'radarr' ? 'Radarr' : 'Sonarr';
  const update = <K extends keyof ConnectionForm>(key: K, value: ConnectionForm[K]) => onChange({ ...form, [key]: value });
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div><span className={`app-chip ${app}`}>{label}</span><h3>{label} connection</h3></div>
        <button type="button" className="ghost-button compact" onClick={onTest} disabled={testing || !form.url || form.clearApiKey}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      {testMessage && <p className={`connection-result ${testMessage.startsWith('Connected') ? 'success' : 'error'}`}>{testMessage}</p>}
      <div className="settings-grid two">
        <label className="field wide-field">Server URL<input type="url" value={form.url} onChange={(event) => update('url', event.target.value)} placeholder={`http://${app}:` + (app === 'radarr' ? '7878' : '8989')} /></label>
        <label className="field wide-field">API key<input type="password" value={form.apiKey} onChange={(event) => update('apiKey', event.target.value)} autoComplete="off" placeholder={form.apiKeyConfigured ? 'Saved — leave blank to keep it' : 'Enter API key'} /></label>
        {form.apiKeyConfigured && <label className="check-row wide-field"><input type="checkbox" checked={form.clearApiKey} onChange={(event) => update('clearApiKey', event.target.checked)} />Remove the saved {label} API key</label>}
        <FolderList title="Library folders" appLabel={label} hint={`Detected automatically when you test ${label}`} values={form.mediaRoots} placeholder={app === 'radarr' ? '/data/media/movies' : '/data/media/tv'} addLabel="Add manually" emptyMessage={`Test the ${label} connection to fill this automatically.`} onChange={(next) => update('mediaRoots', next)} />
        <FolderList title="Completed download folders" appLabel={label} hint="Folders whose completed imports may remain hardlinked" values={form.downloadRoots} placeholder={app === 'radarr' ? '/data/torrents/movies' : '/data/torrents/tv'} addLabel="Add folder" emptyMessage="No completed-download folders configured." onChange={(next) => update('downloadRoots', next)} />
        <details className="advanced-settings wide-field" open={Boolean(form.pathMapsText.trim())}>
          <summary>Advanced path mapping <span>Most installations leave this blank</span></summary>
          <div><p>Use this only when {label} reports one path but Keelhaularr sees the same folder under another path. Format each line as <code>/arr/path=&gt;/keelhaularr/path</code>.</p><label className="field">Mappings<textarea rows={2} value={form.pathMapsText} onChange={(event) => update('pathMapsText', event.target.value)} /></label></div>
        </details>
      </div>
    </section>
  );
}

function AppSizeRules({ app, form, defaultMax, defaultTolerance, onChange }: {
  app: AppKind;
  form: ConnectionForm;
  defaultMax: string;
  defaultTolerance: string;
  onChange: (next: ConnectionForm) => void;
}) {
  const label = app === 'radarr' ? 'Radarr' : 'Sonarr';
  const update = <K extends keyof ConnectionForm>(key: K, value: ConnectionForm[K]) => onChange({ ...form, [key]: value });
  return (
    <section className="settings-section size-rule-section">
      <div className="settings-section-head"><div><span className={`app-chip ${app}`}>{label}</span><h3>{label} size rules</h3></div></div>
      <div className="settings-grid two">
        <label className="check-row wide-field feature-toggle"><input type="checkbox" checked={form.useArrQualityDefinitions} onChange={(event) => update('useArrQualityDefinitions', event.target.checked)} /><span><strong>Use {label} quality-definition limits</strong><small>Use the maximum MB/min for each file’s quality when available.</small></span></label>
        <label className="field">MB/min fallback <span>{form.useArrQualityDefinitions ? `used when ${label} has no matching maximum` : `blank uses ${defaultMax}`}</span><input inputMode="decimal" value={form.maxMbPerMinuteOverride} onChange={(event) => update('maxMbPerMinuteOverride', event.target.value)} placeholder={defaultMax} /></label>
        <label className="field">Tolerance override (GiB) <span>blank uses {defaultTolerance}</span><input inputMode="decimal" value={form.toleranceGibOverride} onChange={(event) => update('toleranceGibOverride', event.target.value)} placeholder={defaultTolerance} /></label>
        <label className="check-row wide-field"><input type="checkbox" checked={form.includeUnmonitored} onChange={(event) => update('includeUnmonitored', event.target.checked)} />Include unmonitored media in size checks</label>
      </div>
    </section>
  );
}

function QBittorrentConnectionSection({
  form,
  testing,
  testMessage,
  onChange,
  onTest,
}: {
  form: QBittorrentForm;
  testing: boolean;
  testMessage: string;
  onChange: (next: QBittorrentForm) => void;
  onTest: () => void;
}) {
  const update = <K extends keyof QBittorrentForm>(key: K, value: QBittorrentForm[K]) => onChange({ ...form, [key]: value });
  const testSucceededSafely = testMessage.startsWith('Connected')
    && !testMessage.includes('need mapping')
    && !testMessage.includes('outside monitored folders');

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div><span className="app-chip qbittorrent">qBittorrent</span><h3>qBittorrent connection</h3></div>
        <button type="button" className="ghost-button compact" onClick={onTest} disabled={testing || !form.url || form.clearPassword}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      {testMessage && <p className={`connection-result ${testSucceededSafely ? 'success' : 'error'}`}>{testMessage}</p>}
      <div className="settings-grid two">
        <label className="field wide-field">Web UI URL<input type="url" value={form.url} onChange={(event) => update('url', event.target.value)} placeholder="http://qbittorrent:8080" /></label>
        <label className="field">Username<input value={form.username} onChange={(event) => update('username', event.target.value)} autoComplete="username" placeholder="admin" /></label>
        <label className="field">Password<input type="password" value={form.password} onChange={(event) => update('password', event.target.value)} autoComplete="new-password" placeholder={form.passwordConfigured ? 'Saved — leave blank to keep it' : 'Web UI password'} /></label>
        {form.passwordConfigured && <label className="check-row wide-field"><input type="checkbox" checked={form.clearPassword} onChange={(event) => update('clearPassword', event.target.checked)} />Remove the saved qBittorrent password</label>}
        <p className="field-hint wide-field">Incomplete torrents are excluded from completed-download orphan results. If qBittorrent cannot be checked safely, those results are withheld.</p>
        <details className="advanced-settings wide-field" open={Boolean(form.pathMapsText.trim())}>
          <summary>Path mapping <span>Required when qBittorrent reports different paths</span></summary>
          <div><p>Map the path qBittorrent reports to the same folder inside Keelhaularr. For example, <code>/downloads=&gt;/radarr-downloads</code>. This translates paths; it does not mount storage.</p><label className="field">Mappings<textarea rows={2} value={form.pathMapsText} onChange={(event) => update('pathMapsText', event.target.value)} /></label></div>
        </details>
      </div>
    </section>
  );
}

function QBittorrentRecoverySection({ form, categoryDiscovery, canRefreshCategories, onChange, onRefreshCategories }: {
  form: QBittorrentForm;
  categoryDiscovery: QBittorrentCategoryDiscovery;
  canRefreshCategories: boolean;
  onChange: (next: QBittorrentForm) => void;
  onRefreshCategories: () => void;
}) {
  const updateRecovery = <K extends keyof QBittorrentForm['recovery']>(key: K, value: QBittorrentForm['recovery'][K]) => onChange({
    ...form,
    recovery: { ...form.recovery, [key]: value },
  });
  const discoveredNames = new Set(categoryDiscovery.categories.map((category) => category.name));
  const categoryOptions: Array<QBittorrentCategory & { stale: boolean }> = [
    ...categoryDiscovery.categories.map((category) => ({ ...category, stale: false })),
    ...form.recovery.excludedCategories
      .filter((category) => !discoveredNames.has(category))
      .map((name) => ({ name, savePath: '', stale: true })),
  ];

  function toggleExcludedCategory(name: string, checked: boolean) {
    const selected = form.recovery.excludedCategories;
    updateRecovery('excludedCategories', checked
      ? selected.includes(name) ? selected : [...selected, name]
      : selected.filter((category) => category !== name));
  }

  return (
    <section className="settings-section">
      <div className="settings-section-head"><div><span className="app-chip qbittorrent">qBittorrent</span><h3>Automatic replacement</h3></div></div>
      <div className={`recovery-panel ${form.recovery.enabled ? 'enabled' : ''}`}>
        <label className="check-row feature-toggle recovery-toggle">
          <input type="checkbox" checked={form.recovery.enabled} onChange={(event) => updateRecovery('enabled', event.target.checked)} />
          <span><strong>Automatically replace slow or stalled downloads</strong><small>Off by default. Turning this off keeps the thresholds and exclusions below.</small></span>
        </label>
        <div className="recovery-warning">
          <strong>Destructive automation</strong>
          <p>For an eligible torrent, Keelhaularr removes the torrent and partial data through its Arr app, blocklists the release, confirms removal, then requests one replacement search.</p>
        </div>
        <div className="settings-grid three recovery-thresholds">
          <label className="field">Slow below (KiB/s) <span>0 disables slow-speed detection</span><input type="number" min="0" max="1048576" step="1" inputMode="numeric" value={form.recovery.slowSpeedKibPerSecond} onChange={(event) => updateRecovery('slowSpeedKibPerSecond', event.target.value)} /></label>
          <label className="field">Slow for (minutes)<input type="number" min="1" max="10080" step="1" inputMode="numeric" value={form.recovery.slowMinutes} onChange={(event) => updateRecovery('slowMinutes', event.target.value)} /></label>
          <label className="field">Stalled for (minutes)<input type="number" min="1" max="10080" step="1" inputMode="numeric" value={form.recovery.stalledMinutes} onChange={(event) => updateRecovery('stalledMinutes', event.target.value)} /></label>
        </div>
        <div className="category-picker" aria-labelledby="qbittorrent-recovery-categories-title">
          <div className="category-picker-head">
            <div><strong id="qbittorrent-recovery-categories-title">Exclude categories</strong><span>Downloads in selected categories are never removed automatically. Matching is exact.</span></div>
            <button type="button" className="ghost-button compact" onClick={onRefreshCategories} disabled={!canRefreshCategories || categoryDiscovery.loading} title={canRefreshCategories ? 'Reload categories from the saved qBittorrent connection' : 'Save the qBittorrent connection before refreshing'}>{categoryDiscovery.loading ? 'Refreshing…' : 'Refresh categories'}</button>
          </div>
          {categoryDiscovery.loading && <p className="category-state" role="status">Loading categories from qBittorrent…</p>}
          {categoryDiscovery.error && <p className="category-state error" role="alert">Could not load categories: {categoryDiscovery.error}</p>}
          {!categoryDiscovery.loading && !categoryDiscovery.error && categoryDiscovery.loaded && !categoryDiscovery.categories.length && <p className="category-state">qBittorrent reported no categories.</p>}
          {!categoryDiscovery.loading && !categoryDiscovery.loaded && !categoryOptions.length && <p className="category-state">Save or successfully test qBittorrent to discover categories.</p>}
          {categoryOptions.length > 0 && <div className="category-options">
            {categoryOptions.map((category, index) => {
              const label = category.name === '' ? 'Uncategorized' : category.name;
              const checked = form.recovery.excludedCategories.includes(category.name);
              return <label className={`category-option ${category.stale ? 'stale' : ''}`} key={`${category.name}\u0000${index}`} title={category.name === '' ? 'The exact empty qBittorrent category' : `Exact category: ${JSON.stringify(category.name)}`}>
                <input type="checkbox" checked={checked} onChange={(event) => toggleExcludedCategory(category.name, event.target.checked)} aria-label={`Exclude qBittorrent category ${category.name === '' ? 'Uncategorized (empty category)' : JSON.stringify(category.name)} from automatic replacement`} />
                <span><strong className="category-name">{label}</strong><small>{category.stale ? 'Saved exclusion · not currently reported by qBittorrent' : category.synthetic ? 'No qBittorrent category' : category.savePath ? `Save path: ${category.savePath}` : 'qBittorrent category'}</small></span>
              </label>;
            })}
          </div>}
        </div>
        <p className="field-hint recovery-proof">Automatic replacement requires a continuous observation window and exact torrent ownership. Ambiguous, changed, malformed, or unreachable state is left untouched.</p>
      </div>
    </section>
  );
}

export function SettingsDialog({ onboarding = false, onClose, onSaved, onConnectionTested }: {
  onboarding?: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onConnectionTested?: (app: TestKind) => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<SettingsSectionKey>('connections');
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [loadingError, setLoadingError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<TestKind | null>(null);
  const [testMessages, setTestMessages] = useState<Record<TestKind, string>>({ radarr: '', sonarr: '', qbittorrent: '' });
  const [savedQbittorrentConfigured, setSavedQbittorrentConfigured] = useState(false);
  const [categoryDiscovery, setCategoryDiscovery] = useState<QBittorrentCategoryDiscovery>({
    categories: [], loading: false, loaded: false, error: '',
  });

  useEffect(() => {
    api<{ settings: SettingsData }>('/api/settings')
      .then(({ settings }) => {
        setForm(formFromSettings(settings));
        const configured = Boolean(settings.qbittorrent.url);
        setSavedQbittorrentConfigured(configured);
        if (configured) void refreshQbittorrentCategories();
      })
      .catch((error) => setLoadingError(error instanceof Error ? error.message : String(error)));
  }, []);

  async function refreshQbittorrentCategories() {
    setCategoryDiscovery((current) => ({ ...current, loading: true, error: '' }));
    try {
      const result = await api<{ categories: QBittorrentCategory[] }>('/api/settings/qbittorrent/categories');
      setCategoryDiscovery({ categories: result.categories, loading: false, loaded: true, error: '' });
    } catch (error) {
      setCategoryDiscovery((current) => ({
        ...current,
        loading: false,
        loaded: true,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  function updateSection<K extends 'account' | 'defaults' | 'orphan' | 'schedule'>(section: K, next: SettingsForm[K]) {
    setForm((current) => current ? { ...current, [section]: next } : current);
  }

  function updateConnection(app: AppKind, next: ConnectionForm) {
    setForm((current) => current ? { ...current, [app]: next } : current);
  }

  function updateQbittorrent(next: QBittorrentForm) {
    setForm((current) => current ? { ...current, qbittorrent: next } : current);
  }

  async function testConnection(app: AppKind) {
    if (!form) return;
    setTesting(app);
    setTestMessages((current) => ({ ...current, [app]: '' }));
    try {
      const result = await api<{ connected: boolean; version: string | null; rootFolders: string[] }>('/api/settings/test', {
        method: 'POST',
        body: JSON.stringify({ app, url: form[app].url, apiKey: form[app].apiKey }),
      });
      const autoFilledRoots = Boolean(result.rootFolders.length && !form[app].mediaRoots.some((root) => root.trim()));
      const roots = result.rootFolders.length
        ? ` · ${result.rootFolders.join(', ')}${autoFilledRoots ? ' · added to media roots' : ''}`
        : ' · no media roots reported';
      if (autoFilledRoots) {
        setForm((current) => current && !current[app].mediaRoots.some((root) => root.trim())
          ? { ...current, [app]: { ...current[app], mediaRoots: result.rootFolders } }
          : current);
      }
      setTestMessages((current) => ({ ...current, [app]: `Connected${result.version ? ` · v${result.version}` : ''}${roots}` }));
      onConnectionTested?.(app);
    } catch (error) {
      setTestMessages((current) => ({ ...current, [app]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setTesting(null);
    }
  }

  async function testQbittorrent() {
    if (!form) return;
    setTesting('qbittorrent');
    setTestMessages((current) => ({ ...current, qbittorrent: '' }));
    try {
      const result = await api<{
        connected: boolean;
        version: string | null;
        totalTorrentCount: number;
        incompleteTorrentCount: number;
        unmappedIncompleteCount: number;
        outsideDownloadRootCount: number;
        categories: QBittorrentCategory[];
      }>('/api/settings/test', {
        method: 'POST',
        body: JSON.stringify({
          app: 'qbittorrent',
          url: form.qbittorrent.url,
          username: form.qbittorrent.username,
          password: form.qbittorrent.password,
          pathMaps: pathMapsFromText(form.qbittorrent.pathMapsText, 'qBittorrent'),
          downloadRoots: [...form.radarr.downloadRoots, ...form.sonarr.downloadRoots]
            .map((root) => root.trim()).filter(Boolean),
        }),
      });
      const incomplete = `${result.incompleteTorrentCount} incomplete of ${result.totalTorrentCount} torrent${result.totalTorrentCount === 1 ? '' : 's'}`;
      const mapping = result.unmappedIncompleteCount
        ? ` · ${result.unmappedIncompleteCount} path${result.unmappedIncompleteCount === 1 ? '' : 's'} need mapping`
        : '';
      const outside = result.outsideDownloadRootCount
        ? ` · ${result.outsideDownloadRootCount} path${result.outsideDownloadRootCount === 1 ? '' : 's'} outside monitored folders`
        : '';
      setCategoryDiscovery({ categories: result.categories, loading: false, loaded: true, error: '' });
      setTestMessages((current) => ({
        ...current,
        qbittorrent: `Connected${result.version ? ` · v${result.version}` : ''} · ${incomplete}${mapping}${outside}`,
      }));
      onConnectionTested?.('qbittorrent');
    } catch (error) {
      setTestMessages((current) => ({ ...current, qbittorrent: error instanceof Error ? error.message : String(error) }));
    } finally {
      setTesting(null);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setSaveError('');
    setSaved('');
    try {
      const connectionPayload = (app: AppKind) => ({
        url: form[app].url,
        apiKey: form[app].apiKey,
        clearApiKey: form[app].clearApiKey,
        maxMbPerMinuteOverride: optionalNumeric(form[app].maxMbPerMinuteOverride, `${app} MB/min override`),
        toleranceGibOverride: optionalNumeric(form[app].toleranceGibOverride, `${app} tolerance override`),
        useArrQualityDefinitions: form[app].useArrQualityDefinitions,
        includeUnmonitored: form[app].includeUnmonitored,
        mediaRoots: form[app].mediaRoots.map((root) => root.trim()).filter(Boolean),
        downloadRoots: form[app].downloadRoots.map((root) => root.trim()).filter(Boolean),
        pathMaps: pathMapsFromText(form[app].pathMapsText, app),
      });
      const result = await api<{ settings: SettingsData }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          account: {
            username: form.account.username,
            newPassword: form.account.newPassword,
            sessionDays: numeric(form.account.sessionDays, 'Session lifetime'),
            cookieSecure: form.account.cookieSecure,
            rotateSessions: form.account.rotateSessions,
          },
          defaults: {
            maxMbPerMinute: numeric(form.defaults.maxMbPerMinute, 'Default MB/min'),
            toleranceGib: numeric(form.defaults.toleranceGib, 'Default tolerance'),
          },
          radarr: connectionPayload('radarr'),
          sonarr: connectionPayload('sonarr'),
          qbittorrent: {
            url: form.qbittorrent.url,
            username: form.qbittorrent.username,
            password: form.qbittorrent.password,
            clearPassword: form.qbittorrent.clearPassword,
            pathMaps: pathMapsFromText(form.qbittorrent.pathMapsText, 'qBittorrent'),
            recovery: {
              enabled: form.qbittorrent.recovery.enabled,
              slowSpeedKibPerSecond: numeric(form.qbittorrent.recovery.slowSpeedKibPerSecond, 'qBittorrent slow-speed threshold'),
              slowMinutes: numeric(form.qbittorrent.recovery.slowMinutes, 'qBittorrent slow duration'),
              stalledMinutes: numeric(form.qbittorrent.recovery.stalledMinutes, 'qBittorrent stalled duration'),
              excludedCategories: [...form.qbittorrent.recovery.excludedCategories],
            },
          },
          orphan: {
            trashDir: form.orphan.trashDir,
            ignoreDirectories: listFromText(form.orphan.ignoreDirectoriesText, /[,\n]/),
            maxFiles: numeric(form.orphan.maxFiles, 'Maximum orphan scan files'),
            hardlinkMinAgeHours: numeric(form.orphan.hardlinkMinAgeHours, 'Minimum unlinked age'),
            mediaExtensions: listFromText(form.orphan.mediaExtensionsText, /[,\n]/),
            retentionDays: numeric(form.orphan.retentionDays, 'Quarantine retention'),
          },
          schedule: {
            enabled: form.schedule.enabled,
            intervalHours: numeric(form.schedule.intervalHours, 'Scheduled scan interval'),
            notificationType: form.schedule.notificationType,
            webhookUrl: form.schedule.webhookUrl,
            clearWebhook: form.schedule.clearWebhook,
            notifyWhenClear: form.schedule.notifyWhenClear,
          },
        }),
      });
      setForm(formFromSettings(result.settings));
      const configured = Boolean(result.settings.qbittorrent.url);
      setSavedQbittorrentConfigured(configured);
      if (configured) void refreshQbittorrentCategories();
      else setCategoryDiscovery({ categories: [], loading: false, loaded: false, error: '' });
      await onSaved();
      setSaved('Settings saved and applied immediately.');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  const availableSections = settingsSectionOrder.filter((value) => !onboarding || value !== 'account');

  return (
    <ModalDialog
      open
      labelledBy="settings-title"
      describedBy="settings-description"
      className="settings-modal"
      dialogRef={dialogRef}
      initialFocusRef={titleRef}
      onDismiss={onClose}
    >
      <section className="settings-dialog">
        <header className="settings-header">
          <div><p className="eyebrow gold">{onboarding ? 'FIRST VOYAGE SETUP' : 'CAPTAIN’S CONFIGURATION'}</p><h2 ref={titleRef} id="settings-title" tabIndex={-1}>{onboarding ? 'Connect your apps' : 'Settings'}</h2><p id="settings-description">{onboarding ? 'Add Radarr, Sonarr, qBittorrent, and the storage paths available to Keelhaularr.' : 'Configure connections, cleanup rules, automation, account access, and deployment details.'}</p></div>
          <button type="button" className="settings-close" onClick={() => dialogRef.current?.close()} aria-label="Close settings">×</button>
        </header>
        {loadingError ? <div className="settings-loading"><p className="notice error">{loadingError}</p></div> : !form ? <div className="settings-loading">Loading settings…</div> : (
          <form className="settings-form" onSubmit={submit}>
            <nav className="settings-navigation" aria-label="Settings sections">
              {availableSections.map((value) => <button
                id={`settings-nav-${value}`}
                type="button"
                key={value}
                className={section === value ? 'active' : ''}
                aria-current={section === value ? 'page' : undefined}
                onClick={() => setSection(value)}
              >{settingsSectionLabels[value]}</button>)}
            </nav>
            <div className="settings-scroll">
              {(saveError || saved) && <div className={`notice ${saveError ? 'error' : 'success'}`} role="status">{saveError || saved}</div>}
              <section className="settings-pane" aria-labelledby={`settings-nav-${section}`}>
                {section === 'connections' && <>
                  <ArrConnectionSection app="radarr" form={form.radarr} testing={testing === 'radarr'} testMessage={testMessages.radarr} onChange={(next) => updateConnection('radarr', next)} onTest={() => testConnection('radarr')} />
                  <ArrConnectionSection app="sonarr" form={form.sonarr} testing={testing === 'sonarr'} testMessage={testMessages.sonarr} onChange={(next) => updateConnection('sonarr', next)} onTest={() => testConnection('sonarr')} />
                  <QBittorrentConnectionSection form={form.qbittorrent} testing={testing === 'qbittorrent'} testMessage={testMessages.qbittorrent} onChange={updateQbittorrent} onTest={testQbittorrent} />
                </>}

                {section === 'cleanup' && <>
                  <section className="settings-section">
                    <div className="settings-section-head"><div><p className="eyebrow">DEFAULT SIZE RULES</p><h3>Default size limits</h3></div></div>
                    <div className="settings-grid two">
                      <label className="field">Maximum MB per minute<input inputMode="decimal" value={form.defaults.maxMbPerMinute} onChange={(event) => updateSection('defaults', { ...form.defaults, maxMbPerMinute: event.target.value })} /></label>
                      <label className="field">Size tolerance (GiB)<input inputMode="decimal" value={form.defaults.toleranceGib} onChange={(event) => updateSection('defaults', { ...form.defaults, toleranceGib: event.target.value })} /></label>
                    </div>
                  </section>
                  <AppSizeRules app="radarr" form={form.radarr} defaultMax={form.defaults.maxMbPerMinute} defaultTolerance={form.defaults.toleranceGib} onChange={(next) => updateConnection('radarr', next)} />
                  <AppSizeRules app="sonarr" form={form.sonarr} defaultMax={form.defaults.maxMbPerMinute} defaultTolerance={form.defaults.toleranceGib} onChange={(next) => updateConnection('sonarr', next)} />
                  <section className="settings-section">
                    <div className="settings-section-head"><div><span className="app-chip orphan">Untracked</span><h3>Untracked-file handling</h3></div></div>
                    <div className="settings-grid two">
                      <div className="field wide-field"><label htmlFor="quarantine-directory">Quarantine directory</label><span>Start typing to browse server folders</span><DirectoryInput id="quarantine-directory" label="Quarantine directory" value={form.orphan.trashDir} onChange={(value) => updateSection('orphan', { ...form.orphan, trashDir: value })} placeholder="/quarantine" allowNew /></div>
                      <label className="field wide-field">Ignored directory names <span>comma separated</span><textarea rows={2} value={form.orphan.ignoreDirectoriesText} onChange={(event) => updateSection('orphan', { ...form.orphan, ignoreDirectoriesText: event.target.value })} /></label>
                      <label className="field">Maximum files per scan<input type="number" min="1" max="1000000" value={form.orphan.maxFiles} onChange={(event) => updateSection('orphan', { ...form.orphan, maxFiles: event.target.value })} /></label>
                      <label className="field">Minimum unlinked age (hours) <span>allows completed imports to finish</span><input type="number" min="0" max="8760" step="0.5" value={form.orphan.hardlinkMinAgeHours} onChange={(event) => updateSection('orphan', { ...form.orphan, hardlinkMinAgeHours: event.target.value })} /></label>
                      <label className="field">Media extensions <span>comma separated</span><input value={form.orphan.mediaExtensionsText} onChange={(event) => updateSection('orphan', { ...form.orphan, mediaExtensionsText: event.target.value })} /></label>
                      <label className="field">Quarantine retention (days) <span>0 keeps files; a positive value permanently deletes expired quarantined files during maintenance</span><input type="number" min="0" max="3650" value={form.orphan.retentionDays} onChange={(event) => updateSection('orphan', { ...form.orphan, retentionDays: event.target.value })} /></label>
                    </div>
                  </section>
                </>}

                {section === 'automation' && <>
                  <QBittorrentRecoverySection form={form.qbittorrent} categoryDiscovery={categoryDiscovery} canRefreshCategories={savedQbittorrentConfigured} onChange={updateQbittorrent} onRefreshCategories={refreshQbittorrentCategories} />
                  <section className="settings-section">
                    <div className="settings-section-head"><div><p className="eyebrow">MAINTENANCE</p><h3>Schedule and notifications</h3></div></div>
                    <div className="settings-grid two">
                      <label className="check-row feature-toggle wide-field"><input type="checkbox" checked={form.schedule.enabled} onChange={(event) => updateSection('schedule', { ...form.schedule, enabled: event.target.checked })} /><span><strong>Run scheduled maintenance</strong><small>Maintenance scans for findings, applies configured quarantine retention, and may permanently delete expired quarantined files.</small></span></label>
                      <label className="field">Run every (hours)<input type="number" min="1" max="8760" value={form.schedule.intervalHours} onChange={(event) => updateSection('schedule', { ...form.schedule, intervalHours: event.target.value })} /></label>
                      <label className="field">Webhook format<select value={form.schedule.notificationType} onChange={(event) => updateSection('schedule', { ...form.schedule, notificationType: event.target.value as SettingsForm['schedule']['notificationType'] })}><option value="generic">Generic JSON</option><option value="discord">Discord</option><option value="gotify">Gotify</option></select></label>
                      <label className="field wide-field">Notification webhook URL<input type="url" value={form.schedule.webhookUrl} onChange={(event) => updateSection('schedule', { ...form.schedule, webhookUrl: event.target.value })} placeholder={form.schedule.webhookConfigured ? 'Saved — leave blank to keep it' : 'https://…'} /></label>
                      <p className="field-hint wide-field">After maintenance, Keelhaularr sends the selected payload format to this URL. Webhook failures are recorded in the maintenance report.</p>
                      {form.schedule.webhookConfigured && <label className="check-row"><input type="checkbox" checked={form.schedule.clearWebhook} onChange={(event) => updateSection('schedule', { ...form.schedule, clearWebhook: event.target.checked })} />Remove saved webhook</label>}
                      <label className="check-row"><input type="checkbox" checked={form.schedule.notifyWhenClear} onChange={(event) => updateSection('schedule', { ...form.schedule, notifyWhenClear: event.target.checked })} />Notify when no files are found</label>
                    </div>
                  </section>
                </>}

                {section === 'account' && !onboarding && <section className="settings-section">
                  <div className="settings-section-head"><div><p className="eyebrow">ACCESS CONTROL</p><h3>Account and sessions</h3></div></div>
                  <div className="settings-grid two">
                    <label className="field">Username<input value={form.account.username} onChange={(event) => updateSection('account', { ...form.account, username: event.target.value })} required /></label>
                    <label className="field">New password <span>blank keeps the current password</span><input type="password" value={form.account.newPassword} onChange={(event) => updateSection('account', { ...form.account, newPassword: event.target.value })} autoComplete="new-password" placeholder={form.account.passwordConfigured ? 'Current password is saved' : 'Set a password'} /></label>
                    <label className="field">Session lifetime (days)<input type="number" min="1" max="365" value={form.account.sessionDays} onChange={(event) => updateSection('account', { ...form.account, sessionDays: event.target.value })} /></label>
                    <div className="check-stack">
                      <label className="check-row"><input type="checkbox" checked={form.account.cookieSecure} onChange={(event) => updateSection('account', { ...form.account, cookieSecure: event.target.checked })} />Secure cookies (requires HTTPS)</label>
                      <label className="check-row"><input type="checkbox" checked={form.account.rotateSessions} onChange={(event) => updateSection('account', { ...form.account, rotateSessions: event.target.checked })} />Sign out all other active sessions when saving</label>
                    </div>
                  </div>
                </section>}

                {section === 'system' && <>
                  <section className="settings-section deployment-note">
                    <div><p className="eyebrow">DEPLOYMENT</p><h3>Server and storage</h3><p>Port <strong>{form.server.port}</strong> is {form.server.portManagedByDocker ? 'managed by the Docker deployment' : 'used by the Keelhaularr server'}.</p><p>Storage visible to Keelhaularr: <code>{form.server.storageRoots.length ? form.server.storageRoots.join(', ') : 'none detected'}</code>.</p></div>
                  </section>
                  <section className="settings-section deployment-note">
                    <div><p className="eyebrow">PERSISTENCE</p><h3>Saved configuration</h3><p>Saved values are written to the server’s private <code>config/settings.json</code> file and override bootstrap environment values. Passwords and API keys are not returned to the browser after saving.</p></div>
                  </section>
                </>}
              </section>
            </div>
            <footer className="settings-actions">
              <span>One save applies the values from every settings section.</span>
              <div><button type="button" className="ghost-button" onClick={() => dialogRef.current?.close()} disabled={saving}>{onboarding ? 'Finish later' : 'Close'}</button><button type="submit" className="primary-button" disabled={saving}>{saving ? 'Saving settings…' : onboarding ? 'Save setup' : 'Save all settings'}</button></div>
            </footer>
          </form>
        )}
      </section>
    </ModalDialog>
  );
}
