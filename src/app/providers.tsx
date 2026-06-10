"use client";

import { ReactNode } from "react";
import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
const clerkKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

// Convex client is only constructed when the URL is set so the marketing
// site still renders before backend creds are wired in.
const convex = convexUrl ? new ConvexReactClient(convexUrl) : null;

export function Providers({ children }: { children: ReactNode }) {
  // Mirror the Convex pattern for Clerk: when the publishable key isn't
  // set, render the children without ClerkProvider. Keeps build-time
  // prerender working on environments where the key isn't wired (preview
  // deploys with prod-only env scoping) and lets the marketing site +
  // /_not-found page generate without auth init.
  if (!clerkKey) {
    return <>{children}</>;
  }
  return (
    <ClerkProvider>
      {convex ? (
        <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
          {children}
        </ConvexProviderWithClerk>
      ) : (
        children
      )}
    </ClerkProvider>
  );
}
