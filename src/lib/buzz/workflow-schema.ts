// The workflow document: what one is, and what makes one illegal.
//
// A workflow **is** a YAML document (03-workflows-projects.md §1.2 — the kind
// 30620 event's `content` is the raw YAML), so this file owns the whole trip
// from authored text to a typed definition the engine can execute: parse,
// shape, validate. Nothing here touches Convex, a clock, or a network, which is
// what lets the engine, the (later) builder UI and the tests all consult one
// copy of the rules rather than three that drift.
//
// **The vocabulary is closed, and that is a security boundary.** Agents author
// workflows and a workflow runs with its owner's authority (§1.8), so an
// unknown `on:` or an unknown `action:` is a hard refusal rather than a field
// carried through as "extra". Buzz gets this from serde's internally-tagged
// enums; we get it from `triggerFromMap`/`actionFromMap` below, which enumerate
// every variant and every field and drop nothing silently.
//
// The YAML parser is hand-rolled and deliberately small (see `parseYamlSubset`).
// The house rule that binds `convex/_customFields.ts`'s formula parser binds
// here for the same reason: an authored string must never reach an evaluator
// that can be talked into evaluating something else. There is no `eval`, no
// `new Function`, and no dependency whose failure mode we would have to reason
// about — see also `workflow-expr.ts`, which says the same thing about the
// expression grammar and proves it.

// ---------------------------------------------------------------------------
// The error vocabulary (§1.4)
// ---------------------------------------------------------------------------

/**
 * `crates/buzz-workflow/src/error.rs:WorkflowError`, verbatim.
 *
 * Kept as a closed union rather than as free-form strings because two consumers
 * branch on it: the run finalizer decides a run's status from it, and the
 * client renders `mutation.error.message` for the author. A new failure mode is
 * a new member here, not a new sentence at a call site.
 */
export type WorkflowErrorKind =
  | "InvalidYaml"
  | "InvalidDefinition"
  | "ConditionError"
  | "TemplateError"
  | "StepTimeout"
  | "WebhookError"
  | "CapacityExceeded"
  | "Database"
  | "Unauthorized"
  | "NotImplemented";

export type WorkflowError = {
  kind: WorkflowErrorKind;
  message: string;
  /** Only `StepTimeout` carries these; §1.4 gives it two fields. */
  stepId?: string;
  timeoutSecs?: number;
};

export function workflowError(
  kind: WorkflowErrorKind,
  message: string,
  extra: { stepId?: string; timeoutSecs?: number } = {},
): WorkflowError {
  return { kind, message, ...extra };
}

/**
 * The sentence the client shows verbatim (§1.4: "surfaced to the client as
 * `invalid: workflow YAML parse error: …`").
 *
 * One formatter, because the builder renders `error.message` unaltered — so
 * whatever this returns *is* the UI copy, and a second formatter somewhere else
 * would be a second dialect of the same rejection.
 */
export function workflowRejectionMessage(error: WorkflowError): string {
  if (error.kind === "InvalidYaml" || error.kind === "InvalidDefinition") {
    return `invalid: workflow YAML parse error: ${error.message}`;
  }
  return `invalid: ${error.message}`;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: WorkflowError };

function fail<T>(kind: WorkflowErrorKind, message: string): ParseResult<T> {
  return { ok: false, error: workflowError(kind, message) };
}

// ---------------------------------------------------------------------------
// The typed definition (§1.3)
// ---------------------------------------------------------------------------

