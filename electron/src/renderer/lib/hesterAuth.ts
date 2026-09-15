/**
 * Attach the shared Lee/Hester bearer token to every renderer request that
 * goes to the Hester daemon.
 *
 * The daemon now requires `Authorization: Bearer <~/.lee/api-token>` on every
 * endpoint except `GET /health`. Rather than thread the token through a dozen
 * components (App, CommandPalette, LibraryPane, the workstream panes, ...),
 * we wrap `window.fetch` once here: any request to the daemon origin gets the
 * header, including ones added later.
 *
 * The token comes from the main process (`window.lee.getApiToken()`), which
 * reads it from the api-server that persists it — so renderer and daemon can
 * never disagree about which token is current.
 */

const DAEMON_PORT = 9000;
const DAEMON_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

let tokenPromise: Promise<string | null> | null = null;
let cachedToken: string | null = null;
let installed = false;

/** Fetch (and memoize) the token from the main process. */
export function getApiToken(): Promise<string | null> {
  if (cachedToken !== null) return Promise.resolve(cachedToken);
  if (!tokenPromise) {
    tokenPromise = Promise.resolve(window.lee?.getApiToken?.() ?? null)
      .then((token: string | null) => {
        cachedToken = token || null;
        return cachedToken;
      })
      .catch(() => null);
  }
  return tokenPromise;
}

function isDaemonUrl(input: RequestInfo | URL): boolean {
  try {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const url = new URL(raw, window.location.href);
    return DAEMON_HOSTS.has(url.hostname) && url.port === String(DAEMON_PORT);
  } catch {
    // Not a parseable URL - just means "not a daemon URL", not an error.
    return false;
  }
}

/**
 * Install the fetch wrapper. Safe to call more than once.
 */
export function installHesterAuth(): void {
  if (installed) return;
  installed = true;

  // Warm the cache so the first daemon call doesn't pay an extra IPC round-trip.
  void getApiToken();

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isDaemonUrl(input)) {
      return originalFetch(input, init);
    }

    const token = await getApiToken();
    if (!token) {
      return originalFetch(input, init);
    }

    // Don't clobber an Authorization header a caller set deliberately.
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    return originalFetch(input, { ...init, headers });
  };
}
