#!/usr/bin/env node
// Source scan of the ChatGPT MCP catalog.
//
// The route file cannot export its TOOLS array, so this reads the same
// literals the registry is built from. Used by smoke-mcp.mjs (CI gate) and
// generate-chatgpt-submission.mjs. The advertised pin is 184:
// 174 work + 12 chat − 2 excluded payment tools.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

export const WORK_TOOL_COUNT = 174;
export const CHAT_TOOL_COUNT = 12;
export const DIRECTORY_EXCLUDED_TOOL_COUNT = 2;
export const CHATGPT_ADVERTISED_TOOL_COUNT =
  WORK_TOOL_COUNT + CHAT_TOOL_COUNT - DIRECTORY_EXCLUDED_TOOL_COUNT;

export const PRODUCTION_CHATGPT_MCP_URL =
  "https://www.operate.to/api/mcp?profile=chatgpt";

function namesInSet(input, setName) {
  const body = input.match(
    new RegExp(`(?:const|export const) ${setName} = new Set\\(\\[([\\s\\S]*?)\\]\\);`),
  )?.[1];
  if (!body) throw new Error(`Could not find ${setName}`);
  return new Set(
    [...body.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]),
  );
}

function namesInArray(input, arrayName) {
  const body = input.match(
    new RegExp(`(?:const|export const) ${arrayName}[^=]*= \\[([\\s\\S]*?)\\];`),
  )?.[1];
  if (!body) throw new Error(`Could not find ${arrayName}`);
  return new Set(
    [...body.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]),
  );
}

export function declaredToolNames(input) {
  return [...input.matchAll(/^\s{4}name: "([a-z0-9_]+)",$/gm)].map(
    (match) => match[1],
  );
}

export function readCatalogSources(base = root) {
  return {
    route: readFileSync(resolve(base, "src/app/api/[transport]/route.ts"), "utf8"),
    chat: readFileSync(
      resolve(base, "src/lib/buzz/agent-chat-tools.ts"),
      "utf8",
    ),
    profile: readFileSync(
      resolve(base, "src/lib/mcp-annotation-profile.ts"),
      "utf8",
    ),
  };
}

export function scanChatgptCatalog(base = root) {
  const { route, chat, profile } = readCatalogSources(base);
  const work = declaredToolNames(route);
  const chatNames = declaredToolNames(chat);
  const workUnique = [...new Set(work)];
  const chatUnique = [...new Set(chatNames)];
  const excluded = namesInSet(profile, "DIRECTORY_EXCLUDED_TOOLS");
  const all = [...new Set([...workUnique, ...chatUnique])];
  const advertised = all.filter((name) => !excluded.has(name));
  return {
    work: workUnique,
    chat: chatUnique,
    excluded: [...excluded],
    advertised,
    readTools: new Set([
      ...namesInSet(route, "READ_TOOLS"),
      ...namesInArray(chat, "CHAT_AGENT_READ_TOOLS"),
    ]),
    destructiveTools: namesInSet(route, "DESTRUCTIVE_TOOLS"),
    openWorldTools: namesInSet(route, "OPEN_WORLD_TOOLS"),
    routeSource: route,
    chatSource: chat,
    profileSource: profile,
  };
}

export function certifyChatgptCatalog(base = root) {
  const catalog = scanChatgptCatalog(base);
  const problems = [];
  if (catalog.work.length !== WORK_TOOL_COUNT) {
    problems.push(
      `work tools: expected ${WORK_TOOL_COUNT}, found ${catalog.work.length}`,
    );
  }
  if (catalog.chat.length !== CHAT_TOOL_COUNT) {
    problems.push(
      `chat tools: expected ${CHAT_TOOL_COUNT}, found ${catalog.chat.length}`,
    );
  }
  if (catalog.excluded.length !== DIRECTORY_EXCLUDED_TOOL_COUNT) {
    problems.push(
      `excluded tools: expected ${DIRECTORY_EXCLUDED_TOOL_COUNT}, found ${catalog.excluded.length}`,
    );
  }
  if (catalog.advertised.length !== CHATGPT_ADVERTISED_TOOL_COUNT) {
    problems.push(
      `chatgpt advertised: expected ${CHATGPT_ADVERTISED_TOOL_COUNT} ` +
        `(${WORK_TOOL_COUNT} work + ${CHAT_TOOL_COUNT} chat − ${DIRECTORY_EXCLUDED_TOOL_COUNT} excluded), ` +
        `found ${catalog.advertised.length}`,
    );
  }
  for (const name of ["buy_credits", "settle_payment"]) {
    if (catalog.advertised.includes(name)) {
      problems.push(`${name} must not be advertised on the chatgpt profile`);
    }
    if (!catalog.work.includes(name)) {
      problems.push(`${name} must remain in the work registry so custom MCP keeps it`);
    }
  }
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
  return catalog;
}

export function refuseApexMcpUrl(candidate) {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`MCP_URL is not a valid URL: ${candidate}`);
  }
  if (url.hostname === "operate.to") {
    throw new Error(
      "Do not use https://operate.to/api/mcp — apex 308s POSTs. " +
        `Use ${PRODUCTION_CHATGPT_MCP_URL}`,
    );
  }
  return url.toString();
}
