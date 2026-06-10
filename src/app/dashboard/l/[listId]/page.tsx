import { ListPage } from "./list-page";

export default async function ListRoute({
  params,
  searchParams,
}: {
  params: Promise<{ listId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { listId } = await params;
  const { view } = await searchParams;
  return <ListPage listId={listId} initialView={view} />;
}