export const TRIGGER_TYPES = [
  "message_posted",
  "reaction_added",
  "diff_posted",
  "schedule",
  "webhook",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const ACTION_TYPES = [
  "send_message",
  "send_dm",
  "set_channel_topic",
  "add_reaction",
  "call_webhook",
  "request_approval",
  "delay",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export type TriggerDef =
  | { on: "message_posted"; filter?: string }
  | { on: "reaction_added"; emoji?: string }
  | { on: "diff_posted"; filter?: string }
  | { on: "schedule"; cron?: string; interval?: string }
  | { on: "webhook" };

export type ActionDef =
  | { action: "send_message"; text: string; channel?: string }
  | { action: "send_dm"; to: string; text: string }
  | { action: "set_channel_topic"; topic: string }
  | { action: "add_reaction"; emoji: string }
  | {
      action: "call_webhook";
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }
  | { action: "request_approval"; from: string; message: string; timeout: string }
  | { action: "delay"; duration: string };

export type StepDef = {
  id: string;
  name?: string;
  /** An expression evaluated by `workflow-expr.ts`. False ⇒ the step is skipped. */
  if?: string;
  timeoutSecs?: number;
  action: ActionDef;
};

export type WorkflowDef = {
  name: string;
  description?: string;
  enabled: boolean;
  trigger: TriggerDef;
  steps: StepDef[];
};

/** §1.3: the engine's default per-step timeout. */
export const DEFAULT_TIMEOUT_SECS = 300;
/**
 * §1.3: `delay` is capped **below** the default step timeout, deliberately — a
 * delay that could outlast its own timeout would fail every time it was used at
 * the top of its range, which reads as a broken engine rather than as a limit.
 */
export const MAX_DELAY_SECS = 270;
/** §1.4 rule 7: the scheduler ticks on a fixed cadence, so a sub-minute interval could never fire correctly. */
export const MIN_INTERVAL_SECS = 60;
/** §1.4 rule 3: step ids become expression variable names. */
export const MAX_STEP_ID_LEN = 64;
/** §1.9: `run_semaphore`. No queuing — exhaustion is an immediate refusal. */
export const MAX_CONCURRENT_RUNS = 100;
/** §1.3: `call_webhook` reads at most this much of a response. */
export const WEBHOOK_MAX_RESPONSE_BYTES = 1024 * 1024;
/** §1.3: `call_webhook`'s own timeout, independent of the step timeout. */
export const WEBHOOK_TIMEOUT_SECS = 10;
/** §1.11: `request_approval`'s default `timeout:`. */
export const DEFAULT_APPROVAL_TIMEOUT = "24h";

// ---------------------------------------------------------------------------
// A YAML subset, parsed by hand
// ---------------------------------------------------------------------------

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

/**
 * How much YAML is too much to be a workflow.
 *
 * These are refusals, not truncations. A document past any of them is a
 * document nobody wrote by hand, and the honest answer to one is "no" rather
 * than a definition that silently means something narrower than its text.
 */
const MAX_YAML_BYTES = 64 * 1024;
const MAX_YAML_LINES = 2000;
const MAX_YAML_DEPTH = 8;

type Line = { indent: number; text: string; lineNo: number };

class YamlError extends Error {}

const utf8 = new TextEncoder();

/**
 * Block YAML, minus everything a workflow does not need.
 *
 * Supported: block mappings, block sequences, `#` comments, plain scalars,
 * single- and double-quoted scalars, integers, floats, booleans and null.
 * **Refused with a message**: tabs, flow collections (`{}`/`[]`), anchors,
 * aliases, tags, multi-line scalars (`|`, `>`) and documents (`---`).
 *
 * Hand-rolled rather than pulled from a package, for the reason the top of this
 * file gives and one more: `js-yaml` is present in `node_modules` only as a
 * transitive dependency of something else, so depending on it here would be
 * depending on a package this project never declared — which is exactly the
 * shape of a supply-chain surprise. A parser that refuses everything outside
 * this list has no anchors to expand, no tags to resolve, and no merge keys, so
 * the whole class of YAML-parser exploits has nothing to reach.
 *
 * Refusing rather than ignoring matters: `steps: [ {id: a} ]` is a document
 * whose author meant something specific, and quietly reading it as an empty
 * list would produce a workflow that validates and never runs.
 */
export function parseYamlSubset(text: string): ParseResult<YamlValue> {
  if (utf8.encode(text).length > MAX_YAML_BYTES) {
    return fail("InvalidYaml", `document exceeds ${MAX_YAML_BYTES} bytes`);
  }
  const rawLines = text.split("\n");
  if (rawLines.length > MAX_YAML_LINES) {
    return fail("InvalidYaml", `document exceeds ${MAX_YAML_LINES} lines`);
  }

  const lines: Line[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i].replace(/\r$/, "");
    if (raw.includes("\t")) {
      return fail("InvalidYaml", `line ${i + 1}: tabs are not allowed for indentation`);
    }
    const trimmedStart = raw.replace(/^ +/, "");
    if (trimmedStart === "" || trimmedStart.startsWith("#")) continue;
    if (trimmedStart.startsWith("---") || trimmedStart.startsWith("...")) {
      return fail("InvalidYaml", `line ${i + 1}: multi-document YAML is not supported`);
    }
    lines.push({
      indent: raw.length - trimmedStart.length,
      text: trimmedStart,
      lineNo: i + 1,
    });
  }
  if (lines.length === 0) return { ok: true, value: null };

  try {
    const [value, next] = parseBlock(lines, 0, lines[0].indent, 0);
    if (next < lines.length) {
      throw new YamlError(`line ${lines[next].lineNo}: unexpected indentation`);
    }
    return { ok: true, value };
  } catch (err) {
    if (err instanceof YamlError) return fail("InvalidYaml", err.message);
    throw err;
  }
}

function parseBlock(
  lines: Line[],
  start: number,
  indent: number,
  depth: number,
): [YamlValue, number] {
  if (depth > MAX_YAML_DEPTH) {
    throw new YamlError(`line ${lines[start].lineNo}: nested more than ${MAX_YAML_DEPTH} deep`);
  }
  if (lines[start].text === "-" || lines[start].text.startsWith("- ")) {
    return parseSequence(lines, start, indent, depth);
  }
  return parseMapping(lines, start, indent, depth);
}

function parseSequence(
  lines: Line[],
  start: number,
  indent: number,
  depth: number,
): [YamlValue[], number] {
  const out: YamlValue[] = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i];
    if (line.text !== "-" && !line.text.startsWith("- ")) break;
    const rest = line.text === "-" ? "" : line.text.slice(2).trim();
    if (rest === "") {
      i += 1;
      if (i < lines.length && lines[i].indent > indent) {
        const [value, next] = parseBlock(lines, i, lines[i].indent, depth + 1);
        out.push(value);
        i = next;
      } else {
        out.push(null);
      }
      continue;
    }
    if (isMappingEntry(rest)) {
      // `- id: notify` opens a mapping whose first key sits two columns in from
      // the dash. Rewriting the line in place rather than building a sub-list is
      // what lets the *following* lines (`  action: …`, at the same effective
      // indent) join the same mapping with no special case.
      const virtual: Line = { indent: indent + 2, text: rest, lineNo: line.lineNo };
      const rewritten = [...lines.slice(0, i), virtual, ...lines.slice(i + 1)];
      const [value, next] = parseMapping(rewritten, i, indent + 2, depth + 1);
      out.push(value);
      i = next;
      continue;
    }
    out.push(parseScalar(rest, line.lineNo));
    i += 1;
  }
  return [out, i];
}

