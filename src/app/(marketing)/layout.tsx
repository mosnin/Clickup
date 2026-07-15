import { PillHeader } from "@/components/marketing/pill-header";
import { PillFooter } from "@/components/marketing/pill-footer";

// Logged-out site shell. The header is fixed (pages start with heroes
// that pad for it); everything sits on the warm cream canvas.
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-cream text-foreground">
      <PillHeader />
      <main className="flex-1">{children}</main>
      <PillFooter />
    </div>
  );
}
