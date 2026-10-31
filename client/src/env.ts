/** Deployment-specific URLs. Nothing here hardcodes localhost in production builds. */

export function wsUrl(loc: Pick<Location, 'protocol' | 'hostname' | 'host'> = window.location): string {
  const explicit = import.meta.env.VITE_WS_URL;
  if (explicit) return explicit;
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
  // Dev: Vite serves the page, the game server runs separately on :8080.
  if (import.meta.env.DEV) return `${scheme}://${loc.hostname}:8080/ws`;
  // Production without VITE_WS_URL: the server also serves this page (single-host deployment).
  return `${scheme}://${loc.host}/ws`;
}

/** HTTP base of the backend, used for the /health wake-up ping. */
export function httpBase(): string {
  return wsUrl().replace(/^ws/, 'http').replace(/\/ws$/, '');
}

export function publicOrigin(): string {
  return import.meta.env.VITE_PUBLIC_ORIGIN || window.location.origin;
}

export function inviteLink(code: string): string {
  return `${publicOrigin().replace(/\/$/, '')}/join/${encodeURIComponent(code)}`;
}
