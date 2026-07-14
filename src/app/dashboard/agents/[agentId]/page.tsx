import { AgentDetail } from "./agent-detail";

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  return <AgentDetail agentId={agentId} />;
}
