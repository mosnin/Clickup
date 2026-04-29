import type { CapacitorConfig } from "@capacitor/cli";

// Native wrapper config for iOS + Android via Capacitor.
//
// We use the "remote web app" pattern: the native shell points at the
// production web URL and renders the live app. This means:
//   - Convex realtime + Clerk session work the same as on web.
//   - Push updates ship the moment Vercel deploys, no app-store review.
//   - The app store binary stays small (~3 MB).
//
// To bootstrap a platform after `npm install`:
//   npx cap add ios       # requires Xcode on macOS
//   npx cap add android   # requires Android Studio
//
// To copy web assets + sync plugins after a code change:
//   npx cap sync
//
// Update `server.url` to your real production URL before publishing.
const config: CapacitorConfig = {
  appId: "com.pace.app",
  appName: "Pace",
  // webDir is required by Capacitor but unused when `server.url` is set.
  webDir: "public",
  server: {
    url: process.env.CAP_SERVER_URL ?? "https://your-app.vercel.app",
    cleartext: false,
    androidScheme: "https",
  },
  ios: {
    contentInset: "automatic",
  },
};

export default config;
