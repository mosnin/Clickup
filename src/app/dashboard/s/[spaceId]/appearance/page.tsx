import type { Metadata } from "next";
import { AppearanceStudio } from "@/app/dashboard/settings/appearance/appearance-studio";

export const metadata: Metadata = { title: "How this space looks" };

// The same studio, on a route inside the space.
//
// Not a second component and not a query parameter: the URL is already how the
// app answers "which room am I in", so putting the space customiser at a space
// path means the whole shell — sidebar, chrome, this page — previews the space's
// look while you tune it. A `?space=` parameter would have worked and would have
// left two ways to express the same thing.
export default function SpaceAppearancePage() {
  return <AppearanceStudio />;
}
