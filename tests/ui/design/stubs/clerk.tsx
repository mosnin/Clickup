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
  return { isSignedIn: true, isLoaded: true, user: { fullName: "Ada Lovelace" } };
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
