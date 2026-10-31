/**
 * Phone-browser helpers: fullscreen + landscape lock where the browser allows it (Android Chrome, Samsung
 * Internet, Firefox Android), and honest fallbacks where it does not (iPhone Safari has no element fullscreen).
 * Every call must come from a user gesture (tap); browsers refuse otherwise.
 */

type LockableOrientation = ScreenOrientation & { lock?: (o: 'landscape') => Promise<void> };

export const isTouchDevice = (): boolean =>
  matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window || navigator.maxTouchPoints > 0;

export const isIOS = (): boolean =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS reports as a Mac

/** Running as an installed app (home-screen icon): no browser bars, so fullscreen is not needed. */
export const isStandalone = (): boolean =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

export const canFullscreen = (): boolean =>
  typeof document.documentElement.requestFullscreen === 'function' && document.fullscreenEnabled !== false;

export const isPortrait = (): boolean => window.innerHeight > window.innerWidth;

/**
 * Best effort: fullscreen, then lock to landscape. Resolves to true when the screen ended up landscape.
 * Never throws: on unsupported browsers it simply does nothing.
 */
export async function enterLandscapeFullscreen(): Promise<boolean> {
  try {
    if (canFullscreen() && !document.fullscreenElement && !isStandalone()) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
  } catch {
    /* refused (no gesture, iframe, browser policy) */
  }
  try {
    await (screen.orientation as LockableOrientation | undefined)?.lock?.('landscape');
  } catch {
    /* most browsers only allow locking while fullscreen; iOS never */
  }
  return !isPortrait();
}

/** On phones, try to switch to landscape fullscreen as part of the tap that starts a match. */
export function phoneMatchGesture(): void {
  if (!isTouchDevice()) return;
  void enterLandscapeFullscreen();
}
