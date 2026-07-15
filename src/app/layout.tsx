import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "./providers";
import { RegisterServiceWorker } from "@/components/register-service-worker";
import { OfflineIndicator } from "@/components/offline-indicator";

// Instrument Sans (OFL) — bundled locally so builds never depend on a
// font CDN. One variable file covers 400–700.
const instrumentSans = localFont({
  src: "./fonts/InstrumentSans-Variable.woff2",
  weight: "400 700",
  variable: "--font-instrument",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "https://clickup-clone.app",
  ),
  title: {
    default: "ClickUp Clone — mission control for humans and AI agents",
    template: "%s · ClickUp Clone",
  },
  description:
    "The all-in-one workspace where AI agents work like teammates: tasks, docs, and sprints for humans; MCP access, budgets, and approval gates for agents.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
  applicationName: "ClickUp Clone",
  appleWebApp: {
    capable: true,
    title: "ClickUp Clone",
    statusBarStyle: "default",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ededf0" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={instrumentSans.variable}>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <Providers>{children}</Providers>
        <OfflineIndicator />
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
