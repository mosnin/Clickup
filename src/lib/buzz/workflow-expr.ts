// The expression evaluator, and the template resolver. **This file is a
// security boundary.**
//
// Agents author workflows. A workflow runs with its owner's authority (§1.8),
// inside a Convex transaction, with the ability to post into a room and to call
// an outbound URL. Every `if:`, every trigger `filter:` and every `{{ }}` in a
// workflow is therefore a string written by one principal and evaluated on
// behalf of another, which is the exact shape of an injection surface. So:
//
//   1. **Hand-rolled recursive descent.** There is no `eval`, no `new Function`,
//      no `with`, no dynamic `import`, no regex-driven "just replace the
//      variables" pass, and no template library. The house rule that binds
//      `convex/_customFields.ts`'s formula parser (CLAUDE.md: "parsed by a
//      hand-rolled recursive-descent parser, never `eval`") binds here, and for
//      a strictly worse threat model — a formula is written by the workspace's
//      own members, a workflow may be written by a machine.
//   2. **A closed set of registered helpers.** `HELPERS` is the entire function
//      vocabulary. A call to anything else is a refusal, not a lookup — there is
//      no path from an authored name to a JavaScript function.
//   3. **Names resolve in a `Map`, and nothing else.** Variables are looked up
//      in a `Map<string, ExprValue>`, which has no prototype chain, so
//      `constructor`, `__proto__`, `toString` and `hasOwnProperty` are simply
//      names that are not there and produce the same refusal any other unknown
//      name does. There is no member access, no indexing and no property syntax
//      **in the grammar at all**, so there is nothing to walk even if a value
//      were an object — which none of them are: the value domain is string,
//      number and boolean.
//   4. **Hard caps on time and output.** Length, token count, nesting depth,
//      evaluation steps and produced-string length are all bounded, and every
//      bound is a refusal rather than a truncation. Buzz caps wall-clock at
//      100 ms on a blocking thread and admits in its own source that the thread
//      cannot actually be cancelled, which is why its length cap exists. We have
//      no thread to cancel either — a Convex mutation is one deterministic
//      isolate — so the caps are on *work* rather than on time: an operation
//      budget refuses the same pathological input on every machine, at every
//      load, reproducibly, which a wall clock does not.
//
// `tests/buzz-workflow-expr.test.ts` feeds this `constructor`, `__proto__`, a
// deeply nested expression and a pathological repetition, and demands a refusal
// rather than a hang.
//
// Pure: no ctx, no clock, no I/O. Source of truth: 03-workflows-projects.md
// §1.5 (templates) and §1.6 (conditions).

import { workflowError, type WorkflowError } from "./workflow-schema";

// ---------------------------------------------------------------------------
// The value domain
// ---------------------------------------------------------------------------

/**
 * Three kinds of value and no fourth.
 *
 * Deliberately not "any JSON": if a variable could be an object, the grammar
 * would eventually grow a way to reach into one, and reaching into an object is
 * where prototypes live. A step output that is an object or an array is
 * flattened to its fields (`steps_ID_output_FIELD`) or stringified, upstream in
 * `buildEvalContext`, where the flattening is visible.
 */
export type ExprValue = string | number | boolean;

export type ExprContext = ReadonlyMap<string, ExprValue>;

// ---------------------------------------------------------------------------
// The budgets
// ---------------------------------------------------------------------------

/** §1.6: `MAX_EXPR_LEN`. Bytes, not characters — the cap is about work. */
export const MAX_EXPR_LEN = 4096;
/** Tokens one expression may contain. A repetition attack dies here first. */
export const MAX_EXPR_TOKENS = 512;
/** Parser recursion. `((((…))))` refuses instead of exhausting the stack. */
export const MAX_EXPR_DEPTH = 32;
/** Node visits during evaluation. The operation budget that replaces a clock. */
export const MAX_EXPR_STEPS = 4096;
/** The longest string any operator or helper may produce. */
export const MAX_EXPR_STRING = 4096;
/** §1.5: the longest string a template may resolve to. */
export const MAX_TEMPLATE_OUTPUT = 64 * 1024;

const utf8 = new TextEncoder();

/**
 * The one error this file throws.
 *
 * Carries a `WorkflowError` so callers do not re-classify: an `if:` failure is a
 * `ConditionError` and a `{{ }}` failure is a `TemplateError`, and the caller
 * that has to decide "does this fail the run or skip the workflow" reads the
 * kind rather than a message.
 */
