import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { RequireBackend } from "@/components/require-backend";
import { EnsureUser } from "@/components/dashboard/ensure-user";
import { Button } from "@/components/ui/button";
import { LinkAgent } from "./link-agent";

export const metadata: Metadata = { title: "Connect an agent" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

// The human half of the device flow (RFC 8628 §3.3). The address is short
// and typeable on purpose: the phishing resistance of this grant comes from
// the human arriving here by typing it, not by following a link the agent
// handed them.
export default async function LinkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const code = typeof params.code === "string" ? params.code : "";
  const { userId } = await auth();
  if (!userId) {
    // Offer BOTH doors rather than picking one on their behalf.
    //
    // An earlier version redirected straight to sign-up, on the theory that
    // somebody handed this link by an agent probably has no account. That is
    // true of roughly half of them, and the other half — existing customers
    // connecting a second agent — landed on a create-account form and had to
    // work out that they were in the wrong place. Guessing costs one of the
    // two groups a wrong turn, and there is no need to guess: this is a
    // question with two honest answers, so it gets asked.
    //
    // The code rides through whichever round trip they choose, so they come
    // back to the consent screen rather than to a dashboard.
    return <LinkSignedOut code={code} />;
  }
  return (
    <RequireBackend>
      {/* Not optional, and the reason is the whole point of this page.
          Someone arriving from sign-up has a Clerk session but no `users`
          row and NO PERSONAL SPACE — so "Personal space" on the consent
          screen would bind an agent to a scope with nothing in it, and the
          agent would connect successfully to an empty world.
          This is the EnsureChatIdentity failure exactly: a correct backend
          that is simply never called. It is invisible in development,
          because everyone testing it already has a personal space. */}
      <EnsureUser />
      <LinkAgent initialCode={code} />
    </RequireBackend>
  );
}

/**
 * The signed-out door, with both ways in.
 *
 * Deliberately a plain server component and NOT a redirect: a redirect makes
 * the choice for them, and the whole point is that there are two kinds of
 * person standing here and no way to tell them apart. Ordinary email sign-up
 * is untouched and is the first option, because "connect an agent" must not
 * become a second, stranger way to get an account.
 */
function LinkSignedOut({ code }: { code: string }) {
  const back = code ? `/link?code=${encodeURIComponent(code)}` : "/link";
  const to = (path: string) =>
    `${path}?redirect_url=${encodeURIComponent(back)}`;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-page p-5">
      <div className="bento w-full max-w-lg rounded-3xl bg-card p-6 sm:p-8">
        <Link href="/" aria-label="Operate home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/operate-logo-black.svg"
            alt="operate.to"
            className="h-6 w-auto dark:invert"
          />
        </Link>
        <p className="mt-8 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Connect an agent
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {code ? "Sign in to approve this agent" : "Sign in to continue"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          An agent is asking to join your workspace. You&apos;ll see exactly
          what it may do before anything is connected
          {code ? ", and the code you came with is remembered." : "."}
        </p>
        <div className="mt-7 flex flex-col gap-2 sm:flex-row">
          <Link href={to("/sign-up")} className="flex-1">
            <Button className="w-full">Create an account</Button>
          </Link>
          <Link href={to("/sign-in")} className="flex-1">
            <Button variant="outline" className="w-full">
              I already have one
            </Button>
          </Link>
        </div>
        <p className="mt-6 text-xs leading-5 text-muted-foreground">
          Signing up here is the same ordinary account as everywhere else —
          email and password, or whichever provider you normally use. Nothing
          about connecting an agent changes how you sign in.
        </p>
      </div>
    </main>
  );
}
