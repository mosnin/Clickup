// Natural-language quick add: "Ship the deck tomorrow !high" becomes a
// task titled "Ship the deck" due tomorrow with high priority. Used by the
// command palette and every inline task composer, so the grammar is one
// place and always behaves the same.
//
// Grammar (deliberately small and predictable):
//   Priority   !urgent !high !normal !low
//   Dates      today · tomorrow/tmr · <weekday> · next <weekday> ·
//              next week · in N days · in N weeks
//              (an optional leading "on/by/due" is absorbed: "by friday")
// Date phrases resolve to local midnight, matching the date-input helpers.

export type QuickPriority = "urgent" | "high" | "normal" | "low";

export type ParsedQuickAdd = {
  title: string;
  dueDate?: number;
  priority?: QuickPriority;
  /** Human labels for what was recognized, for preview chips. */
  matched: { kind: "due" | "priority"; label: string }[];
};

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

/** Next occurrence of a weekday strictly after `now` (1..7 days out). */
function nextWeekday(now: Date, weekday: number): Date {
  const diff = (weekday - now.getDay() + 7) % 7 || 7;
  return addDays(now, diff);
}

function formatDue(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function parseQuickAdd(input: string, now = new Date()): ParsedQuickAdd {
  let text = input;
  const matched: ParsedQuickAdd["matched"] = [];
  let dueDate: number | undefined;
  let priority: QuickPriority | undefined;

  // ── Priority: !urgent / !high / !normal / !low ──
  const priMatch = text.match(/(^|\s)!(urgent|high|normal|low)\b/i);
  if (priMatch) {
    priority = priMatch[2].toLowerCase() as QuickPriority;
    text = text.replace(priMatch[0], " ");
  }

  // ── Dates (first match wins) ──
  const lead = "(?:^|\\s)(?:(?:on|by|due)\\s+)?";
  const datePatterns: {
    re: RegExp;
    resolve: (m: RegExpMatchArray) => Date | null;
  }[] = [
    { re: new RegExp(`${lead}(today|tonight)\\b`, "i"), resolve: () => now },
    {
      re: new RegExp(`${lead}(tomorrow|tmr)\\b`, "i"),
      resolve: () => addDays(now, 1),
    },
    {
      re: new RegExp(`${lead}next\\s+week\\b`, "i"),
      resolve: () => nextWeekday(now, 1), // next Monday
    },
    {
      re: new RegExp(`${lead}next\\s+(${WEEKDAYS.join("|")})\\b`, "i"),
      resolve: (m) =>
        nextWeekday(now, WEEKDAYS.indexOf(m[1].toLowerCase())),
    },
    {
      re: new RegExp(`${lead}(${WEEKDAYS.join("|")})\\b`, "i"),
      resolve: (m) =>
        nextWeekday(now, WEEKDAYS.indexOf(m[1].toLowerCase())),
    },
    {
      re: new RegExp(`${lead}in\\s+(\\d{1,3})\\s+days?\\b`, "i"),
      resolve: (m) => addDays(now, parseInt(m[1], 10)),
    },
    {
      re: new RegExp(`${lead}in\\s+(\\d{1,2})\\s+weeks?\\b`, "i"),
      resolve: (m) => addDays(now, parseInt(m[1], 10) * 7),
    },
  ];

  for (const { re, resolve } of datePatterns) {
    const m = text.match(re);
    if (!m) continue;
    const d = resolve(m);
    if (!d) continue;
    dueDate = localMidnight(d);
    text = text.replace(m[0], " ");
    break;
  }

  if (dueDate !== undefined) {
    matched.push({ kind: "due", label: formatDue(dueDate) });
  }
  if (priority) {
    matched.push({
      kind: "priority",
      label: priority.charAt(0).toUpperCase() + priority.slice(1),
    });
  }

  return {
    title: text.replace(/\s{2,}/g, " ").trim(),
    dueDate,
    priority,
    matched,
  };
}
