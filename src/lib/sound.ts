// The app's voice — one function, `uiSound(name)`, fired from the handful of
// moments that deserve a sound.
//
// The synthesis engine is vendored from m1ckc3s/procedural-sounds (MIT; see
// ./audio/THIRD-PARTY-NOTICES.md): every sound is generated at play time from
// a small parameter patch, so there are no sample files and nothing loads
// over the network. The AudioContext is created lazily on first play, which
// always happens inside a click handler — so the browser's autoplay policy is
// satisfied by construction.
//
// The judgment this module encodes, because "alive but not obnoxious" is a
// judgment: sounds are ON by default and QUIET by design. The catalog was
// tuned around -25 dB UI feedback and the master multiplier here only ever
// brings it further down. A sound marks a STATE CHANGE the person caused or
// needs to notice (completed, approved, sent, agent arrived, refused) — never
// hover, never scroll, never anything that fires in a loop. Each name has a
// retrigger guard so a spammed action cannot stack into a chord.
//
// The preference is per-machine (localStorage), toggled from the ⌘K palette
// — the same register as the theme switch. It deliberately does not follow
// prefers-reduced-motion: motion sensitivity and sound preference are
// different accessibility axes, and conflating them takes sound away from
// people who never asked.

import { playPatch, patchDuration } from "./audio/synth";
import { setMasterVolume } from "./audio/context";
import { UI_PATCHES, type UiSoundName } from "./ui-sound-patches";

export type { UiSoundName };

const PREF_KEY = "ui-sounds";
/** Global multiplier under the patches' own (already quiet) gains. */
const MASTER = 0.55;

let masterApplied = false;
const busyUntil = new Map<string, number>();

export function soundsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(PREF_KEY) !== "off";
}

export function setSoundsEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PREF_KEY, on ? "on" : "off");
  // Answer the toggle in its own medium — turning sounds ON says so.
  if (on) uiSound("toggle_on");
}

/**
 * Play one of the UI sounds. Fire-and-forget: disabled, server-side, spammed
 * and failed plays are all silent no-ops — sound is seasoning, and a broken
 * AudioContext must never break the action that asked for it.
 */
export function uiSound(name: UiSoundName): void {
  if (typeof window === "undefined" || !soundsEnabled()) return;
  const now = performance.now();
  const until = busyUntil.get(name) ?? 0;
  if (now < until) return;
  const patch = UI_PATCHES[name];
  busyUntil.set(
    name,
    now + Math.max(80, patchDuration(patch) * 1000 * 0.6),
  );
  try {
    // setMasterVolume constructs the AudioContext synchronously, so it sits
    // inside the same net as the play: an environment with no Web Audio
    // (jsdom, an exotic browser) must not crash the click that asked for a
    // sound effect.
    if (!masterApplied) {
      masterApplied = true;
      setMasterVolume(MASTER);
    }
    void playPatch(patch, {}).catch(() => {
      // A suspended context (no gesture yet) — fine, stay silent.
    });
  } catch {
    // No AudioContext at all — the app works exactly as before sounds.
  }
}
