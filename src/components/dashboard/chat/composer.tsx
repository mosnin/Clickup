"use client";

import { useEffect, useRef, useState } from "react";
import { SendHorizontal } from "lucide-react";
import {
  SuggestionMenu,
  type MenuSection,
} from "@/components/dashboard/page-editor/suggestion-menu";
import { cn } from "@/lib/utils";

// The chat composer.
//
// A textarea rather than a Tiptap document, on purpose: a message is one
// paragraph of prose that happens to contain tokens, and mounting a ProseMirror
// instance per composer to type "on it" is the wrong trade. What it borrows
// from the page editor is the part that matters — the same popup component and
// the same keyboard contract, so `@` behaves identically in a page and in a
// message.
//
// Three triggers, one grammar:
//   @  people and agents      → @[Name](actorId)
//   #  projects, lists, tasks → #[Label](kind:id)
//   /  commands               → run something, don't insert text

export type Mentionable = { id: string; name: string; kind: "user" | "agent" };
export type RefTarget = {
  kind: "project" | "list" | "task" | "page" | "sprint" | "goal";
  id: string;
  label: string;
  context?: string;
};
export type ChatCommand = {
  name: string;
  hint: string;
  /** Given whatever followed the command name, do the thing. */
  run: (argument: string) => void | Promise<void>;
};

type Trigger = "@" | "#" | "/";

type ActiveMenu = {
  trigger: Trigger;
  /** Index in the text where the trigger character sits. */
  at: number;
  query: string;
};

