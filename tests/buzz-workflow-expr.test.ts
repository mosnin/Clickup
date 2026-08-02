import { describe, expect, it } from "vitest";
import {
  ExprRefusal,
  HELPER_NAMES,
  MAX_EXPR_DEPTH,
  MAX_EXPR_LEN,
  MAX_EXPR_STRING,
  MAX_EXPR_TOKENS,
  bech32Encode,
  buildEvalContext,
  emptyTriggerContext,
  evaluateCondition,
  evaluateExpression,
  filterAllows,
  jsonToString,
  resolveTemplate,
  type TriggerContext,
} from "../src/lib/buzz/workflow-expr";

// **The evaluator is a security boundary, and this file is the proof.**
//
// The claim at the top of `workflow-expr.ts` is that an authored string can
// reach a closed set of four helpers and a flat `Map` of variables, and nothing
// else — no property access, no prototype, no unbounded work. A comment cannot
// assert that. So the "refusals" block below feeds it `constructor`, `__proto__`
// and friends, a deeply nested expression and a pathological repetition, and
// requires a *refusal* in bounded time rather than a value, a crash, or a hang.
//
// Every one of those tests would also pass against an evaluator that simply
// threw on everything, which is why the block above it proves the ordinary cases
// work: a security test that does not sit beside a functionality test is
// measuring the wrong thing.

const trigger: TriggerContext = {
  text: "P1 outage in production",
  author: "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
  channelId: "channel-1",
  timestamp: 1_700_000_000,
  emoji: "",
  messageId: "a".repeat(64),
  webhookFields: { commit: "abc123", count: "7" },
};

const context = buildEvalContext(trigger, {
  build: { status: "success", exit_code: 0 },
  request: { approved: true },
});

function refusalOf(source: string): ExprRefusal {
  try {
    evaluateExpression(source, context);
  } catch (err) {
    if (err instanceof ExprRefusal) return err;
    throw err;
  }
  throw new Error(`expected a refusal for: ${source}`);
}

describe("the grammar, doing its job", () => {
  it("evaluates the operators evalexpr provides", () => {
    expect(evaluateExpression("1 + 2 * 3", context)).toBe(7);
    expect(evaluateExpression("(1 + 2) * 3", context)).toBe(9);
    expect(evaluateExpression("7 % 4", context)).toBe(3);
    expect(evaluateExpression("!(1 > 2)", context)).toBe(true);
    expect(evaluateExpression("-3 + 4", context)).toBe(1);
    expect(evaluateExpression("'a' + 'b'", context)).toBe("ab");
    expect(evaluateExpression("1 == 1 && 2 != 3", context)).toBe(true);
    expect(evaluateExpression("false || true", context)).toBe(true);
  });

  it("registers exactly four helpers, and they behave", () => {
    expect([...HELPER_NAMES].sort()).toEqual([
      "str_contains",
      "str_ends_with",
      "str_len",
      "str_starts_with",
    ]);
    expect(evaluateCondition("str_contains(trigger_text, 'P1')", context)).toBe(true);
    expect(evaluateCondition("str_starts_with(trigger_text, 'P1')", context)).toBe(true);
    expect(evaluateCondition("str_ends_with(trigger_text, 'production')", context)).toBe(true);
    expect(evaluateExpression("str_len(trigger_text)", context)).toBe(23);
  });

  it("resolves the six canonical trigger names and step outputs", () => {
    expect(evaluateExpression("trigger_channel_id", context)).toBe("channel-1");
    expect(evaluateExpression("trigger_timestamp", context)).toBe(1_700_000_000);
    expect(evaluateExpression("trigger_message_id", context)).toBe("a".repeat(64));
    expect(evaluateCondition("steps_build_output_status == 'success'", context)).toBe(true);
    expect(evaluateCondition("steps_request_output_approved == true", context)).toBe(true);
    expect(evaluateExpression("steps_build_output_exit_code", context)).toBe(0);
  });

  it("binds webhook body fields under trigger_<key>", () => {
    expect(evaluateExpression("trigger_commit", context)).toBe("abc123");
  });

  it("short-circuits && and || so a guard can guard", () => {
    // `str_len(9)` would refuse; the left side must stop it being reached.
    expect(evaluateCondition("false && str_len(1) > 0", context)).toBe(false);
    expect(evaluateCondition("true || str_len(1) > 0", context)).toBe(true);
  });
});

