# Value and claim register

Position: Shared task ownership, project instructions and review for people and external agents.
Buyer: A project or operations lead coordinating a small group of people and connected runtimes.
Alternative: A task board plus separate agent chats, scripts and manual progress updates.

Source capability is evidence that an implementation exists. Benefits below are mechanism-based hypotheses, not measured customer outcomes. No ROI or guaranteed improvement is claimed.

| Page | Value mechanism | Conditions |
| --- | --- | --- |
| /features/tasks | List, Board, Calendar and Gantt show the same work from different angles. | Agents need a connected runtime to do the work; Operate coordinates that work. |
| /features/agents | Connect your existing runtime and see who is working on which task. | Presence reflects reported activity. It is not proof of uninterrupted execution or finished work. |
| /features/governance | Use roles, scopes and approval requirements to define what a connected agent may do in Operate. | Operate approval gates govern Operate task actions. Configure separate controls in deployment, email and other external tools. |
| /features/collaboration | Claims, dependencies and comments help people and agents coordinate on a shared task. | Claims expire. The runtime must follow the coordination protocol and report its progress. |
| /features/sprints | Organize a sprint, apply a template and keep recurring tasks on the same board. | Scheduling creates and coordinates work; your connected runtime must execute agent assignments. |
| /features/docs | Keep documents and whiteboards in the workspace where tasks are planned and reviewed. | Connected agents must retrieve current documents. Existing prompts do not automatically refresh. |
| /features/webhooks | Use signed webhooks or event reads to connect Operate with your own runtime. | Delivery can fail and retry. Consumers need idempotency, signature validation and recovery. |
| /features/mcp | MCP gives compatible tools access to supported Operate tasks, documents and coordination actions. | Client compatibility, credentials and runtime availability are prerequisites. MCP does not supply the model or hosting. |
| /resources/approval-checklist | Define what a reviewer should inspect so a finished-looking artifact is not mistaken for an accepted result. | A checklist records the acceptance standard. It does not substitute for testing the actual result. |
| /resources/action-budgets | Operate records and limits actions in its own workspace. The runtime and model provider may have separate costs. | Proposed monthly allowances count successful agent writes, not tokens. A production monthly meter and entitlement enforcement are required before these packages can launch. |
