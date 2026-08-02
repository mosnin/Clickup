import { describe, expect, it } from "vitest";
import {
  ACTION_TYPES,
  DEFAULT_APPROVAL_TIMEOUT,
  MAX_DELAY_SECS,
  MIN_INTERVAL_SECS,
  TRIGGER_TYPES,
  canonicalJson,
  constantTimeEquals,
  cronFireInstant,
  cronMatches,
  definitionToJson,
  intervalFireInstant,
  normalizeCron,
  parseCron,
  parseDurationSecs,
  parseWorkflowYaml,
  parseYamlSubset,
  requiresElevatedAuthority,
  stripSecret,
  triggerSummary,
  validateWorkflowDef,
  webhookDestinationRefusal,
  workflowRejectionMessage,
  type WorkflowDef,
} from "../src/lib/buzz/workflow-schema";

// The document half of the workflow engine.
//
// Two claims are worth stating because the tests below are shaped by them.
//
// **The five workflows in 03-workflows-projects.md §1.14 are fixtures, not
// illustrations.** They are verbatim from Buzz's own repo and test suites, and
// if this parser cannot read them then "YAML" here means something private. So
// they appear below as literal strings, indentation and quoting included.
//
// **Validation is a list of refusals, and each one is a separate test.** §1.4
// enumerates seven hard rejects; a validator with six of them is a validator
// that stores a workflow whose step id parses as subtraction.

const INCIDENT_TRIAGE = `name: "Incident Triage"
trigger:
  on: message_posted
  filter: "str_contains(trigger_text, 'P1')"
steps:
  - id: notify
    action: send_message
    text: "P1 incident detected: {{trigger.text}}"
  - id: page
    if: "str_contains(trigger_text, 'production')"
    action: request_approval
    from: "{{trigger.author}}"
    message: "Page on-call?"
`;

const DEPLOY_APPROVAL = `name: Deploy Approval
trigger:
  on: webhook
steps:
  - id: request
    action: request_approval
    from: '@engineering-lead'
    message: Approve deploy?
    timeout: 4h
  - id: notify_approved
    if: 'steps_request_output_approved == true'
    action: send_message
    text: Deploy approved
  - id: notify_denied
    if: 'steps_request_output_approved == false'
    action: send_message
    text: Deploy denied
`;

// §1.14's CI example, with the underscore identifiers the engine actually
// requires. See the `if:` inconsistency test below for which side was chosen and
// why the dotted form in the vision doc is treated as the mistake.
const CI = `name: CI
trigger:
  on: diff_posted
steps:
  - id: build
    action: call_webhook
    url: "https://ci.internal.example.com/build"
    body: '{"commit": "{{trigger.commit}}"}'
  - id: test
    action: call_webhook
    url: "https://ci.internal.example.com/test"
    if: "steps_build_output_status == 'success'"
  - id: gate
    action: request_approval
    message: "CI passed. Approve merge?"
    if: "steps_test_output_status == 'success'"
`;

const DAILY_STANDUP = `name: Daily Standup
trigger:
  on: schedule
  cron: '0 9 * * 1-5'      # weekdays 09:00 UTC
steps:
  - id: prompt
    action: send_message
    text: Standup time
`;

const SMALLEST_WEBHOOK = `name: test-wf
trigger:
  on: webhook
steps:
  - id: step1
    action: send_message
    text: "Hello from workflow"
`;

