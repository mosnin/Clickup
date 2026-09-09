import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider, SignIn, SignedIn, SignedOut, useAuth } from "@clerk/clerk-react";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { DesktopApp } from "./desktop-app";
import "../../../src/app/globals.css";
import "./native.css";

const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;

function ConfigurationError() {
  return (
    <main className="grid min-h-dvh place-items-center bg-page p-8 text-foreground">
      <section className="panel max-w-lg rounded-2xl p-8">
        <p className="text-overline text-muted-foreground">Native build configuration</p>
        <h1 className="mt-2 text-2xl font-bold">Operate needs its public service configuration.</h1>
        <p className="mt-3 text-sm text-muted-foreground">Set VITE_CLERK_PUBLISHABLE_KEY and VITE_CONVEX_URL when building the signed application. No server secret belongs in the app bundle.</p>
      </section>
    </main>
  );
}

function AuthenticatedApp({ convex }: { convex: ConvexReactClient }) {
  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      <SignedOut>
        <main className="native-auth grid min-h-dvh place-items-center p-8">
          <SignIn routing="hash" fallbackRedirectUrl="/dashboard" />
        </main>
      </SignedOut>
      <SignedIn><DesktopApp /></SignedIn>
    </ConvexProviderWithClerk>
  );
}

if (localStorage.getItem("theme") !== "light") document.documentElement.dataset.theme = "dark";

const root = ReactDOM.createRoot(document.getElementById("root")!);
if (!clerkKey || !convexUrl) {
  root.render(<ConfigurationError />);
} else {
  const convex = new ConvexReactClient(convexUrl);
  root.render(
    <React.StrictMode>
      <ClerkProvider publishableKey={clerkKey} afterSignOutUrl="/">
        <AuthenticatedApp convex={convex} />
      </ClerkProvider>
    </React.StrictMode>,
  );
}
