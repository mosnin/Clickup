"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";

// Capability-link invite acceptance. /invite/[token] is protected by
// middleware, so the visitor is already signed in. Any signed-in user holding
// the link may accept (Notion-style) — share deliberately.

export default function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const invite = useQuery(api.invites.getByToken, { token });
  const acceptByToken = useMutation(api.invites.acceptByToken);
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setPending(true);
    setError(null);
    try {
      const { workspaceId } = await acceptByToken({ token });
      router.push(`/dashboard/w/${workspaceId}`);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() ||
              "This invite is no longer valid."
          : "This invite is no longer valid.",
      );
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-page px-4">
      <div className="w-full max-w-md rounded-2xl bento p-8 text-center">
        {invite === undefined ? (
          <div className="space-y-3">
            <div className="mx-auto h-5 w-40 animate-pulse rounded-full bg-muted" />
            <div className="mx-auto h-4 w-56 animate-pulse rounded-full bg-muted" />
          </div>
        ) : invite === null || !invite.pending ? (
          <>
            <h1 className="text-lg font-semibold">Invite unavailable</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This invite link has already been used, was revoked, or never
              existed.
            </p>
            <Link
              href="/dashboard"
              className="mt-6 inline-block text-sm font-medium text-foreground hover:underline"
            >
              Go to your dashboard →
            </Link>
          </>
        ) : (
          <>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              You&apos;re invited
            </p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight">
              {invite.workspaceName}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {invite.invitedBy} invited you to join as{" "}
              <span className="font-medium text-foreground">
                {invite.role}
              </span>
              .
            </p>
            {error && <p className="mt-4 text-sm text-[#c2453a]">{error}</p>}
            <div className="mt-6 flex items-center justify-center gap-3">
              <Button type="button" onClick={accept} disabled={pending}>
                {pending ? "Joining…" : `Join ${invite.workspaceName}`}
              </Button>
              <Link
                href="/dashboard"
                className="text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Not now
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