function parseMapping(
  lines: Line[],
  start: number,
  indent: number,
  depth: number,
): [{ [key: string]: YamlValue }, number] {
  const out: { [key: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i];
    if (line.text.startsWith("- ")) break;
    const split = splitMappingEntry(line.text);
    if (!split) throw new YamlError(`line ${line.lineNo}: expected "key: value"`);
    const { key, rest } = split;
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new YamlError(`line ${line.lineNo}: duplicate key: ${key}`);
    }
    if (rest === "") {
      i += 1;
      if (i < lines.length && lines[i].indent > indent) {
        const [value, next] = parseBlock(lines, i, lines[i].indent, depth + 1);
        out[key] = value;
        i = next;
      } else {
        out[key] = null;
      }
      continue;
    }
    out[key] = parseScalar(rest, line.lineNo);
    i += 1;
  }
  if (i === start) throw new YamlError(`line ${lines[start].lineNo}: expected "key: value"`);
  return [out, i];
}

/** A plain key is deliberately narrow: a workflow has no key a person would quote. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function splitMappingEntry(text: string): { key: string; rest: string } | null {
  // The separator is the first colon followed by a space or the end of the line.
  // `url: https://ci.internal/build` therefore splits once, at `url:`, because
  // the colon in `https://` has no space after it — which is why an unquoted URL
  // needs no special case.
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== ":") continue;
    if (i + 1 !== text.length && text[i + 1] !== " ") continue;
    const key = text.slice(0, i).trim();
    if (!KEY_RE.test(key)) return null;
    return { key, rest: text.slice(i + 1).trim() };
  }
  return null;
}

function isMappingEntry(text: string): boolean {
  return splitMappingEntry(text) !== null;
}

function parseScalar(raw: string, lineNo: number): YamlValue {
  if (raw.startsWith("'")) return parseQuoted(raw, lineNo, "'");
  if (raw.startsWith('"')) return parseQuoted(raw, lineNo, '"');
  if (raw.startsWith("{") || raw.startsWith("[")) {
    throw new YamlError(`line ${lineNo}: flow collections are not supported; use block style`);
  }
  if (raw === "|" || raw === ">" || raw.startsWith("|") || raw.startsWith(">")) {
    throw new YamlError(`line ${lineNo}: block scalars are not supported; quote the value`);
  }
  if (raw.startsWith("&") || raw.startsWith("*") || raw.startsWith("!")) {
    throw new YamlError(`line ${lineNo}: anchors, aliases and tags are not supported`);
  }
  // A `#` starts a comment only when something separates it from the value.
  const commentAt = raw.search(/\s#/);
  const body = (commentAt === -1 ? raw : raw.slice(0, commentAt)).trim();
  if (body === "" || body === "null" || body === "~") return null;
  if (body === "true") return true;
  if (body === "false") return false;
  if (/^-?\d+$/.test(body)) {
    const n = Number(body);
    return Number.isSafeInteger(n) ? n : body;
  }
  if (/^-?\d+\.\d+$/.test(body)) return Number(body);
  return body;
}

function parseQuoted(raw: string, lineNo: number, quote: "'" | '"'): string {
  let out = "";
  let i = 1;
  while (i < raw.length) {
    const ch = raw[i];
    if (quote === "'" && ch === "'") {
      if (raw[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return finishQuoted(out, raw.slice(i + 1), lineNo);
    }
    if (quote === '"' && ch === "\\") {
      const next = raw[i + 1];
      if (next === undefined) throw new YamlError(`line ${lineNo}: dangling escape`);
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      i += 2;
      continue;
    }
    if (quote === '"' && ch === '"') {
      return finishQuoted(out, raw.slice(i + 1), lineNo);
    }
    out += ch;
    i += 1;
  }
  throw new YamlError(`line ${lineNo}: unterminated quoted string`);
}

function finishQuoted(value: string, trailing: string, lineNo: number): string {
  const rest = trailing.trim();
  if (rest !== "" && !rest.startsWith("#")) {
    throw new YamlError(`line ${lineNo}: unexpected text after a quoted value`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Document → definition
// ---------------------------------------------------------------------------

function isMap(value: YamlValue): value is { [key: string]: YamlValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A required string field. `null` and a missing key are the same failure on
 * purpose: `text:` with nothing after it is a field the author started and did
 * not finish, and reading it as `""` would post an empty message.
 */
