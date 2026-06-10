// Tiny haptics wrapper. Capacitor's Haptics plugin is a no-op on web,
// so a single import path works in the browser PWA and in the iOS /
// Android wrappers without branching.
//
// Each helper is fire-and-forget — failures are swallowed because
// haptics are nice-to-have polish, never the difference between a
// working flow and a broken one.

import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";

export function tapLight() {
  Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
}

export function tapMedium() {
  Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});
}

export function notifySuccess() {
  Haptics.notification({ type: NotificationType.Success }).catch(() => {});
}

export function notifyWarning() {
  Haptics.notification({ type: NotificationType.Warning }).catch(() => {});
}
