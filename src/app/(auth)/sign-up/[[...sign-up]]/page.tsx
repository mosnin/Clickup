import type { Metadata } from "next";
import { SignUp } from "@clerk/nextjs";

export const metadata: Metadata = { title: "Sign up" };

// Redirects are baked in (env can still override) so a host without the
// NEXT_PUBLIC_CLERK_*_REDIRECT_URL vars never bounces new users back to
// the marketing home: sign-up lands in onboarding, sign-in in the app.
export default function SignUpPage() {
  return (
    <SignUp
      fallbackRedirectUrl={
        process.env.NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL ??
        "/onboarding"
      }
      signInFallbackRedirectUrl={
        process.env.NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL ??
        "/dashboard"
      }
      appearance={{
        variables: {
          colorPrimary: "var(--color-azure-600)",
          colorText: "var(--color-foreground)",
          colorBackground: "var(--color-background)",
          borderRadius: "1rem",
        },
        elements: {
          card: "shadow-xl",
        },
      }}
    />
  );
}
