import { WhiteboardEditor } from "./whiteboard-editor";

export default async function WhiteboardPage({
  params,
}: {
  params: Promise<{ whiteboardId: string }>;
}) {
  const { whiteboardId } = await params;
  return <WhiteboardEditor whiteboardId={whiteboardId} />;
}
