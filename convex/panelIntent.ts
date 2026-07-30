"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import OpenAI from "openai";

// Say what you want the screen to look like.
//
// This is the piece that makes the whole customisation system reachable by
// someone who has never opened a stylesheet. Nineteen style axes and a query
// vocabulary is enormous power and an enormous amount to learn; "make this a
// donut, only the overdue ones, and quieter" is neither.
//
// **The interesting property is that this needs no trust in the model.**
//
// The vocabulary is closed — every source, filter, dimension, measure, shape
// and style value is enumerated, and both the client normalizer and the
// resolver have exactly one branch per value that vocabulary contains. So the
// model is not being asked to write code, or CSS, or a query. It is being
// asked to pick from lists. Anything it invents is dropped on the way back in,
// and the worst a hostile or hallucinated answer can produce is a panel
// showing the wrong chart — never a panel that reads something its author
// could not, and never anything executable.
//
// That is why the vocabulary is passed *in* from the caller rather than
// duplicated here. The client holds the one definition of what is legal, uses
// it to build the prompt, and re-normalizes the answer against the same lists.
// A copy in this file would drift, and a drifted copy would let the model
// suggest options that silently vanish — which reads as the feature being
// broken rather than as a stale list.

const MODEL = "gpt-4o-mini";

function client(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  return key ? new OpenAI({ apiKey: key }) : null;
}

export const draftPanel = action({
  args: {
    /** What the person actually said. */
    sentence: v.string(),
    /**
     * The panel being changed, if any — its title, shape and current style.
     * Present for "make it a donut"; absent for "show me overdue work".
     */
    current: v.optional(v.any()),
    /**
     * The legal values, from src/lib. Passed in rather than duplicated so
     * there is one definition of what this system can express.
     */
    vocabulary: v.any(),
  },
  handler: async (
    _ctx,
    { sentence, current, vocabulary },
  ): Promise<{
    ok: boolean;
    /** A partial panel — only the keys the sentence actually spoke to. */
    patch?: unknown;
    /** One line explaining what it understood, in the person's own terms. */
    said?: string;
    message?: string;
  }> => {
    const ai = client();
    if (!ai) {
      return {
        ok: false,
        message:
          "Describing a panel needs an OpenAI key on this deployment. Everything else still works — pick from the options above.",
      };
    }

    const text = sentence.trim().slice(0, 400);
    if (!text) return { ok: false, message: "Say what you'd like to see." };

    const system = [
      "You translate a person's plain description of a dashboard panel into a",
      "JSON patch. You are choosing from fixed lists, never inventing values.",
      "",
      "Rules:",
      "- Return ONLY keys the sentence actually speaks to. Absence means",
      "  'leave it alone'. Do not restate the current panel.",
      "- Every value must come from the allowed lists. If the sentence asks",
      "  for something the lists cannot express, leave that key out and say so",
      "  in `said`.",
      "- `said` is one short sentence, in the person's own words, describing",
      "  what you changed. No jargon, no key names.",
      "",
      `Allowed values: ${JSON.stringify(vocabulary)}`,
      current
        ? `The panel right now: ${JSON.stringify(current)}`
        : "There is no panel yet; describe a new one.",
    ].join("\n");

    try {
      const response = await ai.chat.completions.create({
        model: MODEL,
        // Deterministic: the same sentence should produce the same panel, or
        // the feature is a slot machine rather than a control.
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: text },
        ],
      });

      const raw = response.choices[0]?.message?.content;
      if (!raw) return { ok: false, message: "Nothing came back. Try again?" };

      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const said = typeof parsed.said === "string" ? parsed.said : undefined;
      delete parsed.said;
      return { ok: true, patch: parsed, said };
    } catch {
      // A refused, rate-limited or malformed answer is not a broken app: the
      // pickers are still right there, and they are the primary path anyway.
      return {
        ok: false,
        message: "Couldn't work that one out. Try saying it a different way.",
      };
    }
  },
});
