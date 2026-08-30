import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { RequireBackend } from "@/components/require-backend";
import { validateOAuthResource } from "@/lib/oauth-resource";
import { oauthIssuer } from "@/lib/oauth-server";
import { OAuthAuthorize } from "./oauth-authorize";

export const metadata: Metadata = { title: "Connect Operate" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function OAuthAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const current = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") current.set(key, value);
  }
  const { userId } = await auth();
  if (!userId) {
    redirect(`/sign-in?redirect_url=${encodeURIComponent(`/oauth/authorize?${current}`)}`);
  }
  let resource = "";
  try {
    const candidate =
      typeof params.resource === "string" ? params.resource : undefined;
    resource = validateOAuthResource(candidate, oauthIssuer());
  } catch {
    // The client component renders the same non-leaky invalid-request state
    // used for malformed redirect and PKCE parameters.
  }
  return (
    <RequireBackend>
      <OAuthAuthorize resource={resource} />
    </RequireBackend>
  );
}
