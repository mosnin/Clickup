"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * What a refused authorization request looks like.
 *
 * The consent screen's Convex query throws when the request does not check
 * out: an unknown client, a redirect URI that is not registered for it byte
 * for byte, a challenge that is not S256. Without a boundary here that
 * surfaced as the app's generic failure page, which reads as "Operate is
 * broken" rather than "this request was refused", and refusal is the whole
 * point of the check.
 *
 * The copy names no parameter and echoes nothing back. A page that said
 * which field was wrong would let anyone with a client id probe for
 * registered redirect URIs one guess at a time. And there is no link out to
 * the caller: the request never proved where it came from, so the only safe
 * way onward is somewhere on this origin.
 */
export default function OAuthAuthorizeError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    console.error("OAuth authorization request refused", error);
  }, [error]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-page p-5">
      <div className="w-full max-w-lg rounded-3xl bg-card p-6 shadow-xl sm:p-8">
        <Link href="/" aria-label="Operate home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/operate-logo-black.svg"
            alt="operate.to"
            className="h-6 w-auto dark:invert"
          />
        </Link>
        <h1 className="mt-8 text-xl font-semibold">
          Invalid connection request
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Operate refused this authorization request. Nothing was connected and
          no access was granted. Start the connection again from the app that
          sent you here.
        </p>
      </div>
    </main>
  );
}
