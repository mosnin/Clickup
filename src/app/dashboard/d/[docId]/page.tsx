import { DocRedirect } from "./doc-redirect";

// Kept as a redirect, not deleted: Docs were folded into Pages, and a URL
// someone bookmarked should survive the product getting simpler.
export default async function DocPage({
  params,
}: {
  params: Promise<{ docId: string }>;
}) {
  const { docId } = await params;
  return <DocRedirect docId={docId} />;
}
