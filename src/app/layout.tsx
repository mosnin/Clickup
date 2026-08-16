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

// Space Grotesk (OFL) — the display face, and the one that gives this product
// a voice. It replaced Darker Grotesque as the default, which was a tall
// CONDENSED grotesk: condensed faces read as "poster", they need optical size
// correction to sit level with body copy (we were carrying a
// `font-size-adjust: 0.5` for exactly that), and at the sizes a dashboard
// actually uses — a 30px page title, a 40px figure — they read cramped rather
// than confident. Space Grotesk is proportional, geometric, and its numerals
// are the reason it is right here specifically: this product is mostly
// numbers, and its single-storey `a`, flat-topped `t` and slab-ish digits give
// a figure presence at 48px without shouting.
//
// Darker Grotesque stays bundled below — it is still an option in the
// appearance studio, and a face somebody chose has to keep working.
const spaceGrotesk = localFont({
  src: [
    { path: "./fonts/SpaceGrotesk-Latin.woff2" },
    { path: "./fonts/SpaceGrotesk-LatinExt.woff2" },
  ],
  weight: "300 700",
  variable: "--font-space-grotesk",
  display: "swap",
});

// Doto (OFL) — the dot-matrix numeral face for the marketing instrument
// bento. Subset to ASCII (a dot-matrix glyph is a grid of composite dots, so
// the whole variable file is 3.4KB) and bundled locally like every other
// face: no runtime font-CDN request. Figures only — it is a display voice,
// not a reading one.
const doto = localFont({
  src: [{ path: "./fonts/Doto-Latin.woff2" }],
  weight: "100 900",
  variable: "--font-doto",
  display: "swap",
});

// Darker Grotesque (OFL) — kept for readers who chose it. Two subsets of the
// variable file (latin + latin-ext), bundled locally for the same reason as
// above: no runtime font-CDN request, no layout shift from a third-party
// stylesheet.
const darkerGrotesque = localFont({
  src: [
    { path: "./fonts/DarkerGrotesque-Latin.woff2" },
    { path: "./fonts/DarkerGrotesque-LatinExt.woff2" },
  ],
  weight: "300 900",
  variable: "--font-darker-grotesque",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "https://operate.to",
  ),
  title: {
    default: "operate.to: mission control for humans and AI agents",
    template: "%s · operate.to",
  },
  description:
    "The all-in-one workspace where AI agents work like teammates: tasks, docs, and sprints for humans; MCP access, budgets, and approval gates for agents.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/brand/operate-icon-dark.svg", media: "(prefers-color-scheme: light)" },
      { url: "/brand/operate-icon-white.svg", media: "(prefers-color-scheme: dark)" },
    ],
    apple: "/brand/operate-icon-dark.svg",
  },
  openGraph: {
    type: "website",
    siteName: "operate.to",
    title: "operate.to: mission control for humans and AI agents",
    description:
      "The all-in-one workspace where AI agents work like teammates: tasks, docs, and sprints for humans; MCP access, budgets, and approval gates for agents.",
    images: [{ url: "/operate-social.png", width: 1200, height: 630, alt: "operate.to" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "operate.to: mission control for humans and AI agents",
    description:
      "The all-in-one workspace where AI agents work like teammates: tasks, docs, and sprints for humans; MCP access, budgets, and approval gates for agents.",
    images: ["/operate-social.png"],
  },
  applicationName: "operate.to",
  appleWebApp: {
    capable: true,
    title: "operate.to",
    statusBarStyle: "default",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e8e8ec" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0c" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${instrumentSans.variable} ${spaceGrotesk.variable} ${darkerGrotesque.variable} ${doto.variable}`}>
      <head>
        {/* Resolve the theme before first paint so there's no flash. The
            toggle writes localStorage "theme" = dark | light. DARK is the
            default — the dark window on the lime backdrop is the product's
            face, the one both design references wear — and light is the
            explicit choice, not the OS's. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var d='dark';try{if(localStorage.getItem('theme')==='light')d='light';}catch(e){}document.documentElement.dataset.theme=d;})();`,
          }}
        />
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <Providers>{children}</Providers>
        <OfflineIndicator />
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