describe("the refusals — the security claim", () => {
  it("refuses `constructor`, `__proto__` and every other prototype name", () => {
    for (const source of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
      "constructor('return 1')",
      "__proto__ == 1",
      "trigger_text.constructor",
    ]) {
      const refusal = refusalOf(source);
      expect(refusal.workflow.kind, source).toBe("ConditionError");
      // Every one of them lands in the ordinary "I do not know that name" path,
      // which is the point: there is no special case to forget, because there is
      // no prototype chain to reach.
      expect(refusal.message, source).toMatch(/unknown variable|unknown function|unexpected/);
    }
  });

  it("has no member-access syntax at all, so the dotted form cannot parse", () => {
    // The §1.14 CI example writes `steps.build.output.status`. That form is
    // refused rather than supported — see the engine's comment on which side of
    // the inconsistency was chosen. A grammar with member access is a grammar in
    // which `x.constructor` is syntactically valid, and that is the thing this
    // file exists to make impossible.
    expect(refusalOf("steps.build.output.status == 'success'").message).toMatch(/unexpected/);
  });

  it("refuses an unknown function rather than looking one up", () => {
    expect(refusalOf("fetch('https://example.com')").message).toContain("unknown function");
    expect(refusalOf("eval('1')").message).toContain("unknown function");
  });

  it("refuses a deeply nested expression instead of exhausting the stack", () => {
    const deep = `${"(".repeat(MAX_EXPR_DEPTH + 50)}1${")".repeat(MAX_EXPR_DEPTH + 50)}`;
    const refusal = refusalOf(deep);
    expect(refusal.message).toContain("nested deeper than");
  });

  it("refuses a pathological repetition in bounded time", () => {
    const started = Date.now();
    const repeated = Array.from({ length: 5000 }, () => "1").join(" + ");
    const refusal = refusalOf(repeated);
    expect(refusal.message).toMatch(/tokens|bytes/);
    // Bounded, not merely finished: the claim is that no authored string makes
    // this run for an unbounded time, and a second is already three orders of
    // magnitude more than any real expression needs.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("refuses an over-long expression before parsing it", () => {
    const long = `'${"a".repeat(MAX_EXPR_LEN + 10)}'`;
    expect(refusalOf(long).message).toContain(`${MAX_EXPR_LEN}`);
  });

  it("refuses an expression that would build an unbounded string", () => {
    const chunk = `'${"a".repeat(1000)}'`;
    const concat = Array.from({ length: 10 }, () => chunk).join(" + ");
    expect(refusalOf(concat).message).toContain(`${MAX_EXPR_STRING}`);
  });

  it("caps the token count", () => {
    const many = Array.from({ length: MAX_EXPR_TOKENS + 100 }, () => "1").join(",");
    expect(refusalOf(`str_len(${many})`).message).toMatch(/tokens/);
  });

  it("refuses malformed input loudly rather than guessing", () => {
    for (const source of ["", "1 +", "(1", "'unterminated", "1 @ 2", "1 2"]) {
      expect(() => evaluateExpression(source, context), source).toThrow(ExprRefusal);
    }
  });

  it("refuses a condition that is not a boolean", () => {
    expect(() => evaluateCondition("1", context)).toThrow(/boolean/);
    expect(() => evaluateCondition("'yes'", context)).toThrow(/boolean/);
  });

  it("refuses division by zero rather than producing Infinity", () => {
    expect(refusalOf("1 / 0").message).toContain("division by zero");
  });
});

describe("the trigger filter fails closed", () => {
  it("skips the workflow when the filter errors, and never throws", () => {
    expect(filterAllows("str_contains(trigger_text, 'P1')", context)).toBe(true);
    expect(filterAllows("nonsense_variable", context)).toBe(false);
    expect(filterAllows("(((", context)).toBe(false);
    expect(filterAllows("1", context)).toBe(false);
  });
});

describe("context construction (§1.6 safety)", () => {
  it("lets the canonical names win over webhook fields", () => {
    const spoofed = buildEvalContext({
      ...trigger,
      webhookFields: { text: "spoofed", author: "spoofed" },
    });
    expect(spoofed.get("trigger_text")).toBe(trigger.text);
    expect(spoofed.get("trigger_author")).toBe(trigger.author);
  });

  it("drops body keys that would name a reserved variable outright", () => {
    const hostile = buildEvalContext({
      ...trigger,
      webhookFields: {
        trigger_author: "attacker",
        steps_build_output_status: "success",
        ok: "kept",
      },
    });
    // `trigger_trigger_author` would be the prefixed name if it were kept, and
    // it is not there either — the key is dropped, not renamed.
    expect(hostile.get("trigger_trigger_author")).toBeUndefined();
    expect(hostile.get("steps_build_output_status")).toBeUndefined();
    expect(hostile.get("trigger_author")).toBe(trigger.author);
    expect(hostile.get("trigger_ok")).toBe("kept");
  });

  it("ignores body keys that are not identifiers", () => {
    const odd = buildEvalContext({
      ...trigger,
      webhookFields: { "a-b": "x", "1abc": "y", "": "z" },
    });
    expect(odd.get("trigger_a-b")).toBeUndefined();
    expect(odd.get("trigger_1abc")).toBeUndefined();
  });

  it("flattens step outputs one level, keeping booleans and numbers", () => {
    const flat = buildEvalContext(emptyTriggerContext(), {
      s: { b: true, n: 4, o: { deep: 1 }, arr: [1, 2] },
    });
    expect(flat.get("steps_s_output_b")).toBe(true);
    expect(flat.get("steps_s_output_n")).toBe(4);
    // Structure becomes text: comparable and searchable, and not reachable into.
    expect(flat.get("steps_s_output_o")).toBe('{"deep":1}');
    expect(flat.get("steps_s_output_arr")).toBe("[1,2]");
  });
});

