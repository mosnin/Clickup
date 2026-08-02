// Clerk, enough of it to draw the profile card.
import * as React from "react";

export function UserButton() {
  return (
    <span
      aria-hidden
      title="Account"
      className="inline-block size-8 shrink-0 rounded-full bg-muted"
    />
  );
}
export function useUser() {
  return {
    isSignedIn: true,
    isLoaded: true,
    user: { fullName: "Alex Rivera", firstName: "Alex", username: "alex" },
  };
}
export function useAuth() {
  return { isSignedIn: true, isLoaded: true, getToken: async () => null };
}
export function ClerkProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
