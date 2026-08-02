// The Chat dashboard's verification sweep.
//
// Every check here exists because the thing it checks actually went wrong
// during this build, not because it seemed like good practice. That is the
// whole selection rule — a sweep of hypotheticals is a sweep nobody runs twice.
//
//   node scripts/chat-sweep.mjs
//
// It does the static half. The dynamic half is `node tests/ui/chat-gallery/
// shoot.mjs` after `npm run build`, and its point is that somebody LOOKS at the
// PNGs: three defects in the final week were invisible to the test suite and
// obvious in a screenshot, including a fix of mine that made a control vanish
// while the code read correctly.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOTS = [
  "src/lib/buzz",
  "src/components/chat",
  "convex/buzz",
  "src/app/chat",
];
const TEST_GLOBS = ["tests"];

let failures = 0;
const note = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
};

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if ([".ts", ".tsx", ".mjs", ".css"].includes(extname(full))) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(r));
const testFiles = TEST_GLOBS.flatMap((r) => walk(r)).filter(
  (f) => f.includes("buzz-") || f.includes("chat-") || f.includes("nostr-"),
);

console.log(`\nChat sweep — ${files.length} source files, ${testFiles.length} test files\n`);

// 1. Control characters.
//
// A raw NUL used as a separator made three files register as BINARY to git and
// grep during this build. `git diff` showed nothing for a 900-line
// security-relevant module and code review silently lost it.
{
  const bad = [];
  for (const f of [...files, ...testFiles]) {
    const buf = readFileSync(f);
    for (const byte of buf) {
      if (byte < 9 || (byte > 13 && byte < 32)) {
        bad.push(f);
        break;
      }
    }
  }
  note(bad.length === 0, "no control characters in source", bad.join(", "));
}

