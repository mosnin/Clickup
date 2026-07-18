import { SpaceView } from "./space-view";

export default async function SpaceRoute({
  params,
}: {
  params: Promise<{ spaceId: string }>;
}) {
  const { spaceId } = await params;
  return <SpaceView spaceId={spaceId} />;
}
