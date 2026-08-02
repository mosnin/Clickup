// Clerk, enough of it to draw a sidebar footer.
import * as React from "react";

export function UserButton() {
  return (
    <span
      aria-hidden
      className="inline-block size-7 rounded-full bg-muted"
      title="Account"
    />
  );
}
export function useUser() {
  // `id` is not decoration. Home builds its panel scope from it
  // (`{ scopeType: "user", scopeId: user.id }`) and skips every authored-panel
  // query — and the whole mint path — when it is absent, so a stub without one
  // renders a Home where choosing a chart shape can never do anything, while
  // the harness reports a shot taken. It matches the `clerkId` the fixtures
  // are written against.
  return {
    isSignedIn: true,
    isLoaded: true,
    user: { id: "u1", firstName: "Ada", fullName: "Ada Lovelace" },
  };
}
export function useAuth() {
  return { isSignedIn: true, isLoaded: true, getToken: async () => null };
}
export function SignedIn({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
export function SignedOut() {
  return null;
}
export function ClerkProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
