import type { Metadata } from "next";
import { PublicFormClient } from "./public-form-client";

// Public intake form — a capability link, not login-gated (see
// src/middleware.ts: only /dashboard, /onboarding, /invite are protected).
// A server component wraps the client form so the route can carry its own
// metadata; the actual content is fetched client-side via getPublic since
// there's no auth context here to run a server-side Convex query against.

export const metadata: Metadata = {
  title: "Submit a request",
  robots: { index: false, follow: false },
};

export default async function PublicFormPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <PublicFormClient token={token} />;
}
