import { CHAT_AGENT_TOOLS } from "@/lib/buzz/agent-chat-tools";
import {
  DIRECTORY_EXCLUDED_TOOLS,
  toolAvailableForProfile,
  type AnnotationProfile,
} from "@/lib/mcp-annotation-profile";
import { CORE_MCP_TOOL_NAMES, MCP_TOOL_NAMES } from "@/lib/mcp-tool-names";

/**
 * Public ChatGPT/Codex directory contract.
 *
 * 174 work tools (route registry, including the two payment actions) +
 * 12 Chat tools − 2 directory-excluded payment tools = 184 advertised.
 * The pin is the product claim. Adding or removing a tool is a deliberate
 * catalog change and must update these constants in the same commit.
 */
export const WORK_TOOL_COUNT = 174;
export const CHAT_TOOL_COUNT = 12;
export const DIRECTORY_EXCLUDED_TOOL_COUNT = 2;
export const CHATGPT_ADVERTISED_TOOL_COUNT =
  WORK_TOOL_COUNT + CHAT_TOOL_COUNT - DIRECTORY_EXCLUDED_TOOL_COUNT;

export function toolsForProfile(profile: AnnotationProfile): string[] {
  return MCP_TOOL_NAMES.filter((name) =>
    toolAvailableForProfile(name, profile),
  );
}

export function catalogBreakdown() {
  return {
    work: CORE_MCP_TOOL_NAMES.length,
    chat: CHAT_AGENT_TOOLS.length,
    excluded: DIRECTORY_EXCLUDED_TOOLS.size,
    advertised: toolsForProfile("chatgpt").length,
  };
}
