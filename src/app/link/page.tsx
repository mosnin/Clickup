import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { RequireBackend } from "@/components/require-backend";
import { EnsureUser } from "@/components/dashboard/ensure-user";
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
    // Sign-UP, not sign-in. Somebody arriving here has usually just been
    // handed a link by an agent they are trying for the first time, so the
    // likelier truth is that they have no account yet — and Clerk's sign-up
    // screen carries a "already have an account?" link, while the sign-in
    // screen makes a new user hunt for the way out. The code rides through
    // the round trip so they land back on the consent screen, not the form.
    const back = code ? `/link?code=${encodeURIComponent(code)}` : "/link";
    redirect(`/sign-up?redirect_url=${encodeURIComponent(back)}`);
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
