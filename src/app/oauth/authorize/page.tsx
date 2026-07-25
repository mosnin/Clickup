import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { RequireBackend } from "@/components/require-backend";
import { OAuthAuthorize } from "./oauth-authorize";

export const metadata: Metadata = { title: "Connect Operate" };

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
  return (
    <RequireBackend>
      <OAuthAuthorize
        clientId={current.get("client_id") ?? ""}
        redirectUri={current.get("redirect_uri") ?? ""}
        responseType={current.get("response_type") ?? ""}
        scope={current.get("scope") ?? "operate:read operate:write"}
        state={current.get("state") ?? ""}
        codeChallenge={current.get("code_challenge") ?? ""}
        codeChallengeMethod={current.get("code_challenge_method") ?? ""}
      />
    </RequireBackend>
  );
}
