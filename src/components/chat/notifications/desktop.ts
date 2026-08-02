// The browser's half of a notification: permission, and the toast itself.
//
// Deliberately small, and deliberately the only place in Chat that touches
// `window.Notification`. Two properties are worth the file existing:
//
//   - **One in-flight permission request, shared.** `requestPermission()` opens
//     a modal browser prompt; calling it twice while the first is open resolves
//     one of them with a stale answer, and on some engines the second call is
//     ignored entirely. A settings screen with a switch and an onboarding nudge
//     can easily ask twice.
//   - **`silent: true`.** Chat plays its own sound (`sound.ts`, per slot), so
//     letting the OS play one too means two noises for one message — and the
//     one the user chose is the quieter of the two.
//
// The permission state carries a fourth value, `"unsupported"`, rather than
// pretending an environment without the API is "denied". They read the same to
// the predicate and completely differently to a person: one is a setting they
// can change and one is a browser they would have to replace.

import type { NotificationPermissionState } from "@/lib/buzz/notify";

export type { NotificationPermissionState };

/** What the platform currently says. Cheap; safe to call on every render. */
export function currentPermission(): NotificationPermissionState {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return "unsupported";
  }
  return Notification.permission as NotificationPermissionState;
}

let inFlight: Promise<NotificationPermissionState> | null = null;

/**
 * Ask, once, however many callers ask at once.
 *
 * Only meaningful from `"default"`. From `"denied"` the browser will not
 * re-prompt — that is the point of denial — so this returns the denial rather
 * than opening a prompt the user has already answered.
 */
export async function requestPermission(): Promise<NotificationPermissionState> {
  const current = currentPermission();
  if (current !== "default") return current;
  if (inFlight) return await inFlight;
  inFlight = (async () => {
    try {
      return (await Notification.requestPermission()) as NotificationPermissionState;
    } catch {
      return "unsupported";
    } finally {
      inFlight = null;
    }
  })();
  return await inFlight;
}

/** The two sentences §7.3 specifies, verbatim, for the two ways this fails. */
export const PERMISSION_BLOCKED_MESSAGE =
  "Desktop notifications are blocked for this site. Enable them in your browser or system settings to turn alerts on.";
export const PERMISSION_UNSUPPORTED_MESSAGE =
  "Desktop notifications are unavailable in this environment.";

export function permissionMessage(state: NotificationPermissionState): string | null {
  if (state === "denied") return PERMISSION_BLOCKED_MESSAGE;
  if (state === "unsupported") return PERMISSION_UNSUPPORTED_MESSAGE;
  return null;
}

/**
 * Where a notification click should land.
 *
 * Carried as data rather than a closure because a notification outlives the
 * render that created it — the tab can be reloaded between showing one and
 * clicking it, and a captured callback is gone by then. A target with neither
 * a channel nor an event is rejected: it would open the app and then have
 * nowhere to go, which reads as a click that did nothing.
 */
export type DesktopNotificationTarget = {
  channelId?: string;
  channelName?: string;
  eventId?: string;
  threadRootId?: string;
};

export function isNavigableTarget(target: DesktopNotificationTarget): boolean {
  return Boolean(target.channelId || target.eventId);
}

/** The href a target opens. Null when there is nowhere to go. */
export function hrefForTarget(target: DesktopNotificationTarget): string | null {
  if (!target.channelId) return null;
  const base = `/chat/c/${target.channelId}`;
  return target.threadRootId ? `${base}?thread=${target.threadRootId}` : base;
}

/**
 * Show one. Returns whether it was actually shown — the caller plays its sound
 * **only** on true, so a blocked notification is silent rather than a noise
 * with nothing attached to it.
 */
export function sendDesktopNotification(opts: {
  title: string;
  body: string;
  tag?: string;
  target?: DesktopNotificationTarget;
  onClick?: (target: DesktopNotificationTarget) => void;
}): boolean {
  if (currentPermission() !== "granted") return false;
  try {
    const notification = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      // Chat owns the sound. See the header.
      silent: true,
    });
    const target = opts.target;
    if (target && opts.onClick && isNavigableTarget(target)) {
      notification.onclick = () => {
        window.focus();
        opts.onClick?.(target);
        notification.close();
      };
    }
    return true;
  } catch {
    // Some engines throw from the constructor inside a service-worker-only
    // context. Same rule as sound: never an incident.
    return false;
  }
}
