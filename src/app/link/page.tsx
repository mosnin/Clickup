import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { RequireBackend } from "@/components/require-backend";
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
    const back = code ? `/link?code=${encodeURIComponent(code)}` : "/link";
    redirect(`/sign-in?redirect_url=${encodeURIComponent(back)}`);
  }
  return (
    <RequireBackend>
      <LinkAgent initialCode={code} />
    </RequireBackend>
  );
}
