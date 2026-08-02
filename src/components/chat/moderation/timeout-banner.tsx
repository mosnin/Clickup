"use client";

// The composer's timeout banner.
//
// §6.3, "Option A, reactive": there is **no proactive self-restriction read**.
// A composer does not ask "am I timed out" — it finds out from a send
// rejection, and this banner is what it renders when it does. That choice is
// deliberate and it is why the parse contract in
// `src/lib/buzz/moderation.ts` matters: the sentence the server throws is the
// only channel.
//
// The behaviour that must not be lost: **no silent write-drops, no shadow
// bans.** A message that is refused says so, in words, with the time left. The
// failure mode this replaces — a composer that accepts text and quietly
// discards it — teaches people the product is broken rather than that they are
// timed out.
//
// Fail closed: an unreadable expiry keeps the banner up (`isTimeoutActive`
// returns true for `expiresAtMs: null`), because re-enabling the composer on a
// number we could not parse means the next send is refused again.
//
// It takes the rejection *message* rather than a parsed object so a caller
// only has to hand over what it already caught.

import { useEffect, useState } from "react";
import {
  isTimeoutActive,
  parseTimeoutRejection,
  timeoutBannerText,
} from "@/lib/buzz/moderation";

export function ComposerTimeoutBanner({
  rejection,
  onExpired,
}: {
  /** The refusal a send threw, or null when the last send succeeded. */
  rejection: string | null;
  /** Called once the timeout has run out, so the composer can re-enable. */
  onExpired?: () => void;
}) {
  const parsed = rejection ? parseTimeoutRejection(rejection) : null;
  const [now, setNow] = useState(() => Date.now());

  // One second, and only while a banner is up: a countdown is the one thing on
  // this screen that has to move, and an interval that outlives it is a timer
  // running behind every room the reader opens afterwards.
  useEffect(() => {
    if (!parsed || parsed.expiresAtMs === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [parsed?.expiresAtMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = isTimeoutActive(parsed, now);

  useEffect(() => {
    if (parsed && !active) onExpired?.();
  }, [parsed, active, onExpired]);

  if (!parsed || !active) return null;

  return (
    <p
      role="status"
      className="rounded-t-2xl bg-muted px-3 py-2 text-xs font-medium"
    >
      {timeoutBannerText(
        parsed.expiresAtMs === null ? null : parsed.expiresAtMs - now,
      )}
    </p>
  );
}
