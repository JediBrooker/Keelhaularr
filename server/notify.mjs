/**
 * Notifications for things the download automations did: a torrent removed and
 * blocklisted, or files set to "do not download". These go out as they happen, separate
 * from the scheduled scan report, and a notification that fails is logged and never
 * fails or repeats the action it describes.
 */
const REQUEST_TIMEOUT_MS = 15000;

const RULE_LABELS = {
  slow: 'slow download',
  stalled: 'stalled download',
  metadata: 'metadata timeout',
  'failed-import': 'failed import',
  'content-blocked': 'blocked content',
  seeding: 'seeding limit reached',
  unlinked: 'no longer in the library',
};

export function ruleLabel(rule) {
  return RULE_LABELS[rule] ?? rule;
}

/**
 * Splits https://ntfy.sh/my-topic into the server and the topic so the message can be
 * published as JSON. JSON avoids putting a title with non-Latin characters into an HTTP
 * header, which fetch refuses.
 */
export function ntfyTarget(url) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter(Boolean);
  const topic = segments.pop();
  if (!topic) throw new Error('The ntfy URL must end with a topic, for example https://ntfy.sh/my-topic.');
  parsed.pathname = `/${segments.join('/')}`;
  parsed.search = '';
  parsed.hash = '';
  return { server: parsed.toString().replace(/\/+$/, ''), topic };
}

export async function sendNtfy(ntfy, { title, message, tags = [], priority }) {
  if (!ntfy?.configured) return { status: 'not-configured' };
  const { server, topic } = ntfyTarget(ntfy.url);
  const response = await fetch(`${server}/`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      ...(ntfy.token ? { Authorization: `Bearer ${ntfy.token}` } : {}),
    },
    body: JSON.stringify({
      topic,
      title: String(title).slice(0, 250),
      message: String(message).slice(0, 4000),
      tags,
      priority: priority ?? ntfy.priority ?? 3,
    }),
  });
  if (!response.ok) throw new Error(`ntfy returned HTTP ${response.status}`);
  return { status: 'sent' };
}

async function postWebhook(schedule, title, message, payload) {
  let body;
  if (schedule.notificationType === 'discord') body = { content: `**${title}**\n${message}` };
  else if (schedule.notificationType === 'gotify') body = { title, message, priority: 5 };
  else body = { event: payload.event, title, message, ...payload };
  const response = await fetch(schedule.webhookUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Notification webhook returned HTTP ${response.status}`);
}

function describe(event) {
  const subject = event.title ?? 'A download';
  const why = event.reason ? ` ${event.reason}` : '';
  switch (event.kind) {
    case 'removed':
      return {
        title: `Removed: ${ruleLabel(event.rule)}`,
        message: `${subject} was removed${event.blocklisted ? ' and blocklisted' : ''}${event.searched ? '; a replacement search was queued' : ''}.${why}`,
        tags: ['wastebasket'],
      };
    case 'files-skipped':
      return {
        title: 'Blocked files skipped',
        message: `${subject}: ${event.fileCount} blocked file${event.fileCount === 1 ? '' : 's'} set to do not download.${why}`,
        tags: ['no_entry'],
      };
    default:
      return { title: 'Keelhaularr', message: `${subject}.${why}`, tags: [] };
  }
}

/** Sends one download event to every channel that wants it. Never throws. */
export async function notifyDownloadEvent(config, event) {
  const { title, message, tags } = describe(event);
  const results = {};
  if (config?.ntfy?.configured && config.ntfy.downloadEvents) {
    try {
      results.ntfy = await sendNtfy(config.ntfy, { title, message, tags });
    } catch (error) {
      results.ntfy = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
      console.error('ntfy notification failed:', results.ntfy.error);
    }
  }
  if (config?.schedule?.downloadEvents && config.schedule.webhookUrl) {
    try {
      await postWebhook(config.schedule, title, message, { event: `keelhaularr.download.${event.kind}`, download: event });
      results.webhook = { status: 'sent' };
    } catch (error) {
      results.webhook = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
      console.error('Download notification webhook failed:', results.webhook.error);
    }
  }
  return results;
}
