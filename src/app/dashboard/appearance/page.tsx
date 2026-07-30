import type { Metadata } from "next";
import { AppearanceOverview } from "./appearance-overview";

export const metadata: Metadata = { title: "Appearance" };

// The studio's front door. The chapters (Type, Colour, Layout, Panels, Charts)
// are their own routes under this one, so the section has real navigation
// rather than one very long page of headings.
export default function AppearancePage() {
  return <AppearanceOverview />;
}
