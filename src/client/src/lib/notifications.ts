// Lightweight OS notifications for "answer complete" and "input needed" events.
//
// Implemented with the Notification API surfaced through a MINIMAL service worker
// (registration.showNotification). A service worker is required on Android and on
// installed PWAs, where the bare `new Notification()` constructor is unsupported;
// on desktop we fall back to the constructor. This is intentionally NOT Web Push:
// there is no VAPID key and no server-side subscription, so notifications fire only
// while the page (or its backgrounded PWA) is still alive and connected over SSE.
//
// Every notification is gated on the document being hidden/unfocused, so we never
// interrupt the owner while they're actively looking at the screen — the in-app UI
// (streamed answer, prompt modal) already covers that case.

let swReg: ServiceWorkerRegistration | null = null;

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

// Register the minimal service worker once at boot. Safe to call when unsupported.
export function initNotifications(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register("/sw.js")
    .then((reg) => {
      swReg = reg;
    })
    .catch(() => {
      // SW registration is best-effort; the desktop `new Notification()` fallback
      // still works without it.
    });
}

// Ask for permission — must run from a user gesture (we call it on send). Idempotent:
// only prompts while the permission is still "default".
export async function ensureNotificationPermission(): Promise<void> {
  if (!notificationsSupported() || Notification.permission !== "default") return;
  try {
    await Notification.requestPermission();
  } catch {
    // Very old browsers only support the callback form; ignore — they just won't notify.
  }
}

// Show an OS notification, but only when the owner isn't actively viewing the app.
export function osNotify(title: string, body: string, tag?: string): void {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  const hidden =
    typeof document === "undefined" || document.visibilityState !== "visible" || !document.hasFocus();
  if (!hidden) return;
  const options: NotificationOptions & { renotify?: boolean } = {
    body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag,
    renotify: Boolean(tag),
  };
  try {
    if (swReg?.showNotification) {
      void swReg.showNotification(title, options);
    } else {
      const note = new Notification(title, options);
      note.onclick = () => {
        window.focus();
        note.close();
      };
    }
  } catch {
    // Some platforms throw on the bare constructor (e.g. Android without an active
    // SW). Nothing else to do — silently skip.
  }
}