export class ExprRefusal extends Error {
  readonly workflow: WorkflowError;
  constructor(kind: "ConditionError" | "TemplateError", message: string) {
    super(message);
    this.name = "ExprRefusal";
    this.workflow = workflowError(kind, message);
  }
}

function refuse(message: string): never {
  throw new ExprRefusal("ConditionError", message);
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ident"; v: string }
  | { t: "op"; v: string }
  | { t: "lparen" }
  | { t: "rparen" }
  | { t: "comma" };

const TWO_CHAR_OPS = new Set(["==", "!=", "<=", ">=", "&&", "||"]);
const ONE_CHAR_OPS = new Set(["<", ">", "+", "-", "*", "/", "%", "!"]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    if (tokens.length > MAX_EXPR_TOKENS) {
      refuse(`expression has more than ${MAX_EXPR_TOKENS} tokens`);
    }
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ t: "lparen" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ t: "rparen" });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ t: "comma" });
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const [value, next] = readString(source, i, ch);
      tokens.push({ t: "str", v: value });
      i = next;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      const match = /^\d+(\.\d+)?/.exec(source.slice(i));
      if (!match) refuse(`malformed number at position ${i}`);
      tokens.push({ t: "num", v: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z0-9_]+/.exec(source.slice(i));
      if (!match) refuse(`malformed identifier at position ${i}`);
      tokens.push({ t: "ident", v: match[0] });
      i += match[0].length;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.has(ch)) {
      tokens.push({ t: "op", v: ch });
      i += 1;
      continue;
    }
    // Unknown character. Loud, and it names the character: an expression with a
    // smart quote in it is the single most common way one of these is written
    // wrong, and "unexpected character" without the character is a riddle.
    refuse(`unexpected character ${JSON.stringify(ch)} at position ${i}`);
  }
  if (tokens.length > MAX_EXPR_TOKENS) {
    refuse(`expression has more than ${MAX_EXPR_TOKENS} tokens`);
  }
  return tokens;
}

function readString(source: string, start: number, quote: string): [string, number] {
  let out = "";
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === undefined) refuse("dangling escape in string literal");
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      i += 2;
      continue;
    }
    if (ch === quote) return [out, i + 1];
    if (out.length >= MAX_EXPR_STRING) refuse("string literal too long");
    out += ch;
    i += 1;
  }
  refuse("unterminated string literal");
}

// ---------------------------------------------------------------------------
// The grammar
// ---------------------------------------------------------------------------

type Node =
  | { n: "lit"; v: ExprValue }
  | { n: "var"; name: string }
  | { n: "call"; name: string; args: Node[] }
  | { n: "unary"; op: string; arg: Node }
  | { n: "binary"; op: string; left: Node; right: Node };

/**
 * Recursive descent, one function per precedence level.
 *
 * The grammar is written out rather than table-driven on purpose: every
 * production is visible, and there is no production for member access, indexing,
 * assignment, sequencing or anything else that could reach outside the value
 * domain. That absence is the point — a reader can check it by reading.
 */
