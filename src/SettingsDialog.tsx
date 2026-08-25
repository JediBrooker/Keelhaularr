import { FormEvent, useEffect, useState } from 'react';

type AppKind = 'radarr' | 'sonarr';

interface PathMap {
  from: string;
  to: string;
}

interface ConnectionSettings {
  url: string;
  apiKeyConfigured: boolean;
  maxMbPerMinuteOverride: number | null;
  toleranceGibOverride: number | null;
  includeUnmonitored: boolean;
  mediaRoots: string[];
  downloadRoots: string[];
  pathMaps: PathMap[];
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
  orphan: {
    action: 'quarantine' | 'permanent';
    trashDir: string;
    allowPermanentDelete: boolean;
    ignoreDirectories: string[];
    maxFiles: number;
    mediaExtensions: string[];
    hardlinkMinAgeHours: number;
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
  includeUnmonitored: boolean;
  mediaRoots: string[];
  downloadRoots: string[];
  pathMapsText: string;
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
  orphan: {
    action: 'quarantine' | 'permanent';
    trashDir: string;
    allowPermanentDelete: boolean;
    ignoreDirectoriesText: string;
    maxFiles: string;
    mediaExtensionsText: string;
    hardlinkMinAgeHours: string;
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
    includeUnmonitored: settings.includeUnmonitored,
    mediaRoots: settings.mediaRoots,
    downloadRoots: settings.downloadRoots,
    pathMapsText: settings.pathMaps.map(({ from, to }) => `${from}=>${to}`).join('\n'),
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
    orphan: {
      action: settings.orphan.action,
      trashDir: settings.orphan.trashDir,
      allowPermanentDelete: settings.orphan.allowPermanentDelete,
      ignoreDirectoriesText: settings.orphan.ignoreDirectories.join(', '),
      maxFiles: settings.orphan.maxFiles.toString(),
      mediaExtensionsText: settings.orphan.mediaExtensions.join(', '),
      hardlinkMinAgeHours: settings.orphan.hardlinkMinAgeHours.toString(),
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
      throw new Error(`${label} path maps must use /arr/path=>/container/path, one per line.`);
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

function FolderList({ title, hint, values, placeholder, addLabel, emptyMessage, onChange }: {
  title: string;
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
      <div className="folder-list-heading"><div><strong>{title}</strong><span>{hint}</span></div><button type="button" className="add-path-button" onClick={() => onChange([...values, ''])}>+ {addLabel}</button></div>
      {values.length ? <div className="folder-rows">{values.map((value, index) => (
        <div className="folder-row" key={`${title}-${index}`}>
          <input value={value} onChange={(event) => update(index, event.target.value)} placeholder={placeholder} aria-label={`${title} ${index + 1}`} />
          <button type="button" onClick={() => remove(index)} aria-label={`Remove ${title.toLowerCase()} ${index + 1}`}>Remove</button>
        </div>
      ))}</div> : <p className="empty-folder-list">{emptyMessage}</p>}
    </div>
  );
}

function ConnectionSection({ app, form, defaultMax, defaultTolerance, testing, testMessage, onChange, onTest }: {
  app: AppKind;
  form: ConnectionForm;
  defaultMax: string;
  defaultTolerance: string;
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
        <label className="field">MB/min override <span>blank uses {defaultMax}</span><input inputMode="decimal" value={form.maxMbPerMinuteOverride} onChange={(event) => update('maxMbPerMinuteOverride', event.target.value)} placeholder={defaultMax} /></label>
        <label className="field">Tolerance override (GiB) <span>blank uses {defaultTolerance}</span><input inputMode="decimal" value={form.toleranceGibOverride} onChange={(event) => update('toleranceGibOverride', event.target.value)} placeholder={defaultTolerance} /></label>
        <label className="check-row wide-field"><input type="checkbox" checked={form.includeUnmonitored} onChange={(event) => update('includeUnmonitored', event.target.checked)} />Include unmonitored media in oversize checks</label>
        <FolderList title="Library folders" hint={`Detected automatically when you test ${label}`} values={form.mediaRoots} placeholder={app === 'radarr' ? '/data/media/movies' : '/data/media/tv'} addLabel="Add manually" emptyMessage={`Test the ${label} connection to fill this automatically.`} onChange={(next) => update('mediaRoots', next)} />
        <FolderList title="Completed download folders" hint="Torrent folders; add Usenet only when its imports remain hardlinked" values={form.downloadRoots} placeholder={app === 'radarr' ? '/data/torrents/movies' : '/data/torrents/tv'} addLabel="Add folder" emptyMessage="No hardlink-watch folders added. This feature is optional." onChange={(next) => update('downloadRoots', next)} />
        <p className="field-hint wide-field">Only completed files older than the minimum age and without a matching library hardlink are flagged.</p>
        <details className="advanced-settings wide-field" open={Boolean(form.pathMapsText.trim())}>
          <summary>Advanced path mapping <span>Most installations leave this blank</span></summary>
          <div><p>Use this only when {label} reports one path but Keelhaularr sees the same folder under another path. Format each line as <code>/arr/path=&gt;/keelhaularr/path</code>.</p><label className="field">Mappings<textarea rows={2} value={form.pathMapsText} onChange={(event) => update('pathMapsText', event.target.value)} /></label></div>
        </details>
      </div>
    </section>
  );
}

export function SettingsDialog({ onboarding = false, onClose, onSaved }: { onboarding?: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [loadingError, setLoadingError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<AppKind | null>(null);
  const [testMessages, setTestMessages] = useState<Record<AppKind, string>>({ radarr: '', sonarr: '' });

  useEffect(() => {
    api<{ settings: SettingsData }>('/api/settings')
      .then(({ settings }) => setForm(formFromSettings(settings)))
      .catch((error) => setLoadingError(error instanceof Error ? error.message : String(error)));
  }, []);

  function updateSection<K extends 'account' | 'defaults' | 'orphan'>(section: K, next: SettingsForm[K]) {
    setForm((current) => current ? { ...current, [section]: next } : current);
  }

  function updateConnection(app: AppKind, next: ConnectionForm) {
    setForm((current) => current ? { ...current, [app]: next } : current);
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
    } catch (error) {
      setTestMessages((current) => ({ ...current, [app]: error instanceof Error ? error.message : String(error) }));
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
          orphan: {
            action: form.orphan.action,
            trashDir: form.orphan.trashDir,
            allowPermanentDelete: form.orphan.allowPermanentDelete,
            ignoreDirectories: listFromText(form.orphan.ignoreDirectoriesText, /[,\n]/),
            maxFiles: numeric(form.orphan.maxFiles, 'Maximum orphan scan files'),
            hardlinkMinAgeHours: numeric(form.orphan.hardlinkMinAgeHours, 'Minimum unlinked age'),
            mediaExtensions: listFromText(form.orphan.mediaExtensionsText, /[,\n]/),
          },
        }),
      });
      setForm(formFromSettings(result.settings));
      await onSaved();
      setSaved('Settings saved and applied immediately.');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-backdrop" role="presentation">
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-header">
          <div><p className="eyebrow gold">{onboarding ? 'FIRST VOYAGE SETUP' : 'CAPTAIN’S CONFIGURATION'}</p><h2 id="settings-title">{onboarding ? 'Connect your fleet' : 'Standing orders'}</h2><p>{onboarding ? 'Add Radarr, Sonarr, and their storage paths here. You can leave either application blank.' : 'Manage every Keelhaularr application setting. Secrets stay server-side.'}</p></div>
          <button type="button" className="settings-close" onClick={onClose} aria-label="Close settings">×</button>
        </header>
        {loadingError ? <div className="settings-loading"><p className="notice error">{loadingError}</p></div> : !form ? <div className="settings-loading">Reading the captain’s log…</div> : (
          <form className="settings-form" onSubmit={submit}>
            <div className="settings-scroll">
              {(saveError || saved) && <div className={`notice ${saveError ? 'error' : 'success'}`} role="status">{saveError || saved}</div>}

              {!onboarding && <section className="settings-section">
                <div className="settings-section-head"><div><p className="eyebrow">ACCESS CONTROL</p><h3>Account & sessions</h3></div></div>
                <div className="settings-grid two">
                  <label className="field">Login username<input value={form.account.username} onChange={(event) => updateSection('account', { ...form.account, username: event.target.value })} required /></label>
                  <label className="field">New password <span>blank keeps the current password</span><input type="password" value={form.account.newPassword} onChange={(event) => updateSection('account', { ...form.account, newPassword: event.target.value })} autoComplete="new-password" placeholder={form.account.passwordConfigured ? 'Current password is saved' : 'Set a password'} /></label>
                  <label className="field">Session lifetime (days)<input type="number" min="1" max="365" value={form.account.sessionDays} onChange={(event) => updateSection('account', { ...form.account, sessionDays: event.target.value })} /></label>
                  <div className="check-stack">
                    <label className="check-row"><input type="checkbox" checked={form.account.cookieSecure} onChange={(event) => updateSection('account', { ...form.account, cookieSecure: event.target.checked })} />Secure cookies (requires HTTPS)</label>
                    <label className="check-row"><input type="checkbox" checked={form.account.rotateSessions} onChange={(event) => updateSection('account', { ...form.account, rotateSessions: event.target.checked })} />Sign out every other active session</label>
                  </div>
                </div>
              </section>}

              <section className="settings-section">
                <div className="settings-section-head"><div><p className="eyebrow">DEFAULT SIZE RULES</p><h3>Oversize limits</h3></div></div>
                <div className="settings-grid two">
                  <label className="field">Maximum MB per minute<input inputMode="decimal" value={form.defaults.maxMbPerMinute} onChange={(event) => updateSection('defaults', { ...form.defaults, maxMbPerMinute: event.target.value })} /></label>
                  <label className="field">Oversize tolerance (GiB)<input inputMode="decimal" value={form.defaults.toleranceGib} onChange={(event) => updateSection('defaults', { ...form.defaults, toleranceGib: event.target.value })} /></label>
                </div>
              </section>

              <ConnectionSection app="radarr" form={form.radarr} defaultMax={form.defaults.maxMbPerMinute} defaultTolerance={form.defaults.toleranceGib} testing={testing === 'radarr'} testMessage={testMessages.radarr} onChange={(next) => updateConnection('radarr', next)} onTest={() => testConnection('radarr')} />
              <ConnectionSection app="sonarr" form={form.sonarr} defaultMax={form.defaults.maxMbPerMinute} defaultTolerance={form.defaults.toleranceGib} testing={testing === 'sonarr'} testMessage={testMessages.sonarr} onChange={(next) => updateConnection('sonarr', next)} onTest={() => testConnection('sonarr')} />

              <section className="settings-section">
                <div className="settings-section-head"><div><span className="app-chip orphan">Orphans</span><h3>Orphan handling</h3></div></div>
                <div className="settings-grid two">
                  <label className="field">Action<select value={form.orphan.action} onChange={(event) => updateSection('orphan', { ...form.orphan, action: event.target.value as 'quarantine' | 'permanent' })}><option value="quarantine">Quarantine (recommended)</option><option value="permanent">Permanent deletion</option></select></label>
                  <label className="field">Quarantine directory<input value={form.orphan.trashDir} onChange={(event) => updateSection('orphan', { ...form.orphan, trashDir: event.target.value })} placeholder="/quarantine" /></label>
                  <label className={`check-row danger-check wide-field ${form.orphan.action === 'permanent' ? 'active' : ''}`}><input type="checkbox" checked={form.orphan.allowPermanentDelete} onChange={(event) => updateSection('orphan', { ...form.orphan, allowPermanentDelete: event.target.checked })} />Explicitly allow irreversible orphan deletion</label>
                  <label className="field wide-field">Ignored directory names <span>comma separated</span><textarea rows={2} value={form.orphan.ignoreDirectoriesText} onChange={(event) => updateSection('orphan', { ...form.orphan, ignoreDirectoriesText: event.target.value })} /></label>
                  <label className="field">Maximum files per orphan scan<input type="number" min="1" max="1000000" value={form.orphan.maxFiles} onChange={(event) => updateSection('orphan', { ...form.orphan, maxFiles: event.target.value })} /></label>
                  <label className="field">Minimum unlinked age (hours) <span>allows completed imports to settle</span><input type="number" min="0" max="8760" step="0.5" value={form.orphan.hardlinkMinAgeHours} onChange={(event) => updateSection('orphan', { ...form.orphan, hardlinkMinAgeHours: event.target.value })} /></label>
                  <label className="field">Media extensions <span>comma separated</span><input value={form.orphan.mediaExtensionsText} onChange={(event) => updateSection('orphan', { ...form.orphan, mediaExtensionsText: event.target.value })} /></label>
                </div>
              </section>

              <section className="settings-section deployment-note">
                <div><p className="eyebrow">DEPLOYMENT</p><h3>Container access</h3><p>Port <strong>{form.server.port}</strong> is published by Docker Compose. Storage visible to this setup: <code>{form.server.storageRoots.length ? form.server.storageRoots.join(', ') : 'none detected'}</code>.</p></div>
              </section>
            </div>
            <footer className="settings-actions">
              <span>Saved settings override the bootstrap <code>.env</code> and survive updates.</span>
              <div><button type="button" className="ghost-button" onClick={onClose} disabled={saving}>{onboarding ? 'Finish later' : 'Close'}</button><button type="submit" className="primary-button" disabled={saving}>{saving ? 'Saving orders…' : onboarding ? 'Save setup' : 'Save all settings'}</button></div>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}
