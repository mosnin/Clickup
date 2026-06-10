import { PillHeader } from "@/components/marketing/pill-header";
import { PillFooter } from "@/components/marketing/pill-footer";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <PillHeader />
      <main className="flex-1">{children}</main>
      <PillFooter />
    </div>
  );
}