class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.or();
    if (this.pos < this.tokens.length) {
      refuse("unexpected trailing input in expression");
    }
    return node;
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > MAX_EXPR_DEPTH) {
      refuse(`expression nested deeper than ${MAX_EXPR_DEPTH}`);
    }
  }

  private leave(): void {
    this.depth -= 1;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private eatOp(...ops: string[]): string | null {
    const token = this.peek();
    if (token && token.t === "op" && ops.includes(token.v)) {
      this.pos += 1;
      return token.v;
    }
    return null;
  }

  private binaryLevel(ops: string[], next: () => Node): Node {
    this.enter();
    let left = next();
    for (;;) {
      const op = this.eatOp(...ops);
      if (!op) break;
      left = { n: "binary", op, left, right: next() };
    }
    this.leave();
    return left;
  }

  private or(): Node {
    return this.binaryLevel(["||"], () => this.and());
  }
  private and(): Node {
    return this.binaryLevel(["&&"], () => this.equality());
  }
  private equality(): Node {
    return this.binaryLevel(["==", "!="], () => this.comparison());
  }
  private comparison(): Node {
    return this.binaryLevel(["<", "<=", ">", ">="], () => this.additive());
  }
  private additive(): Node {
    return this.binaryLevel(["+", "-"], () => this.multiplicative());
  }
  private multiplicative(): Node {
    return this.binaryLevel(["*", "/", "%"], () => this.unary());
  }

  private unary(): Node {
    const op = this.eatOp("!", "-");
    if (op) {
      this.enter();
      const arg = this.unary();
      this.leave();
      return { n: "unary", op, arg };
    }
    return this.primary();
  }

  private primary(): Node {
    const token = this.peek();
    if (!token) refuse("expression ended unexpectedly");
    if (token.t === "num") {
      this.pos += 1;
      return { n: "lit", v: token.v };
    }
    if (token.t === "str") {
      this.pos += 1;
      return { n: "lit", v: token.v };
    }
    if (token.t === "lparen") {
      this.pos += 1;
      this.enter();
      const inner = this.or();
      this.leave();
      const close = this.peek();
      if (!close || close.t !== "rparen") refuse("unbalanced parentheses");
      this.pos += 1;
      return inner;
    }
    if (token.t === "ident") {
      this.pos += 1;
      if (token.v === "true") return { n: "lit", v: true };
      if (token.v === "false") return { n: "lit", v: false };
      const next = this.peek();
      if (next && next.t === "lparen") {
        this.pos += 1;
        const args: Node[] = [];
        if (this.peek()?.t !== "rparen") {
          this.enter();
          for (;;) {
            args.push(this.or());
            if (this.peek()?.t === "comma") {
              this.pos += 1;
              continue;
            }
            break;
          }
          this.leave();
        }
        const close = this.peek();
        if (!close || close.t !== "rparen") refuse("unbalanced parentheses in call");
        this.pos += 1;
        return { n: "call", name: token.v, args };
      }
      return { n: "var", name: token.v };
    }
    refuse("unexpected token in expression");
  }
}

// ---------------------------------------------------------------------------
// The registered helpers (§1.6)
// ---------------------------------------------------------------------------

type Helper = { arity: number; call: (args: ExprValue[]) => ExprValue };

function asString(value: ExprValue, fn: string, index: number): string {
  if (typeof value === "string") return value;
  refuse(`${fn}: argument ${index + 1} must be a string`);
}

/**
 * The whole function vocabulary. Four names.
 *
 * A `Map` rather than an object literal, for the same reason the variable
 * context is one: an object literal would answer `HELPERS.constructor` with a
 * function, and the difference between "closed vocabulary" and "closed
 * vocabulary plus everything Object.prototype carries" is the difference
 * between this being safe and this being a bug report.
 */
const HELPERS: ReadonlyMap<string, Helper> = new Map<string, Helper>([
  [
    "str_contains",
    {
      arity: 2,
      call: (a) => asString(a[0], "str_contains", 0).includes(asString(a[1], "str_contains", 1)),
    },
  ],
  [
    "str_starts_with",
    {
      arity: 2,
      call: (a) =>
        asString(a[0], "str_starts_with", 0).startsWith(asString(a[1], "str_starts_with", 1)),
    },
  ],
  [
    "str_ends_with",
    {
      arity: 2,
      call: (a) =>
        asString(a[0], "str_ends_with", 0).endsWith(asString(a[1], "str_ends_with", 1)),
    },
  ],
  [
    "str_len",
    { arity: 1, call: (a) => [...asString(a[0], "str_len", 0)].length },
  ],
]);

/** Exported so a builder UI can offer exactly what the engine implements. */
export const HELPER_NAMES: readonly string[] = [...HELPERS.keys()];

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

class Evaluator {
  private steps = 0;
  constructor(private readonly context: ExprContext) {}

  evaluate(node: Node): ExprValue {
    this.steps += 1;
    if (this.steps > MAX_EXPR_STEPS) {
      refuse(`expression exceeded ${MAX_EXPR_STEPS} evaluation steps`);
    }
    switch (node.n) {
      case "lit":
        return node.v;
      case "var": {
        // `Map.get`, and nothing else. An unknown name is an error rather than
        // `undefined`, matching evalexpr — and it is what makes `__proto__` and
        // `constructor` land in the same refusal as `typo_here`.
        const value = this.context.get(node.name);
        if (value === undefined) refuse(`unknown variable: ${node.name}`);
        return value;
      }
      case "call": {
        const helper = HELPERS.get(node.name);
        if (!helper) refuse(`unknown function: ${node.name}`);
        if (node.args.length !== helper.arity) {
          refuse(`${node.name} takes ${helper.arity} argument(s)`);
        }
        return helper.call(node.args.map((arg) => this.evaluate(arg)));
      }
      case "unary": {
        const value = this.evaluate(node.arg);
        if (node.op === "!") {
          if (typeof value !== "boolean") refuse("! expects a boolean");
          return !value;
        }
        if (typeof value !== "number") refuse("unary - expects a number");
        return -value;
      }
      case "binary":
        return this.binary(node);
    }
  }

