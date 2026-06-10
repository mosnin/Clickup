import { DocEditor } from "./doc-editor";

export default async function DocPage({
  params,
}: {
  params: Promise<{ docId: string }>;
}) {
  const { docId } = await params;
  return <DocEditor docId={docId} />;
}
