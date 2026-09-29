// Offline-Betrieb und Installation als App (Progressive Web App).
// Registriert den Service Worker, meldet neue Versionen und merkt sich die
// Installationsmöglichkeit des Browsers, damit die Übersicht einen Knopf zeigen kann.

const listeners = new Set();
let deferredPrompt = null;

const notify = () => listeners.forEach(fn => fn());

/** Re-render hook for the UI. */
export function onInstallChange(fn) {
  listeners.add(fn);
}

export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const canPromptInstall = () => deferredPrompt !== null;

export async function promptInstall() {
  if (!deferredPrompt) return false;
  const event = deferredPrompt;
  deferredPrompt = null;
  event.prompt();
  const { outcome } = await event.userChoice;
  notify();
  return outcome === 'accepted';
}

addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); // show our own button instead of the mini-infobar
  deferredPrompt = e;
  notify();
});
addEventListener('appinstalled', () => { deferredPrompt = null; notify(); });

function showUpdate(worker) {
  const bar = document.getElementById('update');
  const button = document.getElementById('update-reload');
  if (!bar || !button) return;
  bar.hidden = false;
  button.onclick = () => {
    button.disabled = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  };
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Only after the user chose "Jetzt aktualisieren": the running exam is saved in localStorage.
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdate(worker);
        });
      });
      // Look for a new version whenever the app comes back to the foreground.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    } catch {
      // Offline mode is a bonus: the site works without it.
    }
  });
}
