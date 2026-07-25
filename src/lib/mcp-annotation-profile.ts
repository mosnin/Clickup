import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export type AnnotationProfile = "openai" | "anthropic";

type AnnotationFacts = {
  title: string;
  readOnly: boolean;
  destructive: boolean;
  openWorld: boolean;
  idempotent: boolean;
};

export function toolAnnotationsForProfile(
  facts: AnnotationFacts,
  profile: AnnotationProfile,
): ToolAnnotations {
  return {
    title: facts.title,
    readOnlyHint: facts.readOnly,
    openWorldHint: facts.openWorld,
    // Anthropic's directory policy treats every mutation—including creates—as
    // destructive. OpenAI reserves the hint for overwrites, removals, and
    // irreversible actions.
    destructiveHint:
      profile === "anthropic" ? !facts.readOnly : facts.destructive,
    ...(facts.idempotent ? { idempotentHint: true } : {}),
  };
}
