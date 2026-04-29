import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { RegisterServiceWorker } from "@/components/register-service-worker";
import { OfflineIndicator } from "@/components/offline-indicator";

export const metadata: Metadata = {
  title: {
    default: "ClickUp Clone",
    template: "%s · ClickUp Clone",
  },
  description: "One app to replace them all — tasks, docs, goals, and chat.",
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
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <Providers>{children}</Providers>
        <OfflineIndicator />
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
