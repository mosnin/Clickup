import type { Metadata } from "next";
import { TemplateCenter } from "./template-center";

export const metadata: Metadata = {
  title: "Templates",
};

export default function TemplatesRoute() {
  return <TemplateCenter />;
}