describe("templates (§1.5)", () => {
  const outputs = { build: { status: "success", meta: { a: 1 } } };

  it("resolves the documented paths", () => {
    expect(resolveTemplate("{{trigger.text}}", trigger)).toBe(trigger.text);
    expect(resolveTemplate("{{ trigger.channel_id }}", trigger)).toBe("channel-1");
    expect(resolveTemplate("{{trigger.timestamp}}", trigger)).toBe("1700000000");
    expect(resolveTemplate("{{trigger.message_id}}", trigger)).toBe("a".repeat(64));
    expect(resolveTemplate("{{trigger.commit}}", trigger)).toBe("abc123");
    expect(resolveTemplate("{{steps.build.output.status}}", trigger, outputs)).toBe("success");
  });

  it("coerces JSON the way json_to_string does", () => {
    expect(resolveTemplate("{{steps.build.output.meta}}", trigger, outputs)).toBe('{"a":1}');
    expect(jsonToString(null)).toBe("");
    expect(jsonToString(false)).toBe("false");
    expect(jsonToString(12)).toBe("12");
  });

  it("emits an unknown variable literally", () => {
    expect(resolveTemplate("x {{unknown.var}} y", trigger)).toBe("x {{unknown.var}} y");
    expect(resolveTemplate("{{steps.nope.output.x}}", trigger, outputs)).toBe(
      "{{steps.nope.output.x}}",
    );
    // Only one level deep: a fifth segment is not a path this resolver knows.
    expect(resolveTemplate("{{steps.build.output.meta.a}}", trigger, outputs)).toBe(
      "{{steps.build.output.meta.a}}",
    );
  });

  it("cannot reach a prototype through a step output", () => {
    expect(resolveTemplate("{{steps.build.output.constructor}}", trigger, outputs)).toBe(
      "{{steps.build.output.constructor}}",
    );
    expect(resolveTemplate("{{steps.build.output.__proto__}}", trigger, outputs)).toBe(
      "{{steps.build.output.__proto__}}",
    );
  });

  it("emits an unclosed {{ literally and stops", () => {
    expect(resolveTemplate("a {{trigger.text", trigger)).toBe("a {{trigger.text");
    expect(resolveTemplate("{{trigger.text}} then {{oops", trigger)).toBe(
      `${trigger.text} then {{oops`,
    );
  });

  it("does not re-scan what it produced", () => {
    const recursive = { ...trigger, text: "{{trigger.author}}" };
    // A single pass: the substituted text is output, not input.
    expect(resolveTemplate("{{trigger.text}}", recursive)).toBe("{{trigger.author}}");
  });

  it("truncates by characters, not bytes", () => {
    const emoji = { ...trigger, text: "🚨🚨🚨abc" };
    expect(resolveTemplate("{{trigger.text | truncate(3)}}", emoji)).toBe("🚨🚨🚨");
  });

  it("bech32-encodes a pubkey in full, and passes anything else through", () => {
    // NIP-19's own test vector.
    expect(resolveTemplate("{{trigger.author | npub}}", trigger)).toBe(
      "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6",
    );
    expect(resolveTemplate("{{trigger.author | truncate_pubkey}}", trigger)).toBe(
      "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6",
    );
    expect(resolveTemplate("{{trigger.channel_id | npub}}", trigger)).toBe("channel-1");
    expect(bech32Encode("npub", new Uint8Array(32)).startsWith("npub1")).toBe(true);
  });

  it("refuses an unknown filter on a known value", () => {
    let error: unknown;
    try {
      resolveTemplate("{{trigger.text | shell}}", trigger);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ExprRefusal);
    expect((error as ExprRefusal).workflow.kind).toBe("TemplateError");
  });

  it("refuses to build an unbounded output", () => {
    const big = { ...trigger, text: "x".repeat(20_000) };
    const template = "{{trigger.text}}".repeat(10);
    expect(() => resolveTemplate(template, big)).toThrow(ExprRefusal);
  });
});
