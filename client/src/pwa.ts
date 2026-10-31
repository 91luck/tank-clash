/**
 * Installable app + offline practice.
 * The service worker is registered only in production builds on a secure origin (https or localhost),
 * so development and tests never see stale cached files.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function registerPwa(installButton: HTMLElement): void {
  if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* offline support is a bonus; the game works without it */
      });
    });
  }

  let deferred: InstallPromptEvent | null = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    installButton.hidden = false;
  });
  installButton.addEventListener('click', async () => {
    if (!deferred) return;
    installButton.hidden = true;
    await deferred.prompt();
    deferred = null;
  });
  window.addEventListener('appinstalled', () => {
    installButton.hidden = true;
  });
}
