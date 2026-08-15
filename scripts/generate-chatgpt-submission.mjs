import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(
  resolve(root, "src/app/api/[transport]/route.ts"),
  "utf8",
);
const chatSource = readFileSync(
  resolve(root, "src/lib/buzz/agent-chat-tools.ts"),
  "utf8",
);
const profileSource = readFileSync(
  resolve(root, "src/lib/mcp-annotation-profile.ts"),
  "utf8",
);

function namesInSet(input, setName) {
  const body = input.match(
    new RegExp(`const ${setName} = new Set\\(\\[([\\s\\S]*?)\\]\\);`),
  )?.[1];
  if (!body) throw new Error(`Could not find ${setName}`);
  return new Set(
    [...body.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]),
  );
}

function namesInArray(input, arrayName) {
  const body = input.match(
    new RegExp(`const ${arrayName}[^=]*= \\[([\\s\\S]*?)\\];`),
  )?.[1];
  if (!body) throw new Error(`Could not find ${arrayName}`);
  return new Set(
    [...body.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]),
  );
}

function declaredToolNames(input) {
  return [...input.matchAll(/^\s{4}name: "([a-z0-9_]+)",$/gm)].map(
    (match) => match[1],
  );
}

const toolNames = [
  ...new Set([...declaredToolNames(source), ...declaredToolNames(chatSource)]),
];
if (toolNames.length < 100) {
  throw new Error(`MCP registry scan collapsed to ${toolNames.length} tools`);
}
const directoryExcludedTools = namesInSet(
  profileSource,
  "DIRECTORY_EXCLUDED_TOOLS",
);
const directoryToolNames = toolNames.filter(
  (name) => !directoryExcludedTools.has(name),
);
const readTools = new Set([
  ...namesInSet(source, "READ_TOOLS"),
  ...namesInArray(chatSource, "CHAT_AGENT_READ_TOOLS"),
]);
const destructiveTools = namesInSet(source, "DESTRUCTIVE_TOOLS");
const openWorldTools = namesInSet(source, "OPEN_WORLD_TOOLS");

const tools = Object.fromEntries(
  directoryToolNames.map((name) => {
    const readOnly = readTools.has(name);
    const destructive = destructiveTools.has(name);
    const openWorld = openWorldTools.has(name);
    const readableName = name.replaceAll("_", " ");
    return [
      name,
      {
        annotations: {
          readOnlyHint: readOnly,
          openWorldHint: openWorld,
          destructiveHint: destructive,
        },
        justifications: {
          read_only_justification: readOnly
            ? `Only retrieves or computes private Operate workspace data for ${readableName} without changing records.`
            : `Performs ${readableName}, which creates or changes state in the user's private Operate workspace.`,
          open_world_justification: openWorld
            ? `Performs ${readableName} through a user-configured external endpoint or payment rail.`
            : `Operates only within the user's private Operate workspace and does not publish to public internet services.`,
          destructive_justification: destructive
            ? `Performs ${readableName}, which can overwrite, remove, transition, dispatch, or irreversibly commit selected workspace state.`
            : `Does not delete, overwrite, revoke access, dispatch execution, or perform an irreversible transaction.`,
        },
      },
    ];
  }),
);

const submission = {
  $schema:
    "https://developers.openai.com/apps-sdk/schemas/chatgpt-app-submission.v1.json",
  schema_version: 1,
  app_info: {
    display_name: "Operate",
    subtitle: "Run work with AI agents",
    description:
      "Operate helps humans and AI agents organize work as Spaces, Lists, and tasks; build auditable execution plans; dispatch dependency-ready work; monitor live agent presence; and review evidence, approvals, budgets, and recovery.",
    category: "PRODUCTIVITY",
  },
  tools,
  test_cases: [
    {
      description: "Inspect the connected workspace hierarchy.",
      user_prompt: "Show my Spaces and the Lists inside each one.",
      file_attachment_urls: null,
      tools_triggered: "get_tree",
      expected_output:
        "Returns the accessible Workspace → Space → Project → List hierarchy without exposing restricted data.",
      expected_output_url: null,
    },
    {
      description: "Create a private task in a selected List.",
      user_prompt:
        "Create a task called “Review launch checklist” in the Launch Readiness List.",
      file_attachment_urls: null,
      tools_triggered: "create_task",
      expected_output:
        "Creates exactly one task in the resolved List and confirms its title, status, and destination.",
      expected_output_url: null,
    },
    {
      description: "Compile an auditable multi-workstream plan.",
      user_prompt:
        "Turn this confirmed launch brief into an execution plan inside the Launch Space, but do not dispatch it.",
      file_attachment_urls: null,
      tools_triggered: "create_execution_plan",
      expected_output:
        "Creates one atomic execution plan with Lists, dependencies, open questions, provenance, and pending dispatch authorization.",
      expected_output_url: null,
    },
    {
      description: "Propagate a confirmed source update safely.",
      user_prompt:
        "Add this confirmed compliance requirement to the plan and revalidate every workstream before dispatch.",
      file_attachment_urls: null,
      tools_triggered: "revise_execution_plan_context",
      expected_output:
        "Appends a versioned context revision to every generated workstream and returns dispatch authorization to human review.",
      expected_output_url: null,
    },
    {
      description: "Dispatch only the next safe execution wave.",
      user_prompt:
        "Show readiness, then dispatch the next safe wave for this plan.",
      file_attachment_urls: null,
      tools_triggered: "get_execution_readiness, dispatch_execution_wave",
      expected_output:
        "Explains blockers and dispatches only dependency-ready work that satisfies capability, capacity, policy, and approval constraints.",
      expected_output_url: null,
    },
  ],
  negative_test_cases: [
    {
      description: "Do not trigger for unrelated calendar work.",
      user_prompt: "What meetings do I have tomorrow?",
      file_attachment_urls: null,
      tools_triggered: null,
      expected_output:
        "The app should not be invoked because personal calendar retrieval is outside Operate's supported workflows.",
      expected_output_url: null,
    },
    {
      description: "Do not trigger for general web research.",
      user_prompt: "Find today's top artificial-intelligence news.",
      file_attachment_urls: null,
      tools_triggered: null,
      expected_output:
        "The app should not be invoked because general internet search is outside Operate's supported workflows.",
      expected_output_url: null,
    },
    {
      description: "Do not trigger for personal email delivery.",
      user_prompt: "Email my accountant the attached tax return.",
      file_attachment_urls: null,
      tools_triggered: null,
      expected_output:
        "The app should not be invoked because Operate does not provide personal email sending or attachment delivery.",
      expected_output_url: null,
    },
  ],
};

const outputPath = resolve(root, "chatgpt-app-submission.json");
const serialized = `${JSON.stringify(submission, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = readFileSync(outputPath, "utf8");
  if (current !== serialized) {
    throw new Error(
      "chatgpt-app-submission.json is stale; run node scripts/generate-chatgpt-submission.mjs",
    );
  }
  console.log(
    `Verified ChatGPT submission metadata for ${directoryToolNames.length} tools.`,
  );
} else {
  writeFileSync(outputPath, serialized);
  console.log(
    `Generated ChatGPT submission metadata for ${directoryToolNames.length} tools.`,
  );
}