function requireString(
  map: { [key: string]: YamlValue },
  key: string,
  where: string,
): string {
  const value = map[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new YamlError(`${where}: "${key}" is required and must be a string`);
}

function optionalString(
  map: { [key: string]: YamlValue },
  key: string,
  where: string,
): string | undefined {
  const value = map[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new YamlError(`${where}: "${key}" must be a string`);
}

/**
 * Every key a variant is allowed to carry, checked rather than ignored.
 *
 * The closed-vocabulary rule, applied at the field level. An unrecognised key is
 * an author who believes the engine does something it does not — `retries: 3`
 * silently dropped is a workflow that does not retry and says it does.
 */
function refuseUnknownKeys(
  map: { [key: string]: YamlValue },
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(map)) {
    if (!allowed.includes(key)) throw new YamlError(`${where}: unknown field "${key}"`);
  }
}

function triggerFromMap(map: { [key: string]: YamlValue }): TriggerDef {
  const on = map.on;
  if (typeof on !== "string") throw new YamlError('trigger: "on" is required');
  switch (on) {
    case "message_posted":
      refuseUnknownKeys(map, ["on", "filter"], "trigger");
      return { on, ...optional("filter", optionalString(map, "filter", "trigger")) };
    case "diff_posted":
      refuseUnknownKeys(map, ["on", "filter"], "trigger");
      return { on, ...optional("filter", optionalString(map, "filter", "trigger")) };
    case "reaction_added":
      refuseUnknownKeys(map, ["on", "emoji"], "trigger");
      return { on, ...optional("emoji", optionalString(map, "emoji", "trigger")) };
    case "schedule":
      refuseUnknownKeys(map, ["on", "cron", "interval"], "trigger");
      return {
        on,
        ...optional("cron", optionalString(map, "cron", "trigger")),
        ...optional("interval", optionalString(map, "interval", "trigger")),
      };
    case "webhook":
      refuseUnknownKeys(map, ["on"], "trigger");
      return { on };
    default:
      // serde's "unknown variant" (§1.3). Named rather than generic, because the
      // author's next move is to correct the word they typed.
      throw new YamlError(
        `trigger: unknown trigger type "${on}" (expected ${TRIGGER_TYPES.join(", ")})`,
      );
  }
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function actionFromMap(map: { [key: string]: YamlValue }, where: string): ActionDef {
  const action = map.action;
  if (typeof action !== "string") throw new YamlError(`${where}: "action" is required`);
  const common = ["id", "name", "if", "timeout_secs", "action"];
  switch (action) {
    case "send_message":
      refuseUnknownKeys(map, [...common, "text", "channel"], where);
      return {
        action,
        text: requireString(map, "text", where),
        ...optional("channel", optionalString(map, "channel", where)),
      };
    case "send_dm":
      refuseUnknownKeys(map, [...common, "to", "text"], where);
      return {
        action,
        to: requireString(map, "to", where),
        text: requireString(map, "text", where),
      };
    case "set_channel_topic":
      refuseUnknownKeys(map, [...common, "topic"], where);
      return { action, topic: requireString(map, "topic", where) };
    case "add_reaction":
      refuseUnknownKeys(map, [...common, "emoji"], where);
      return { action, emoji: requireString(map, "emoji", where) };
    case "call_webhook": {
      refuseUnknownKeys(map, [...common, "url", "method", "headers", "body"], where);
      const headersValue = map.headers;
      const headers: Record<string, string> = {};
      if (headersValue !== undefined && headersValue !== null) {
        if (!isMap(headersValue)) throw new YamlError(`${where}: "headers" must be a mapping`);
        for (const [name, value] of Object.entries(headersValue)) {
          if (typeof value === "object" && value !== null) {
            throw new YamlError(`${where}: header "${name}" must be a scalar`);
          }
          headers[name] = value === null ? "" : String(value);
        }
      }
      return {
        action,
        url: requireString(map, "url", where),
        method: (optionalString(map, "method", where) ?? "POST").toUpperCase(),
        headers,
        ...optional("body", optionalString(map, "body", where)),
      };
    }
    case "request_approval":
      refuseUnknownKeys(map, [...common, "from", "message", "timeout"], where);
      return {
        action,
        // `from:` is the approver spec and an absent one means "anyone", which
        // is `check_approver_spec`'s `""` case (§1.11) — so an omitted field is
        // a real, meaningful value here rather than a missing one.
        from: optionalString(map, "from", where) ?? "",
        message: requireString(map, "message", where),
        timeout: optionalString(map, "timeout", where) ?? DEFAULT_APPROVAL_TIMEOUT,
      };
    case "delay":
      refuseUnknownKeys(map, [...common, "duration"], where);
      return { action, duration: requireString(map, "duration", where) };
    default:
      throw new YamlError(
        `${where}: unknown action type "${action}" (expected ${ACTION_TYPES.join(", ")})`,
      );
  }
}

function stepFromValue(value: YamlValue, index: number): StepDef {
  const where = `steps[${index}]`;
  if (!isMap(value)) throw new YamlError(`${where}: each step must be a mapping`);
  const id = optionalString(value, "id", where) ?? "";
  const timeoutRaw = value.timeout_secs;
  let timeoutSecs: number | undefined;
  if (timeoutRaw !== undefined && timeoutRaw !== null) {
    const n = typeof timeoutRaw === "number" ? timeoutRaw : Number(timeoutRaw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new YamlError(`${where}: "timeout_secs" must be a positive integer`);
    }
    timeoutSecs = n;
  }
  return {
    id,
    ...optional("name", optionalString(value, "name", where)),
    ...optional("if", optionalString(value, "if", where)),
    ...optional("timeoutSecs", timeoutSecs),
    action: actionFromMap(value, where),
  };
}

/** The whole trip: text → typed definition, validated. */
export function parseWorkflowYaml(text: string): ParseResult<WorkflowDef> {
  const doc = parseYamlSubset(text);
  if (!doc.ok) return doc;
  const shaped = workflowFromDocument(doc.value);
  if (!shaped.ok) return shaped;
  const invalid = validateWorkflowDef(shaped.value);
  if (invalid) return { ok: false, error: invalid };
  return shaped;
}

export function workflowFromDocument(doc: YamlValue): ParseResult<WorkflowDef> {
  try {
    if (!isMap(doc)) throw new YamlError("a workflow must be a mapping");
    refuseUnknownKeys(doc, ["name", "description", "enabled", "trigger", "steps"], "workflow");
    const trigger = doc.trigger;
    if (!isMap(trigger)) throw new YamlError('"trigger" is required and must be a mapping');
    const steps = doc.steps;
    if (!Array.isArray(steps)) throw new YamlError('"steps" is required and must be a list');
    const enabled = doc.enabled;
    if (enabled !== undefined && enabled !== null && typeof enabled !== "boolean") {
      throw new YamlError('"enabled" must be true or false');
    }
    return {
      ok: true,
      value: {
        name: typeof doc.name === "string" ? doc.name : String(doc.name ?? ""),
        ...optional(
          "description",
          doc.description === undefined || doc.description === null
            ? undefined
            : String(doc.description),
        ),
        enabled: enabled === undefined || enabled === null ? true : enabled,
        trigger: triggerFromMap(trigger),
        steps: steps.map(stepFromValue),
      },
    };
  } catch (err) {
    if (err instanceof YamlError) return fail("InvalidYaml", err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Validation (§1.4)
// ---------------------------------------------------------------------------

/**
 * §1.4 rule 3, and the reason it is this strict.
 *
 * A step id becomes an expression *variable* name (`steps_<ID>_output_<FIELD>`),
 * so `my-step` would parse as subtraction and `my step` as two tokens. Rather
 * than teach the grammar to quote identifiers — which is how a grammar grows a
 * string-to-name path — the id is restricted to what is already a legal
 * identifier. See `workflow-expr.ts`: its name resolution is a flat lookup with
 * no quoting, no indexing and no member access, and this rule is what keeps
 * that possible.
 */
const STEP_ID_RE = /^[A-Za-z0-9_]+$/;

export function validateWorkflowDef(def: WorkflowDef): WorkflowError | null {
  if (def.name.trim() === "") {
    return workflowError("InvalidDefinition", "workflow name cannot be empty");
  }
  if (def.steps.length === 0) {
    return workflowError("InvalidDefinition", "workflow must have at least one step");
  }
  const seen = new Set<string>();
  for (const step of def.steps) {
    if (step.id === "") {
      return workflowError("InvalidDefinition", "step id cannot be empty");
    }
    if (step.id.length > MAX_STEP_ID_LEN) {
      return workflowError(
        "InvalidDefinition",
        `step id too long: ${step.id} (max ${MAX_STEP_ID_LEN})`,
      );
    }
    if (!STEP_ID_RE.test(step.id)) {
      return workflowError(
        "InvalidDefinition",
        `invalid step id: ${step.id} (only A-Z, a-z, 0-9 and _ are allowed)`,
      );
    }
    if (seen.has(step.id)) {
      return workflowError("InvalidDefinition", `duplicate step id: ${step.id}`);
    }
    seen.add(step.id);

    if (step.action.action === "call_webhook") {
      // Checked at definition time as well as at call time. The URL is
      // templated, so the call-time check is the one that has to hold — but
      // refusing an unusable URL while the author is looking at it is the
      // difference between a mistake and a run that fails at 3am.
      const refusal = webhookDestinationRefusal(step.action.url);
      if (refusal && !containsTemplate(step.action.url)) {
        return workflowError("InvalidDefinition", `step ${step.id}: ${refusal}`);
      }
    }
    if (step.action.action === "delay") {
      const secs = parseDurationSecs(step.action.duration);
      if (secs === null) {
        return workflowError(
          "InvalidDefinition",
          `step ${step.id}: invalid duration: ${step.action.duration}`,
        );
      }
    }
    if (step.action.action === "request_approval") {
      const secs = parseDurationSecs(step.action.timeout);
      if (secs === null) {
        return workflowError(
          "InvalidDefinition",
          `step ${step.id}: invalid timeout: ${step.action.timeout}`,
        );
      }
    }
  }

  if (def.trigger.on === "schedule") {
    const hasCron = def.trigger.cron !== undefined && def.trigger.cron !== "";
    const hasInterval = def.trigger.interval !== undefined && def.trigger.interval !== "";
    if (hasCron === hasInterval) {
      return workflowError(
        "InvalidDefinition",
        hasCron
          ? "schedule trigger accepts either cron or interval, not both"
          : "schedule trigger requires either cron or interval",
      );
    }
    if (hasCron && parseCron(normalizeCron(def.trigger.cron as string)) === null) {
      return workflowError("InvalidDefinition", `invalid cron expression: ${def.trigger.cron}`);
    }
    if (hasInterval) {
      const secs = parseDurationSecs(def.trigger.interval as string);
      if (secs === null) {
        return workflowError("InvalidDefinition", `invalid interval: ${def.trigger.interval}`);
      }
      if (secs < MIN_INTERVAL_SECS) {
        return workflowError(
          "InvalidDefinition",
          `interval must be at least ${MIN_INTERVAL_SECS} seconds`,
        );
      }
    }
  }

  return null;
}

function containsTemplate(text: string): boolean {
  return text.includes("{{");
}

/**
 * §1.8 (SEC-006). True iff any step is `call_webhook`.
 *
 * The one action that can move channel content to a destination its author
 * chose, and the one place a `headers:` map holds a bearer token in plain sight
 * of anyone who can read the definition. Everything else a workflow can do, it
 * does inside the room it is scoped to.
 */
export function requiresElevatedAuthority(def: WorkflowDef): boolean {
  return def.steps.some((step) => step.action.action === "call_webhook");
}

// ---------------------------------------------------------------------------
// Duration and cron grammars (§1.3)
// ---------------------------------------------------------------------------

/** `<n>h`, `<n>m`, `<n>s`, or a bare integer meaning seconds. Null on anything else. */
export function parseDurationSecs(input: string): number | null {
  const text = input.trim();
  const match = /^(\d+)([hms]?)$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) return null;
  const factor = match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1;
  const total = value * factor;
  // Buzz calls overflow on the multiply an error; ours is the safe-integer
  // boundary, which is the same rule expressed in the arithmetic we have.
  return Number.isSafeInteger(total) ? total : null;
}

/**
 * §1.3: the cron library wants 7 fields (`sec min hour dom month dow year`).
 *
 * A 5-field expression gets `0` prepended and `*` appended, a 6-field one gets
 * `*` appended, and a 7-field one passes through — so `0 9 * * 1-5` becomes
 * `0 0 9 * * 1-5 *`. All cron times are UTC, which is stated rather than
 * configurable: a schedule that moved twice a year with the author's timezone
 * would fire at a different hour for half the year without anything changing.
 */
export function normalizeCron(expr: string): string {
  const fields = expr.trim().split(/\s+/).filter((f) => f !== "");
  if (fields.length === 5) return ["0", ...fields, "*"].join(" ");
  if (fields.length === 6) return [...fields, "*"].join(" ");
  return fields.join(" ");
}

export type CronSpec = {
  second: number[];
  minute: number[];
  hour: number[];
  dayOfMonth: number[] | null;
  month: number[];
  dayOfWeek: number[] | null;
  year: number[] | null;
};

const CRON_RANGES: [number, number][] = [
  [0, 59], // second
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week — 0 and 7 are both Sunday
  [1970, 2999], // year
];

/**
 * A 7-field cron expression, or null.
 *
 * `*` on day-of-month or day-of-week becomes `null` rather than "every value",
 * because the two fields are ORed when both are restricted (standard cron) and a
 * `null` is how "this one does not narrow anything" is said without a second
 * flag. `*` on `year` is the same idea.
 */
export function parseCron(expr: string): CronSpec | null {
  const fields = expr.trim().split(/\s+/).filter((f) => f !== "");
  if (fields.length !== 7) return null;
  const parsed: (number[] | null)[] = [];
  for (let i = 0; i < 7; i += 1) {
    const values = parseCronField(fields[i], CRON_RANGES[i][0], CRON_RANGES[i][1]);
    if (values === undefined) return null;
    parsed.push(values);
  }
  const [second, minute, hour, dayOfMonth, month, dayOfWeek, year] = parsed;
  if (second === null || minute === null || hour === null || month === null) {
    // Only dom/dow/year carry the "unrestricted" meaning; a `*` in the other
    // fields is every value, which `parseCronField` already expanded.
    return null;
  }
  return { second, minute, hour, dayOfMonth, month, dayOfWeek, year };
}

/** `undefined` = malformed. `null` = `*` on a field where that means "unrestricted". */
function parseCronField(field: string, min: number, max: number): number[] | null | undefined {
  if (field === "*") {
    if (min === 1 && max === 31) return null; // day of month
    if (min === 0 && max === 7) return null; // day of week
    if (min === 1970) return null; // year
    return range(min, max, 1);
  }
  const out = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "") return undefined;
    const [spec, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step <= 0) return undefined;
    let lo: number;
    let hi: number;
    if (spec === "*") {
      lo = min;
      hi = max;
    } else if (spec.includes("-")) {
      const [a, b] = spec.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(spec);
      hi = stepText === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      return undefined;
    }
    for (const value of range(lo, hi, step)) out.add(value === 7 && max === 7 ? 0 : value);
  }
  return [...out].sort((a, b) => a - b);
}

function range(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let v = lo; v <= hi; v += step) out.push(v);
  return out;
}

export function cronMatches(spec: CronSpec, unixSecs: number): boolean {
  const date = new Date(unixSecs * 1000);
  if (!spec.second.includes(date.getUTCSeconds())) return false;
  if (!spec.minute.includes(date.getUTCMinutes())) return false;
  if (!spec.hour.includes(date.getUTCHours())) return false;
  if (!spec.month.includes(date.getUTCMonth() + 1)) return false;
  if (spec.year !== null && !spec.year.includes(date.getUTCFullYear())) return false;
  const dom = spec.dayOfMonth;
  const dow = spec.dayOfWeek;
  const domOk = dom === null || dom.includes(date.getUTCDate());
  const dowOk = dow === null || dow.includes(date.getUTCDay());
  // Standard cron: when both are restricted they are ORed, not ANDed. `0 9 1 * 1`
  // means "the 1st, and every Monday", which is what a person writing it expects.
  if (dom !== null && dow !== null) return domOk || dowOk;
  return domOk && dowOk;
}

/**
 * The instant a cron schedule was *due*, inside the tick's window — or null.
 *
 * §1.10: the returned instant is the cron's own scheduled time and not `now`,
 * so every fire computes the same claim key however late or early the tick ran.
 * That is the whole reason this returns an instant rather than a boolean: the
 * at-most-once claim is keyed on it, and a key derived from `now` would let two
 * ticks a second apart both claim the same nominal fire.
 *
 * The scan is bounded by `windowSecs` and by `MAX_CRON_SCAN`, so a `*` in the
 * seconds field costs a bounded walk rather than an unbounded one.
 */
export const MAX_CRON_SCAN = 3600;

export function cronFireInstant(
  expr: string,
  nowSecs: number,
  windowSecs: number,
): number | null {
  const spec = parseCron(normalizeCron(expr));
  if (!spec) return null;
  const span = Math.min(Math.max(windowSecs, 0), MAX_CRON_SCAN);
  for (let t = nowSecs - span + 1; t <= nowSecs; t += 1) {
    if (cronMatches(spec, t)) return t;
  }
  return null;
}

/**
 * The bucket an interval schedule is currently in.
 *
 * `floor(now / interval) * interval` — epoch-aligned, so the anchor is the same
 * number computed from any clock inside the bucket. Buzz needs an in-memory
 * pre-filter on top of this because its claim table is one round trip away on
 * every pod; ours is a row in the same transaction, so the claim is the whole
 * mechanism and there is no second, weaker copy of it to keep in sync.
 */
export function intervalFireInstant(intervalSecs: number, nowSecs: number): number {
  return Math.floor(nowSecs / intervalSecs) * intervalSecs;
}

// ---------------------------------------------------------------------------
// The outbound destination rule
// ---------------------------------------------------------------------------

/**
 * Why this is here and not imported from `convex/_webhookNetwork.ts`.
 *
 * That module is the app's SSRF guard and it is the right one — but it is
 * `"use node"` (it resolves DNS and pins the address), and a Convex module in
 * the default V8 runtime cannot import a Node module at all. So the *syntactic*
 * half of the rule is restated here, as a pure function both the validator and
 * the calling action use, and the comment in `workflows.ts:callWebhook` states
 * plainly which half is therefore missing: DNS resolution and address pinning
 * are not available in the runtime a workflow step runs in.
 *
 * What compensates, and it is not nothing: §1.8 makes `call_webhook` the one
 * action requiring `owner`/`admin` authority, re-checked at every fire — so an
 * ordinary member cannot author one at all, and an author who loses the role
 * stops being able to fire the one they wrote.
 */
export function webhookDestinationRefusal(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "webhook url must be an absolute https:// URL";
  }
  if (url.protocol !== "https:") return "webhook url must start with https://";
  if (url.username !== "" || url.password !== "") {
    return "webhook url must not carry credentials";
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "") return "webhook url must name a host";
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  ) {
    return "webhook url may not name a private host";
  }
  if (isUnsafeHostLiteral(host)) return "webhook url may not name a private address";
  return null;
}