// 2. The banned dialogs.
//
// House rule: naming uses InlineCreate, destructive actions use an undo toast.
// A confirm() asks somebody to predict whether they will regret something.
{
  const bad = files.filter((f) => {
    const src = readFileSync(f, "utf8");
    return /(?<!\/\/.*)\bwindow\.(confirm|prompt|alert)\s*\(/.test(
      src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"),
    );
  });
  note(bad.length === 0, "no window.confirm / prompt / alert", bad.join(", "));
}

// 3. No dynamic evaluation.
//
// The workflow expression evaluator's entire security posture is that it is a
// hand-rolled parser with no member-access production. An `eval(` anywhere in
// this tree would be a claim nobody can check. Its own internal method was
// renamed to `evaluate` so this grep stays meaningful.
{
  const bad = files.filter((f) => {
    const src = readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    return /(^|[^.\w])eval\s*\(/.test(src) || /new\s+Function\s*\(/.test(src);
  });
  note(bad.length === 0, "no eval / new Function", bad.join(", "));
}

// 4. Isolation from the concurrent dynamic-UI build.
//
// Chat was built beside another agent's panel/canvas system on the same branch
// point. Importing one of its modules is how a merge conflict becomes a
// rewrite.
{
  const forbidden =
    /@\/lib\/(panel|screen-layout|data-stream|component-style|panel-intent|panel-memory|provenance|nav-dock)\b|@\/components\/dashboard\/panel|convex\/(uiComponents|dataStream|screens|panelIntent)/;
  const bad = files.filter((f) => forbidden.test(readFileSync(f, "utf8")));
  note(bad.length === 0, "no imports of the concurrent build's modules", bad.join(", "));
}

// 5. The tenancy fence.
//
// Every index on a Chat table leads with the community, so that a read cannot
// skip the fence by keying on a channel id — which is only unique *within* a
// community. A new index that does not lead with the scope is the way that
// stops being true.
{
  const tables = readFileSync("convex/buzz/_tables.ts", "utf8");
  const indexes = [...tables.matchAll(/\.index\(\s*"([^"]+)"\s*,\s*\[([^\]]*)\]/g)];
  const bad = indexes
    .filter(([, name, cols]) => {
      // A natural-key lookup on a hash (event id, pubkey) is allowed: it is not
      // a range over somebody's data, and each has a comment saying so.
      const first = cols.split(",")[0]?.replace(/["\s]/g, "");
      return !["scopeType", "eventId", "pubkey", "principalType"].includes(first);
    })
    .map(([, name]) => name);
  note(bad.length === 0, "every table index leads with the scope", bad.join(", "));
}

// 6. The personal-appearance guard.
//
// The Chat theme block is scoped to :root, so a token it declares beats the
// inline style AppearanceProvider writes for a reader's own accessibility
// settings. This is the cheap version of tests/buzz-theme-scope.test.ts, kept
// here so the sweep alone would catch it.
{
  const css = readFileSync("src/app/globals.css", "utf8");
  const blocks = [...css.matchAll(/\[data-app="chat"\][^{]*\{([^}]*)\}/g)].map((m) => m[1]);
  const personal = [
    "--ui-font-scale",
    "--ui-motion-scale",
    "--ui-muted-toward-fg",
    "--ui-muted-toward-bg",
    "--ui-font-body",
    "--ui-row-height",
    "--ui-gap",
    "--ui-pad",
  ];
  const bad = blocks.flatMap((b) => personal.filter((p) => b.includes(`${p}:`)));
  note(bad.length === 0, "Chat theme declares no personal accessibility token", bad.join(", "));
}

// 7. Every route is reachable from something.
//
// Six finished surfaces shipped with no call site during this build, because
// each agent was forbidden from editing files another owned. A route nobody
// links to is the same failure one level up.
{
  const routes = walk("src/app/chat")
    .filter((f) => f.endsWith("page.tsx"))
    .map((f) => f.replace(/^src\/app/, "").replace(/\/page\.tsx$/, "") || "/");
  const linkable = files.map((f) => readFileSync(f, "utf8")).join("\n");
  const bad = routes.filter((r) => {
    if (r.includes("[")) return false; // dynamic routes are linked by template
    return !linkable.includes(`"${r}"`) && !linkable.includes(`'${r}'`) && !linkable.includes(`\`${r}`);
  });
  note(bad.length === 0, `all ${routes.length} Chat routes are linked to`, bad.join(", "));
}

// 8. Hand-written function references match their validators.
//
// The Chat UI names Convex functions by string, because the checked-in
// _generated stub predates convex/buzz/. A reference whose argument type
// disagrees with the mutation's validator compiles, typechecks, and is refused
// the moment somebody uses it — and a UI test that asserts the *caller's* shape
// passes while the feature is broken.
//
// That happened three times here: an edit addressed with `content` where the
// mutation declares `body`, the channel browser's create and join sending
// arguments that were not in the union, and the sidebar's leave omitting the
// scope entirely. Each was found by a person using the surface, not by 2,600
// tests. So: every referenced function must exist, and one that takes a scope
// must be called with one.
{
  const refs = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const re = /makeFunctionReference<\s*"(query|mutation|action)"\s*,([\s\S]*?)>\s*\(\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(src)) !== null) refs.push({ file: f, args: m[2], path: m[3] });
  }

  const fns = new Map();
  for (const f of walk("convex/buzz")) {
    const src = readFileSync(f, "utf8");
    const mod = f.replace(/^convex\//, "").replace(/\.ts$/, "");
    const decl =
      /export const (\w+)\s*=\s*(?:query|mutation|internalMutation|internalQuery|action|internalAction)\(\{\s*args:\s*\{([\s\S]{0,300}?)\}/g;
    let m;
    while ((m = decl.exec(src)) !== null)
      fns.set(`${mod}:${m[1]}`, /scopeArgs|scopeType/.test(m[2]));
    for (const mm of src.matchAll(
      /export const (\w+)\s*=\s*(?:query|mutation|internalMutation|internalQuery|action|internalAction)\(/g,
    ))
      if (!fns.has(`${mod}:${mm[1]}`)) fns.set(`${mod}:${mm[1]}`, null);
  }

  // A named argument type is resolved by looking for its declaration in the
  // same file — `PostArgs` carries the scope even though the reference does not
  // spell it out, and calling that a failure would train people to ignore this.
  // The captured text is every type argument, not just the first, so a named
  // one has to be looked up. Any identifier appearing in it that resolves to a
  // type carrying `scopeType` counts — `PostArgs` and `ScopedChannel` spell the
  // scope out in their own declarations, and calling those a failure would
  // train somebody to ignore this check, which is the only way it can fail.
  const allSource = files.map((f) => readFileSync(f, "utf8")).join("\n");
  const resolvesScope = (ref) => {
    if (/scopeType|ScopeArgs|ChatScope/.test(ref.args)) return true;
    for (const named of new Set(ref.args.match(/[A-Za-z_]\w*/g) ?? [])) {
      const decl = new RegExp(`type\\s+${named}\\s*=[^;]{0,500}?\\{([\\s\\S]{0,500}?)\\}`).exec(
        allSource,
      );
      if (decl && /scopeType/.test(decl[1])) return true;
    }
    return false;
  };

  const bad = [];
  for (const ref of refs) {
    if (!fns.has(ref.path)) bad.push(`${ref.path} does not exist (${ref.file})`);
    else if (fns.get(ref.path) === true && !resolvesScope(ref))
      bad.push(`${ref.path} takes a scope, reference does not (${ref.file})`);
  }
  note(
    bad.length === 0,
    `all ${refs.length} function references match their validators`,
    bad.join("; "),
  );
}

console.log(
  failures === 0
    ? "\nSweep clean.\n"
    : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
