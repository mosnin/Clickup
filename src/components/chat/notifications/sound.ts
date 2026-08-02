// The twelve sounds, and the one rule about playing them.
//
// **Every failure is swallowed.** Not out of laziness: `play()` rejects when
// the page has had no user gesture yet, which is the ordinary state of a tab
// that has been open since before you walked away — and the first live message
// after that is exactly when a thrown promise would surface. A notification
// sound that cannot play is a notification sound that does not play. It is
// never an error somebody needs to see, and it must never take a render with
// it.
//
// One `Audio` per name, cached, with `currentTime` reset before each play.
// Reusing the element is what makes two messages in quick succession sound
// like two messages: a fresh element per play re-fetches (or at least
// re-decodes) and the second one lands late enough to read as a stutter.
//
// The assets live at `/sounds/<name>.mp3`. They are not in the repository yet —
// until they are, this module is a well-behaved no-op, which is precisely the
// behaviour the swallow rule already specifies.

import { RECOMMENDED_SOUND_BY_SLOT, type SoundName, type SoundSlot } from "@/lib/buzz/notify";

const cache = new Map<SoundName, HTMLAudioElement>();

function elementFor(name: SoundName): HTMLAudioElement | null {
  if (typeof window === "undefined" || typeof Audio === "undefined") return null;
  const cached = cache.get(name);
  if (cached) return cached;
  try {
    const audio = new Audio(`/sounds/${name}.mp3`);
    audio.preload = "auto";
    cache.set(name, audio);
    return audio;
  } catch {
    return null;
  }
}

/**
 * Play one sound. Returns nothing, throws nothing, awaits nothing worth
 * awaiting — see the header.
 */
export function playSound(name: SoundName): void {
  const audio = elementFor(name);
  if (!audio) return;
  try {
    audio.currentTime = 0;
    void audio.play().catch(() => {});
  } catch {
    // Same rule. A codec the browser will not decode is not an incident.
  }
}

/**
 * The suggestion beside a slot, never applied on its own.
 *
 * A recommendation that silently becomes the value is not a recommendation, it
 * is a default with extra words — and it would overwrite a pick somebody made
 * the moment the recommendation changed.
 */
export function recommendedSoundFor(slot: SoundSlot): SoundName {
  return RECOMMENDED_SOUND_BY_SLOT[slot];
}
