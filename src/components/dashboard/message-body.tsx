"use client";

import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Rendering a message body.
//
// This builds React nodes directly rather than producing an HTML string,
// which is the whole security posture: there is no `dangerouslySetInnerHTML`
// here, so no sanitizer to keep correct. A body is written by people AND by
// agents, and an agent that has read a malicious document must not be able to
// put script into a teammate's browser.
//
// It covers the inline subset a message actually uses — bold, italic, code,
// links, and the app's three tokens — and nothing else. Messages are prose,
// not documents; a message that needs a table wants to be a page.

export type MessageRef = { kind: string; id: string; label: string };
export type ResolvedRef = MessageRef & { href: string | null };

type Token =
  | { t: "text"; value: string }
  | { t: "bold"; value: string }
  | { t: "italic"; value: string }
  | { t: "code"; value: string }
  | { t: "link"; label: string; href: string }
  | { t: "mention"; label: string; id: string }
  | { t: "ref"; label: string; kind: string; id: string }
  | { t: "page"; title: string };

// One pass, longest-token-first, so `**bold**` isn't eaten by the `*italic*`
// rule and `@[x](y)` isn't eaten by the link rule.
const PATTERNS: { re: RegExp; make: (m: RegExpExecArray) => Token }[] = [
  {
    re: /^`([^`]+)`/,
    make: (m) => ({ t: "code", value: m[1] }),
  },
  {
    re: /^@\[([^\]\n]+)\]\(([^)\s]+)\)/,
    make: (m) => ({ t: "mention", label: m[1], id: m[2] }),
  },
  {
    re: /^#\[([^\]\n]+)\]\(([a-z]+):([^)\s]+)\)/,
    make: (m) => ({ t: "ref", label: m[1], kind: m[2], id: m[3] }),
  },
  {
    re: /^\[\[([^\]\n]+)\]\]/,
    make: (m) => ({ t: "page", title: m[1] }),
  },
  {
    re: /^\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/,
    make: (m) => ({ t: "link", label: m[1] || m[2], href: m[2] }),
  },
  {
    re: /^\*\*([^*\n]+)\*\*/,
    make: (m) => ({ t: "bold", value: m[1] }),
  },
  {
    re: /^\*([^*\n]+)\*/,
    make: (m) => ({ t: "italic", value: m[1] }),
  },
];

export function tokenizeBody(body: string): Token[] {
  const out: Token[] = [];
  let rest = body;
  let plain = "";

  const flush = () => {
    if (plain) {
      out.push({ t: "text", value: plain });
      plain = "";
    }
  };

  while (rest.length > 0) {
    let matched = false;
    for (const { re, make } of PATTERNS) {
      const m = re.exec(rest);
      if (!m) continue;
      flush();
      out.push(make(m));
      rest = rest.slice(m[0].length);
      matched = true;
      break;
    }
    if (matched) continue;
    plain += rest[0];
    rest = rest.slice(1);
  }
  flush();
  return out;
}

export function MessageBody({
  body,
  resolved,
  className,
}: {
  body: string;
  /** Hrefs for the references in this message, from chat.resolveRefs. */
  resolved?: ResolvedRef[];
  className?: string;
}) {
  const hrefFor = (kind: string, id: string) =>
    resolved?.find((r) => r.kind === kind && r.id === id)?.href ?? null;

  return (
    <div className={cn("whitespace-pre-wrap break-words text-sm", className)}>
      {body.split("\n").map((line, lineIndex) => (
        <Fragment key={lineIndex}>
          {lineIndex > 0 && <br />}
          {tokenizeBody(line).map((token, i) => (
            <Fragment key={i}>{renderToken(token, hrefFor)}</Fragment>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

function renderToken(
  token: Token,
  hrefFor: (kind: string, id: string) => string | null,
): ReactNode {
  switch (token.t) {
    case "text":
      return token.value;
    case "bold":
      return <strong className="font-semibold">{token.value}</strong>;
    case "italic":
      return <em>{token.value}</em>;
    case "code":
      return (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {token.value}
        </code>
      );
    case "link":
      return (
        <a
          href={token.href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-muted-foreground underline-offset-2 hover:decoration-foreground"
        >
          {token.label}
        </a>
      );
    case "mention":
      return <span className="page-mention">@{token.label}</span>;
    case "page": {
      // A [[title]] in a message has no id to resolve against, so it reads as
      // a name rather than pretending to be a link.
      return <span className="page-wikilink-missing">{token.title}</span>;
    }
    case "ref": {
      const href = hrefFor(token.kind, token.id);
      const chip = (
        <span className="message-ref">
          <span className="message-ref-kind">{token.kind}</span>
          {token.label}
        </span>
      );
      // An unresolved reference (deleted project, no access) renders as a
      // dead chip rather than a link to a 404.
      return href ? <Link href={href}>{chip}</Link> : chip;
    }
  }
}
