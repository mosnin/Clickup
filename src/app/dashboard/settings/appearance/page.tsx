import type { Metadata } from "next";
import { AppearanceStudio } from "./appearance-studio";

export const metadata: Metadata = { title: "Appearance" };

export default function AppearancePage() {
  return <AppearanceStudio />;
}
