// Failed logins are throttled per client address, but that address is only as precise
// as the deployment allows: behind a reverse proxy without TRUST_PROXY every request
// arrives from the proxy and shares one bucket.
//
// That is why this slows guesses down instead of locking anyone out. A flat cut-off on
// a shared bucket is a denial of service against the administrator - ten wrong guesses
// from anywhere, repeated once a window, keep them out of their own server for as long
// as the attacker cares to continue. A delay that doubles costs an attacker everything
// and costs somebody who fumbled their password a fraction of a second.
const DEFAULTS = {
  windowMs: 15 * 60 * 1000,
  // Nobody mistypes a password five times and deserves to be punished for it.
  freeFailures: 5,
  firstDelayMs: 250,
  maxDelayMs: 8000,
  // Far past anything a person reaches, and only ever a refusal for the rest of the
  // window - never a permanent lock. Its job is to stop a sustained attack from
  // spending scrypt, not to protect the password, which the delay already does.
  hardLimit: 60,
  // An internet-facing deployment sees a new source address per guess, so tracking has
  // to shed expired clients rather than grow for the life of the process.
  maxTrackedClients: 2048,
};

export function createLoginThrottle(options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const failures = new Map();

  const recent = (key, now) => (failures.get(key) ?? [])
    .filter((timestamp) => now - timestamp < settings.windowMs);

  function prune(now) {
    if (failures.size <= settings.maxTrackedClients) return;
    for (const [key, timestamps] of failures) {
      if (now - timestamps[timestamps.length - 1] >= settings.windowMs) failures.delete(key);
    }
    while (failures.size > settings.maxTrackedClients) {
      failures.delete(failures.keys().next().value);
    }
  }

  return {
    /** True once a client has failed so often that answering it at all is not worth the cost. */
    refuses(key, now = Date.now()) {
      return recent(key, now).length >= settings.hardLimit;
    },

    /**
     * Records a failure and returns how long the answer to it should be held back.
     *
     * The delay is charged to the failure rather than to the attempt, so somebody who
     * mistypes their password and then gets it right is not made to serve the penalty
     * their own typos earned. The timing reveals nothing the status code does not.
     */
    fail(key, now = Date.now()) {
      const before = recent(key, now);
      failures.set(key, [...before, now]);
      prune(now);
      if (before.length < settings.freeFailures) return 0;
      const steps = before.length - settings.freeFailures;
      return Math.min(settings.firstDelayMs * 2 ** steps, settings.maxDelayMs);
    },

    /** A correct password clears the record, so the next mistake starts from zero. */
    succeed(key) {
      failures.delete(key);
    },

    get size() {
      return failures.size;
    },
  };
}
