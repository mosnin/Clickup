import type { Metadata } from "next";
import { PanelsStudio } from "./panels-studio";

export const metadata: Metadata = { title: "Panels" };

export default function PanelsPage() {
  return <PanelsStudio />;
}
