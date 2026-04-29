import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { RegisterServiceWorker } from "@/components/register-service-worker";
import { OfflineIndicator } from "@/components/offline-indicator";

export const metadata: Metadata = {
  title: {
    default: "Pace — Find your pace.",
    template: "%s · Pace",
  },
  description: "The work app that gets out of your way.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
  applicationName: "Pace",
  appleWebApp: {
    capable: true,
    title: "Pace",
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