export function ChatComposer({
  mentionables,
  refTargets,
  commands,
  placeholder,
  disabled,
  onSend,
  onTyping,
}: {
  mentionables: Mentionable[];
  refTargets: RefTarget[];
  commands: ChatCommand[];
  placeholder: string;
  disabled?: boolean;
  onSend: (body: string) => void | Promise<void>;
  onTyping?: () => void;
}) {
  const [value, setValue] = useState("");
  const [menu, setMenu] = useState<ActiveMenu | null>(null);
  const [index, setIndex] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  // Grow with the content up to a ceiling, then scroll. A composer that
  // scrolls at two lines hides what you just wrote; one that grows forever
  // pushes the conversation off screen.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const sections = menu ? buildSections(menu, { mentionables, refTargets, commands }) : [];
  const rows = sections.flatMap((s) => s.rows);
  const active = rows[index];

  /** Find the trigger the caret is currently inside, if any. */
  function detectMenu(text: string, caret: number): ActiveMenu | null {
    for (let i = caret - 1; i >= 0 && caret - i <= 60; i -= 1) {
      const ch = text[i];
      if (ch === "\n") return null;
      if (ch !== "@" && ch !== "#" && ch !== "/") continue;
      // A trigger only counts at the start or after whitespace, so an email
      // address doesn't open the mention menu and "and/or" doesn't open
      // commands.
      const before = i === 0 ? " " : text[i - 1];
      if (!/\s/.test(before)) return null;
      // `/` is a command only as the very first thing in the message.
      if (ch === "/" && i !== 0) return null;
      const query = text.slice(i + 1, caret);
      if (/[\s]/.test(query)) return null;
      return { trigger: ch, at: i, query };
    }
    return null;
  }

  function update(text: string, caret: number) {
    setValue(text);
    const next = detectMenu(text, caret);
    setMenu(next);
    setIndex(0);
    if (text.trim()) onTyping?.();
  }

  function replaceToken(insert: string) {
    if (!menu) return;
    const el = areaRef.current;
    const caret = el?.selectionStart ?? value.length;
    const next = `${value.slice(0, menu.at)}${insert} ${value.slice(caret)}`;
    setValue(next);
    setMenu(null);
    requestAnimationFrame(() => {
      const pos = menu.at + insert.length + 1;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  }

  function pick(row: MenuRowValue) {
    if (row.t === "mention") {
      replaceToken(`@[${row.name}](${row.id})`);
      return;
    }
    if (row.t === "ref") {
      replaceToken(`#[${row.label.replace(/[[\]()]/g, "")}](${row.kind}:${row.id})`);
      return;
    }
    // A command consumes the whole message: "/task Fix the header" is an
    // instruction, not text to send.
    const argument = value.slice(menu!.at + 1 + row.command.name.length).trim();
    setValue("");
    setMenu(null);
    void row.command.run(argument);
  }

  async function send() {
    const body = value.trim();
    if (!body || disabled) return;

    // A message that is only a command runs it instead of being sent, so
    // typing "/task Ship it" and pressing Enter does what it says.
    const commandMatch = /^\/([a-z-]+)\s*([\s\S]*)$/.exec(body);
    if (commandMatch) {
      const command = commands.find((c) => c.name === commandMatch[1]);
      if (command) {
        setValue("");
        await command.run(commandMatch[2].trim());
        return;
      }
    }
    setValue("");
    await onSend(body);
  }

  return (
    <div className="relative">
      {menu && rows.length > 0 && (
        <div className="absolute bottom-full left-0 z-30 mb-2">
          <SuggestionMenu
            sections={sections}
            activeKey={active?.key ?? null}
            emptyLabel=""
            onPick={(row) => pick(row)}
          />
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={areaRef}
          value={value}
          rows={1}
          disabled={disabled}
          aria-label="Message"
          placeholder={placeholder}
          onChange={(e) =>
            update(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)
          }
          onKeyDown={(e) => {
            if (menu && rows.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => (i + 1) % rows.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => (i - 1 + rows.length) % rows.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                if (active) pick(active.value);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMenu(null);
                return;
              }
            }
            // Enter sends, Shift+Enter breaks the line — the convention
            // every chat app shares, so nobody has to learn it here.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          className="soft-field max-h-[200px] min-h-[2.5rem] w-full resize-none px-3 py-2 text-sm leading-relaxed"
        />
        <button
          type="button"
          aria-label="Send message"
          disabled={disabled || !value.trim()}
          onClick={() => void send()}
          className={cn(
            "tap-target mb-0.5 inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full transition-colors",
            value.trim() && !disabled
              ? "bg-foreground text-background"
              : "bg-muted text-muted-foreground",
          )}
        >
          <SendHorizontal className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

type MenuRowValue =
  | { t: "mention"; id: string; name: string }
  | { t: "ref"; kind: RefTarget["kind"]; id: string; label: string }
  | { t: "command"; command: ChatCommand };

function buildSections(
  menu: ActiveMenu,
  data: {
    mentionables: Mentionable[];
    refTargets: RefTarget[];
    commands: ChatCommand[];
  },
): MenuSection<MenuRowValue>[] {
  const needle = menu.query.toLowerCase();

  if (menu.trigger === "@") {
    const matches = data.mentionables
      .filter((m) => m.name.toLowerCase().includes(needle))
      .slice(0, 8);
    return [
      {
        heading: "People",
        rows: matches
          .filter((m) => m.kind === "user")
          .map((m) => ({
            key: m.id,
            label: m.name,
            value: { t: "mention" as const, id: m.id, name: m.name },
          })),
      },
      {
        heading: "Agents",
        rows: matches
          .filter((m) => m.kind === "agent")
          .map((m) => ({
            key: m.id,
            label: m.name,
            meta: "agent",
            value: { t: "mention" as const, id: m.id, name: m.name },
          })),
      },
    ];
  }

  if (menu.trigger === "#") {
    const matches = data.refTargets
      .filter((r) => r.label.toLowerCase().includes(needle))
      .slice(0, 10);
    // Grouped by kind so "which of the four things called Billing" is
    // answerable at a glance.
    const order: RefTarget["kind"][] = [
      "project",
      "list",
      "page",
      "task",
      "sprint",
      "goal",
    ];
    return order
      .map((kind) => ({
        heading: `${kind}s`,
        rows: matches
          .filter((r) => r.kind === kind)
          .map((r) => ({
            key: `${r.kind}:${r.id}`,
            label: r.label,
            meta: r.context,
            value: {
              t: "ref" as const,
              kind: r.kind,
              id: r.id,
              label: r.label,
            },
          })),
      }))
      .filter((s) => s.rows.length > 0);
  }

  return [
    {
      heading: "Commands",
      rows: data.commands
        .filter((c) => c.name.includes(needle))
        .map((c) => ({
          key: c.name,
          label: `/${c.name}`,
          hint: c.hint,
          value: { t: "command" as const, command: c },
        })),
    },
  ];
}
