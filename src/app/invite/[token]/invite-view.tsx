"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { SignedIn, SignedOut, SignInButton, useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { PaceWordmark } from "@/components/brand/pace-mark";

// Public accept page. Anyone with the token can land here. The accept
// mutation requires auth, so we gate the Accept button behind Clerk's
// SignedIn / SignedOut.

export function InviteView({ token }: { token: string }) {
  const router = useRouter();
  const lookup = useQuery(api.invitations.lookup, { token });
  const accept = useMutation(api.invitations.accept);
  const { user } = useUser();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="px-4 pt-6 sm:px-8">
        <Link href="/">
          <PaceWordmark />
        </Link>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-md rounded-3xl border border-border bg-background p-6 shadow-sm">
          {lookup === undefined ? (
            <div className="space-y-3">
              <div className="h-6 w-2/3 animate-pulse rounded-full bg-muted" />
              <div className="h-4 w-full animate-pulse rounded-full bg-muted" />
            </div>
          ) : lookup === null ? (
            <Empty
              title="Invitation not found"
              body="The link you used doesn't match an active invitation. Ask the person who invited you to send a new one."
            />
          ) : lookup.state === "expired" ? (
            <Empty
              title="This invitation expired"
              body="Invitations are good for 14 days. Ask the inviter to send a fresh one."
            />
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">
                Join {lookup.workspaceName}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  {lookup.inviterName}
                </span>{" "}
                invited <span className="font-mono">{lookup.email}</span> as a{" "}
                <span className="font-medium">{lookup.role}</span>.
              </p>

              <SignedOut>
                <p className="mt-6 rounded-2xl bg-muted p-3 text-sm text-muted-foreground">
                  Sign in to accept. We&apos;ll bring you back to this page.
                </p>
                <div className="mt-4 flex gap-2">
                  <SignInButton
                    forceRedirectUrl={`/invite/${token}`}
                    signUpForceRedirectUrl={`/invite/${token}`}
                    mode="modal"
                  >
                    <Button>Sign in to accept</Button>
                  </SignInButton>
                  <Link href="/">
                    <Button variant="ghost">Not now</Button>
                  </Link>
                </div>
              </SignedOut>

              <SignedIn>
                {user?.primaryEmailAddress?.emailAddress &&
                  user.primaryEmailAddress.emailAddress.toLowerCase() !==
                    lookup.email.toLowerCase() && (
                    <p className="mt-6 rounded-2xl border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                      Heads up: this invite was sent to{" "}
                      <span className="font-mono">{lookup.email}</span> but
                      you&apos;re signed in as{" "}
                      <span className="font-mono">
                        {user.primaryEmailAddress.emailAddress}
                      </span>
                      . Pace will still let you in, but you may want to
                      switch accounts.
                    </p>
                  )}
                {error && (
                  <p className="mt-3 rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                  </p>
                )}
                <div className="mt-6 flex gap-2">
                  <Button
                    type="button"
                    disabled={pending}
                    onClick={async () => {
                      setPending(true);
                      setError(null);
                      try {
                        const workspaceId = await accept({ token });
                        router.push(`/dashboard/w/${workspaceId}`);
                      } catch (err) {
                        setError(
                          err instanceof Error
                            ? err.message
                            : "Failed to accept",
                        );
                        setPending(false);
                      }
                    }}
                  >
                    {pending ? "Accepting…" : "Accept invite"}
                  </Button>
                  <Link href="/dashboard">
                    <Button variant="ghost">Not now</Button>
                  </Link>
                </div>
              </SignedIn>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      <div className="mt-6">
        <Link href="/">
          <Button variant="outline">Back to Pace</Button>
        </Link>
      </div>
    </div>
  );
}