/** IPv4/IPv6 literals that must never be reachable from a workflow. */
function isUnsafeHostLiteral(host: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b, c] = [Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (host.includes(":")) {
    // Any IPv6 literal. Refused wholesale rather than range-checked: the address
    // space has enough encodings of "the machine next to me" (mapped v4, zone
    // ids, compressed forms) that an allowlist is the only side of this worth
    // being on, and a workflow calling an IPv6 literal is nobody's real use.
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Canonical JSON (§1.2)
// ---------------------------------------------------------------------------

/**
 * A definition as stable bytes.
 *
 * `definition_hash` is SHA-256 of this, and §1.2 records the ordering contract
 * that goes with it: the hash is computed **after** webhook-secret injection, so
 * the hash names the definition the engine will actually run rather than the one
 * the author submitted. Key order is sorted here so two saves of the same
 * document hash the same whatever order the parser produced.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The definition as the plain JSON object stored in the row (and hashed). */
export function definitionToJson(def: WorkflowDef): Record<string, unknown> {
  return {
    name: def.name,
    ...(def.description === undefined ? {} : { description: def.description }),
    enabled: def.enabled,
    trigger: { ...def.trigger },
    steps: def.steps.map((step) => ({
      id: step.id,
      ...(step.name === undefined ? {} : { name: step.name }),
      ...(step.if === undefined ? {} : { if: step.if }),
      ...(step.timeoutSecs === undefined ? {} : { timeout_secs: step.timeoutSecs }),
      ...step.action,
    })),
  };
}

/** §1.7: the injected key. Never returned by any read — see `stripSecret`. */
export const WEBHOOK_SECRET_KEY = "_webhook_secret";

/** §1.7: `strip_secret`, applied on the way out of every read surface. */
export function stripSecret(definition: Record<string, unknown>): Record<string, unknown> {
  const { [WEBHOOK_SECRET_KEY]: _secret, ...rest } = definition;
  return rest;
}

/**
 * §1.7: constant-time comparison of the presented secret against the stored one.
 *
 * Length is allowed to short-circuit, exactly as Buzz allows it: every secret
 * this engine generates is the same length, so the length carries no
 * information about the value.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Display helpers the (later) UI phase reads
// ---------------------------------------------------------------------------

/** §1.13: `getWorkflowTriggerSummary` — `"<Label> · <detail>"`. */
export function triggerSummary(trigger: TriggerDef): string {
  switch (trigger.on) {
    case "message_posted":
      return trigger.filter ? `Message Posted · ${trigger.filter}` : "Message Posted";
    case "diff_posted":
      return trigger.filter ? `Diff Posted · ${trigger.filter}` : "Diff Posted";
    case "reaction_added":
      return trigger.emoji ? `Reaction Added · ${trigger.emoji}` : "Reaction Added";
    case "schedule":
      return `Schedule · ${trigger.cron ?? trigger.interval ?? ""}`;
    case "webhook":
      return "Webhook";
  }
}