  private binary(node: { op: string; left: Node; right: Node }): ExprValue {
    // Short-circuit before evaluating the right side: `a && b(…)` must not run
    // `b` when `a` is false, both because that is what `&&` means and because a
    // guard like `str_len(x) > 0 && str_contains(x, …)` is the ordinary way an
    // author avoids the error case.
    if (node.op === "&&" || node.op === "||") {
      const left = this.evaluate(node.left);
      if (typeof left !== "boolean") refuse(`${node.op} expects booleans`);
      if (node.op === "&&" && !left) return false;
      if (node.op === "||" && left) return true;
      const right = this.evaluate(node.right);
      if (typeof right !== "boolean") refuse(`${node.op} expects booleans`);
      return right;
    }

    const left = this.evaluate(node.left);
    const right = this.evaluate(node.right);

    if (node.op === "==") return left === right;
    if (node.op === "!=") return left !== right;

    if (node.op === "+") {
      if (typeof left === "string" && typeof right === "string") {
        const joined = left + right;
        if (joined.length > MAX_EXPR_STRING) {
          refuse(`string longer than ${MAX_EXPR_STRING} characters`);
        }
        return joined;
      }
      if (typeof left === "number" && typeof right === "number") return left + right;
      refuse("+ expects two numbers or two strings");
    }

    if (typeof left !== "number" || typeof right !== "number") {
      refuse(`${node.op} expects two numbers`);
    }
    switch (node.op) {
      case "-":
        return left - right;
      case "*":
        return left * right;
      case "/":
        if (right === 0) refuse("division by zero");
        return left / right;
      case "%":
        if (right === 0) refuse("division by zero");
        return left % right;
      case "<":
        return left < right;
      case "<=":
        return left <= right;
      case ">":
        return left > right;
      case ">=":
        return left >= right;
      default:
        refuse(`unknown operator: ${node.op}`);
    }
  }
}

/** Parse and evaluate, returning any value. Throws `ExprRefusal`. */
export function evaluateExpression(source: string, context: ExprContext): ExprValue {
  if (utf8.encode(source).length > MAX_EXPR_LEN) {
    refuse(`expression longer than ${MAX_EXPR_LEN} bytes`);
  }
  if (source.trim() === "") refuse("empty expression");
  const ast = new Parser(tokenize(source)).parse();
  return new Evaluator(context).evaluate(ast);
}

/**
 * The boolean an `if:` or a `filter:` has to produce.
 *
 * A non-boolean is a refusal rather than a truthiness coercion. `if: "1"` under
 * coercion is a step that always runs and reads like a step that sometimes
 * does; naming it lets the author fix it.
 */
export function evaluateCondition(source: string, context: ExprContext): boolean {
  const value = evaluateExpression(source, context);
  if (typeof value !== "boolean") refuse("condition did not evaluate to a boolean");
  return value;
}

/**
 * The trigger-filter form: **fail closed, never throw** (§1.6).
 *
 * A filter that errors skips the workflow. That asymmetry with `if:` (which
 * fails the run) is deliberate and is Buzz's: a filter decides whether anything
 * happens at all, so an ambiguous answer must mean "no", and a broken filter on
 * a busy channel must not manufacture a failed run per message.
 */