function parsed(yaml: string): WorkflowDef {
  const result = parseWorkflowYaml(yaml);
  if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.message}`);
  return result.value;
}

function rejection(yaml: string): { kind: string; message: string } {
  const result = parseWorkflowYaml(yaml);
  if (result.ok) throw new Error("expected a rejection");
  return result.error;
}

describe("the §1.14 fixtures", () => {
  it("reads the incident-triage workflow", () => {
    const def = parsed(INCIDENT_TRIAGE);
    expect(def.name).toBe("Incident Triage");
    expect(def.enabled).toBe(true);
    expect(def.trigger).toEqual({
      on: "message_posted",
      filter: "str_contains(trigger_text, 'P1')",
    });
    expect(def.steps).toHaveLength(2);
    expect(def.steps[0]).toEqual({
      id: "notify",
      action: { action: "send_message", text: "P1 incident detected: {{trigger.text}}" },
    });
    expect(def.steps[1].if).toBe("str_contains(trigger_text, 'production')");
    expect(def.steps[1].action).toEqual({
      action: "request_approval",
      from: "{{trigger.author}}",
      message: "Page on-call?",
      // An omitted `timeout:` is the documented default, filled in here rather
      // than at execution time so the stored definition says what will happen.
      timeout: DEFAULT_APPROVAL_TIMEOUT,
    });
  });

  it("reads the approval-gated deploy, including its two branches", () => {
    const def = parsed(DEPLOY_APPROVAL);
    expect(def.trigger).toEqual({ on: "webhook" });
    expect(def.steps.map((s) => s.id)).toEqual(["request", "notify_approved", "notify_denied"]);
    expect(def.steps[0].action).toMatchObject({ from: "@engineering-lead", timeout: "4h" });
    expect(def.steps[1].if).toBe("steps_request_output_approved == true");
  });

  it("reads the CI workflow, headers, bodies, quoted URLs and all", () => {
    const def = parsed(CI);
    expect(def.trigger).toEqual({ on: "diff_posted" });
    expect(def.steps[0].action).toEqual({
      action: "call_webhook",
      url: "https://ci.internal.example.com/build",
      method: "POST",
      headers: {},
      body: '{"commit": "{{trigger.commit}}"}',
    });
    expect(requiresElevatedAuthority(def)).toBe(true);
  });

  it("reads the schedule fixture, trailing comment included", () => {
    const def = parsed(DAILY_STANDUP);
    expect(def.trigger).toEqual({ on: "schedule", cron: "0 9 * * 1-5" });
    expect(requiresElevatedAuthority(def)).toBe(false);
  });

  it("reads the smallest valid webhook workflow", () => {
    const def = parsed(SMALLEST_WEBHOOK);
    expect(def.name).toBe("test-wf");
    expect(def.steps).toEqual([
      { id: "step1", action: { action: "send_message", text: "Hello from workflow" } },
    ]);
  });
});

describe("the YAML subset", () => {
  it("parses nested mappings, lists and scalars", () => {
    const doc = parseYamlSubset(`a: 1
b: true
c:
  d: hello
  e: 'quoted: colon'
f:
  - one
  - two
`);
    expect(doc.ok && doc.value).toEqual({
      a: 1,
      b: true,
      c: { d: "hello", e: "quoted: colon" },
      f: ["one", "two"],
    });
  });

  it("keeps an unquoted URL whole — the colon has no space after it", () => {
    const doc = parseYamlSubset("url: https://example.com/a:b\n");
    expect(doc.ok && doc.value).toEqual({ url: "https://example.com/a:b" });
  });

  it("treats `#` as a comment only when something separates it from the value", () => {
    const doc = parseYamlSubset(`a: value # trailing
b: "has # inside"
`);
    expect(doc.ok && doc.value).toEqual({ a: "value", b: "has # inside" });
  });

  it("refuses what it does not implement rather than reading it as empty", () => {
    for (const source of [
      "steps: [ {id: a} ]\n",
      "a: &anchor 1\n",
      "a: |\n  block\n",
      "---\na: 1\n",
      "a:\n\tb: 1\n",
    ]) {
      const doc = parseYamlSubset(source);
      expect(doc.ok, source).toBe(false);
    }
  });

  it("refuses a duplicate key instead of silently keeping the last one", () => {
    const doc = parseYamlSubset("a: 1\na: 2\n");
    expect(doc.ok).toBe(false);
  });

  it("refuses a document past its size and nesting caps", () => {
    const long = `name: x\n${"y: 1\n".repeat(3000)}`;
    expect(parseYamlSubset(long).ok).toBe(false);
    let deep = "a:\n";
    for (let i = 1; i < 12; i += 1) deep += `${" ".repeat(i * 2)}a:\n`;
    deep += `${" ".repeat(24)}b: 1\n`;
    expect(parseYamlSubset(deep).ok).toBe(false);
  });
});

describe("the closed vocabulary", () => {
  it("names every trigger and action it knows", () => {
    expect([...TRIGGER_TYPES]).toEqual([
      "message_posted",
      "reaction_added",
      "diff_posted",
      "schedule",
      "webhook",
    ]);
    expect([...ACTION_TYPES]).toEqual([
      "send_message",
      "send_dm",
      "set_channel_topic",
      "add_reaction",
      "call_webhook",
      "request_approval",
      "delay",
    ]);
  });

  it("refuses an unknown trigger type", () => {
    const error = rejection(`name: x
trigger:
  on: telepathy
steps:
  - id: a
    action: delay
    duration: 1s
`);
    expect(error.kind).toBe("InvalidYaml");
    expect(error.message).toContain("telepathy");
  });

  it("refuses an unknown action type", () => {
    const error = rejection(`name: x
trigger:
  on: webhook
steps:
  - id: a
    action: rm_rf
`);
    expect(error.message).toContain("rm_rf");
  });

  it("refuses an unknown field rather than carrying it silently", () => {
    const error = rejection(`name: x
trigger:
  on: webhook
steps:
  - id: a
    action: delay
    duration: 1s
    retries: 3
`);
    expect(error.message).toContain("retries");
  });

  it("refuses a required field that was started and not finished", () => {
    const error = rejection(`name: x
trigger:
  on: webhook
steps:
  - id: a
    action: send_message
    text:
`);
    expect(error.message).toContain("text");
  });
});

