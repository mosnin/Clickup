import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";
import { authAppearance } from "../../clerk-appearance";

export const metadata: Metadata = { title: "Log in" };

// Redirects are baked in (env can still override) so a host without the
// NEXT_PUBLIC_CLERK_*_REDIRECT_URL vars never bounces users back to the
// marketing home: sign-in lands in the app, sign-up in onboarding.
export default function SignInPage() {
  return (
    <SignIn
      fallbackRedirectUrl={
        process.env.NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL ??
        "/dashboard"
      }
      signUpFallbackRedirectUrl={
        process.env.NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL ??
        "/onboarding"
      }
      appearance={authAppearance}
    />
  );
}
