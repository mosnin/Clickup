import { ListSettings } from "./list-settings";

export default async function ListSettingsPage({
  params,
}: {
  params: Promise<{ listId: string }>;
}) {
  const { listId } = await params;
  return <ListSettings listId={listId} />;
}
