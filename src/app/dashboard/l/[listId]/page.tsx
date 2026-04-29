import { ListView } from "./list-view";

export default async function ListPage({
  params,
}: {
  params: Promise<{ listId: string }>;
}) {
  const { listId } = await params;
  return <ListView listId={listId} />;
}