export function filterAllows(source: string, context: ExprContext): boolean {
  try {
    return evaluateCondition(source, context);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The trigger context (§1.5, §1.6)
// ---------------------------------------------------------------------------

export type TriggerContext = {
  /** Event content — the message body. Empty for schedule runs. */
  text: string;
  /** Pubkey hex: an `actor` tag if the event carries one, else the event's own pubkey. */
  author: string;
  channelId: string;
  /** Unix seconds. */
  timestamp: number;
  /** Reaction content for kind 7, else empty. */
  emoji: string;
  /** For a reaction, the target message; for everything else, the event's own id. */
  messageId: string;
  /** Webhook / manual-trigger body fields, already stringified. */
  webhookFields: Record<string, string>;
};

export function emptyTriggerContext(
  overrides: Partial<TriggerContext> = {},
): TriggerContext {
  return {
    text: "",
    author: "",
    channelId: "",
    timestamp: 0,
    emoji: "",
    messageId: "",
    webhookFields: {},
    ...overrides,
  };
}

/** What a step wrote, keyed by step id. Only objects — §1.5 says one level deep. */
export type StepOutputs = Record<string, Record<string, unknown>>;

/**
 * The six canonical names, plus the flattened webhook fields and step outputs.
 *
 * §1.6's safety rule, and the order below **is** the rule: webhook fields are
 * registered first so the canonical `trigger_*` names overwrite them, and a body
 * key starting `trigger_` or `steps_` is dropped outright. A webhook caller can
 * therefore never spoof `trigger_author` — which matters because an `if:` in
 * somebody else's workflow may well be `trigger_author == '<a pubkey>'`.
 *
 * Two dropped keys are dropped silently. That is the one place in this file
 * where silence is right: the caller is an arbitrary HTTP client, and telling it
 * which names are reserved is telling it what to aim at.
 */
export function buildEvalContext(
  trigger: TriggerContext,
  stepOutputs: StepOutputs = {},
): ExprContext {
  const context = new Map<string, ExprValue>();

  for (const [key, value] of Object.entries(trigger.webhookFields)) {
    if (key.startsWith("trigger_") || key.startsWith("steps_")) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    context.set(`trigger_${key}`, value);
  }

  context.set("trigger_text", trigger.text);
  context.set("trigger_author", trigger.author);
  context.set("trigger_channel_id", trigger.channelId);
  context.set("trigger_timestamp", trigger.timestamp);
  context.set("trigger_emoji", trigger.emoji);
  context.set("trigger_message_id", trigger.messageId);

  for (const [stepId, output] of Object.entries(stepOutputs)) {
    if (!/^[A-Za-z0-9_]+$/.test(stepId)) continue;
    for (const [field, value] of Object.entries(output)) {
      if (!/^[A-Za-z0-9_]+$/.test(field)) continue;
      context.set(`steps_${stepId}_output_${field}`, coerceToExprValue(value));
    }
  }

  return context;
}

/**
 * A JSON value, as one of the three the grammar knows.
 *
 * Booleans and numbers survive as themselves — `steps_request_output_approved
 * == true` in §1.14's approval fixture depends on that — and everything with
 * structure becomes its JSON text, which is comparable and searchable with
 * `str_contains` and cannot be reached into.
 */
function coerceToExprValue(value: unknown): ExprValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null || value === undefined) return "";
  return JSON.stringify(value) ?? "";
}

// ---------------------------------------------------------------------------
// Templates (§1.5)
// ---------------------------------------------------------------------------

/**
 * `{{ path }}` / `{{ path | filter }}`, resolved in a **single pass**.
 *
 * Not recursive, and that is a security property rather than a simplification:
 * a resolved value is never re-scanned, so a message body containing the literal
 * text `{{trigger.author}}` cannot cause a second substitution round. It is also
 * why the whole thing is a hand-written scanner rather than a `String.replace`
 * with a callback — `replace` on a pattern the *result* also matches is exactly
 * the bug that makes template engines re-entrant.
 *
 * Unknown variables are emitted literally (`{{unknown.var}}` stays), and an
 * unclosed `{{` is emitted literally and stops parsing. Both are Buzz's
 * behaviour and both are the right ones: a template is authored prose, and a
 * typo should look like a typo rather than delete the sentence around it.
 */
export function resolveTemplate(
  text: string,
  trigger: TriggerContext,
  stepOutputs: StepOutputs = {},
): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{{", i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    const close = text.indexOf("}}", open + 2);
    if (close === -1) {
      // Unclosed: emit the rest literally and stop, exactly as Buzz does.
      out += text.slice(open);
      break;
    }
    const inner = text.slice(open + 2, close);
    out += resolveOne(inner, text.slice(open, close + 2), trigger, stepOutputs);
    if (out.length > MAX_TEMPLATE_OUTPUT) {
      throw new ExprRefusal("TemplateError", `template output exceeds ${MAX_TEMPLATE_OUTPUT} characters`);
    }
    i = close + 2;
  }
  if (out.length > MAX_TEMPLATE_OUTPUT) {
    throw new ExprRefusal("TemplateError", `template output exceeds ${MAX_TEMPLATE_OUTPUT} characters`);
  }
  return out;
}

