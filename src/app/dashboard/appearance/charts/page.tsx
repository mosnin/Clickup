import type { Metadata } from "next";
import { ChartsStudio } from "./charts-studio";

export const metadata: Metadata = { title: "Charts" };

export default function ChartsPage() {
  return <ChartsStudio />;
}
