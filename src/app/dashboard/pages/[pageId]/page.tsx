import type { Metadata } from "next";
import { PageEditor } from "./page-editor";

export const metadata: Metadata = {
  title: "Page",
  robots: { index: false, follow: false },
};

export default async function PageRoute({
  params,
}: {
  params: Promise<{ pageId: string }>;
}) {
  const { pageId } = await params;
  return <PageEditor pageId={pageId} />;
}