function resolveOne(
  inner: string,
  literal: string,
  trigger: TriggerContext,
  stepOutputs: StepOutputs,
): string {
  const pipe = inner.indexOf("|");
  const path = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const filter = pipe === -1 ? null : inner.slice(pipe + 1).trim();

  const value = lookupTemplatePath(path, trigger, stepOutputs);
  // Unknown variable ⇒ the whole `{{ … }}` survives verbatim. Note that this
  // happens *before* the filter is looked at, which is why `{{nope | truncate(4)}}`
  // is literal rather than a TemplateError: an unknown filter on a known value
  // is an author mistake worth naming, an unknown filter on an unknown value is
  // just text.
  if (value === undefined) return literal;
  if (filter === null) return value;
  return applyFilter(value, filter);
}

function lookupTemplatePath(
  path: string,
  trigger: TriggerContext,
  stepOutputs: StepOutputs,
): string | undefined {
  const parts = path.split(".");
  if (parts[0] === "trigger" && parts.length === 2) {
    switch (parts[1]) {
      case "text":
        return trigger.text;
      case "author":
        return trigger.author;
      case "channel_id":
        return trigger.channelId;
      case "timestamp":
        return String(trigger.timestamp);
      case "emoji":
        return trigger.emoji;
      case "message_id":
        return trigger.messageId;
      default:
        // §1.5: `trigger.<anything else>` is a webhook body field.
        return trigger.webhookFields[parts[1]];
    }
  }
  if (parts.length === 4 && parts[0] === "steps" && parts[2] === "output") {
    const output = stepOutputs[parts[1]];
    if (!output) return undefined;
    // `hasOwnProperty` via `Object.prototype`, not via the object: a step output
    // arrives as parsed JSON and `output.constructor` would otherwise resolve.
    if (!Object.prototype.hasOwnProperty.call(output, parts[3])) return undefined;
    return jsonToString(output[parts[3]]);
  }
  return undefined;
}

/** §1.5: strings unwrapped, bool/number stringified, null empty, anything else its JSON text. */
export function jsonToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value) ?? "";
}

function applyFilter(value: string, filter: string): string {
  const truncate = /^truncate\(\s*(\d+)\s*\)$/.exec(filter);
  if (truncate) {
    // Characters, not bytes: `chars().take(n)`. Slicing bytes out of a UTF-8
    // string splits an emoji in half, and the one place this filter is reached
    // for is chat text.
    return [...value].slice(0, Number(truncate[1])).join("");
  }
  if (filter === "npub" || filter === "truncate_pubkey") {
    return npubOrPassthrough(value);
  }
  throw new ExprRefusal("TemplateError", `unknown filter: ${filter}`);
}

/**
 * §1.5: bech32-encode a hex pubkey **in full**; anything that is not one passes
 * through untouched.
 *
 * "In full" is load-bearing and Buzz says why: a truncated npub prefix is
 * grindable — an attacker can search for a key whose npub shares the displayed
 * prefix and then be mistaken for its owner. The alias `truncate_pubkey` is kept
 * because workflows in the wild are written with it, and it does the same
 * non-truncating thing, deliberately.
 */
function npubOrPassthrough(value: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return value;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bech32Encode("npub", bytes);
}

// ---------------------------------------------------------------------------
// bech32 (BIP-173), for `npub`
// ---------------------------------------------------------------------------
//
// Thirty lines rather than a dependency. Encoding only — nothing in this app
// decodes an npub (`src/lib/buzz/search-query.ts` says so and explains why), so
// a decoder would be untested surface carried for nobody.

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const ch of hrp) out.push(ch.charCodeAt(0) >>> 5);
  out.push(0);
  for (const ch of hrp) out.push(ch.charCodeAt(0) & 31);
  return out;
}

function convertBits(data: Uint8Array, from: number, to: number): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const byte of data) {
    acc = (acc << from) | byte;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (bits > 0) out.push((acc << (to - bits)) & maxv);
  return out;
}

export function bech32Encode(hrp: string, data: Uint8Array): string {
  const words = convertBits(data, 8, 5);
  const values = [...bech32HrpExpand(hrp), ...words];
  const polymod = bech32Polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i += 1) checksum.push((polymod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => BECH32_CHARSET[w]).join("")}`;
}
