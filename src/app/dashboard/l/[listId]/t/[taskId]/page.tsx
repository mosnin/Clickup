import { TaskDetail } from "./task-detail";

export default async function TaskPage({
  params,
}: {
  params: Promise<{ listId: string; taskId: string }>;
}) {
  const { listId, taskId } = await params;
  return <TaskDetail listId={listId} taskId={taskId} />;
}