describe("validation (§1.4)", () => {
  const base = (steps: string, trigger = "  on: webhook") =>
    `name: x\ntrigger:\n${trigger}\nsteps:\n${steps}`;

  it("1 — refuses an empty name", () => {
    const error = rejection(`name: "   "
trigger:
  on: webhook
steps:
  - id: a
    action: delay
    duration: 1s
`);
    expect(error.kind).toBe("InvalidDefinition");
    expect(error.message).toContain("name");
  });

  it("2 — refuses zero steps", () => {
    const error = rejection("name: x\ntrigger:\n  on: webhook\nsteps:\n");
    expect(error.message).toMatch(/steps|list/);
  });

  it("3 — refuses a dashed, spaced or over-long step id", () => {
    for (const id of ["my-step", "my step", "a;b", "x".repeat(65)]) {
      const error = rejection(base(`  - id: '${id}'\n    action: delay\n    duration: 1s\n`));
      expect(error.kind, id).toBe("InvalidDefinition");
    }
  });

  it("4 — refuses duplicate step ids", () => {
    const error = rejection(
      base(
        "  - id: step1\n    action: delay\n    duration: 1s\n  - id: step1\n    action: delay\n    duration: 2s\n",
      ),
    );
    expect(error.message).toContain("duplicate step id: step1");
    // The sentence the builder shows verbatim (§1.13's error paragraph).
    expect(workflowRejectionMessage(error as never)).toBe(
      "invalid: workflow YAML parse error: duplicate step id: step1",
    );
  });

  it("5 — refuses a schedule with neither cron nor interval, and one with both", () => {
    const neither = rejection(
      base("  - id: a\n    action: delay\n    duration: 1s\n", "  on: schedule"),
    );
    expect(neither.message).toContain("requires either cron or interval");
    const both = rejection(
      base(
        "  - id: a\n    action: delay\n    duration: 1s\n",
        "  on: schedule\n  cron: '0 9 * * 1-5'\n  interval: 300",
      ),
    );
    expect(both.message).toContain("not both");
  });

  it("6 — refuses a cron expression that does not parse", () => {
    const error = rejection(
      base(
        "  - id: a\n    action: delay\n    duration: 1s\n",
        "  on: schedule\n  cron: 'not a cron'",
      ),
    );
    expect(error.message).toContain("invalid cron");
  });

  it("7 — refuses a sub-minute interval", () => {
    const error = rejection(
      base("  - id: a\n    action: delay\n    duration: 1s\n", "  on: schedule\n  interval: 30s"),
    );
    expect(error.message).toContain(`${MIN_INTERVAL_SECS}`);
    const ok = parseWorkflowYaml(
      base("  - id: a\n    action: delay\n    duration: 1s\n", "  on: schedule\n  interval: 60s"),
    );
    expect(ok.ok).toBe(true);
  });

  it("refuses a call_webhook destination that is not a public https URL", () => {
    for (const url of [
      "http://example.com/hook",
      "https://127.0.0.1/hook",
      "https://localhost/hook",
      "https://10.0.0.5/hook",
      "https://user:pw@example.com/hook",
      "https://[::1]/hook",
      "not-a-url",
    ]) {
      const error = rejection(base(`  - id: a\n    action: call_webhook\n    url: '${url}'\n`));
      expect(error.kind, url).toBe("InvalidDefinition");
    }
    expect(webhookDestinationRefusal("https://ci.example.com/build")).toBeNull();
  });

  it("lets a templated URL through at definition time, because it is not final yet", () => {
    const result = parseWorkflowYaml(
      base("  - id: a\n    action: call_webhook\n    url: '{{trigger.url}}'\n"),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses an unparseable duration or approval timeout", () => {
    expect(rejection(base("  - id: a\n    action: delay\n    duration: soon\n")).kind).toBe(
      "InvalidDefinition",
    );
    expect(
      rejection(
        base("  - id: a\n    action: request_approval\n    message: hi\n    timeout: whenever\n"),
      ).kind,
    ).toBe("InvalidDefinition");
  });

  it("accepts a definition the parser produced but a mutation could still mangle", () => {
    // `validateWorkflowDef` is callable on a hand-built definition, which is what
    // lets the engine re-validate a row written by an older build.
    const def: WorkflowDef = {
      name: "x",
      enabled: true,
      trigger: { on: "webhook" },
      steps: [{ id: "ok", action: { action: "delay", duration: "1s" } }],
    };
    expect(validateWorkflowDef(def)).toBeNull();
    expect(validateWorkflowDef({ ...def, steps: [] })?.kind).toBe("InvalidDefinition");
  });
});

describe("durations and cron", () => {
  it("parses the duration grammar and nothing else", () => {
    expect(parseDurationSecs("90")).toBe(90);
    expect(parseDurationSecs("2m")).toBe(120);
    expect(parseDurationSecs("4h")).toBe(14400);
    expect(parseDurationSecs("30s")).toBe(30);
    expect(parseDurationSecs("1d")).toBeNull();
    expect(parseDurationSecs("-5")).toBeNull();
    expect(parseDurationSecs("")).toBeNull();
    expect(parseDurationSecs("99999999999999999999h")).toBeNull();
  });

  it("normalizes 5- and 6-field cron to 7 fields", () => {
    expect(normalizeCron("0 9 * * 1-5")).toBe("0 0 9 * * 1-5 *");
    expect(normalizeCron("0 0 9 * * 1-5")).toBe("0 0 9 * * 1-5 *");
    expect(normalizeCron("0 0 9 * * 1-5 *")).toBe("0 0 9 * * 1-5 *");
  });

  it("matches weekdays at 09:00 UTC and nothing else", () => {
    const spec = parseCron(normalizeCron("0 9 * * 1-5"));
    expect(spec).not.toBeNull();
    // 2026-08-03 is a Monday.
    const monday9 = Date.UTC(2026, 7, 3, 9, 0, 0) / 1000;
    const monday10 = Date.UTC(2026, 7, 3, 10, 0, 0) / 1000;
    const sunday9 = Date.UTC(2026, 7, 2, 9, 0, 0) / 1000;
    expect(cronMatches(spec!, monday9)).toBe(true);
    expect(cronMatches(spec!, monday10)).toBe(false);
    expect(cronMatches(spec!, sunday9)).toBe(false);
  });

  it("returns the schedule's own instant, not the tick's — that is the claim key", () => {
    const due = Date.UTC(2026, 7, 3, 9, 0, 0) / 1000;
    // A tick 4 minutes late still fires, and reports the 09:00 instant.
    expect(cronFireInstant("0 9 * * 1-5", due + 240, 900)).toBe(due);
    // A tick outside the window does not.
    expect(cronFireInstant("0 9 * * 1-5", due + 1200, 900)).toBeNull();
  });

  it("aligns interval buckets to the epoch, so every clock agrees", () => {
    expect(intervalFireInstant(300, 1_000_000)).toBe(999_900);
    expect(intervalFireInstant(300, 1_000_199)).toBe(999_900);
    expect(intervalFireInstant(300, 1_000_200)).toBe(1_000_200);
  });

  it("refuses malformed cron fields", () => {
    for (const expr of ["0 9 * *", "* * * * 13", "60 * * * *", "0 9 * * 1-", "a b c d e"]) {
      expect(parseCron(normalizeCron(expr)), expr).toBeNull();
    }
  });
});

describe("storage shapes", () => {
  it("hashes a definition by value, not by key order", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
  });

  it("round-trips a definition to the JSON stored on the row", () => {
    const def = parsed(INCIDENT_TRIAGE);
    const json = definitionToJson(def) as { steps: Record<string, unknown>[] };
    // §1.3: the action tag and its fields sit at the same level, never nested.
    expect(json.steps[0]).toEqual({
      id: "notify",
      action: "send_message",
      text: "P1 incident detected: {{trigger.text}}",
    });
  });

  it("strips the injected webhook secret on the way out", () => {
    const withSecret = { name: "x", _webhook_secret: "s3cret" };
    expect(stripSecret(withSecret)).toEqual({ name: "x" });
    expect(Object.keys(stripSecret(withSecret))).not.toContain("_webhook_secret");
  });

  it("compares secrets without short-circuiting on content", () => {
    expect(constantTimeEquals("abcd", "abcd")).toBe(true);
    expect(constantTimeEquals("abcd", "abce")).toBe(false);
    expect(constantTimeEquals("abcd", "abcde")).toBe(false);
  });

  it("summarizes a trigger the way the list card reads it", () => {
    expect(triggerSummary({ on: "schedule", cron: "0 9 * * 1-5" })).toBe(
      "Schedule · 0 9 * * 1-5",
    );
    expect(triggerSummary({ on: "reaction_added", emoji: "🚨" })).toBe("Reaction Added · 🚨");
    expect(triggerSummary({ on: "webhook" })).toBe("Webhook");
  });
});

describe("the delay cap", () => {
  it("is below the default step timeout on purpose", () => {
    expect(MAX_DELAY_SECS).toBeLessThan(300);
  });
});
