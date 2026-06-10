"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PaceWordmark } from "@/components/brand/pace-mark";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/about", label: "About" },
];

export function PillHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 px-3 pt-3 sm:px-6 sm:pt-6">
      <nav
        aria-label="Primary"
        className="mx-auto flex max-w-6xl items-center justify-between gap-2 rounded-full border border-border bg-background/80 px-3 py-2 shadow-sm backdrop-blur-md sm:px-5"
      >
        <Link href="/" className="px-2">
          <PaceWordmark />
        </Link>

        <ul className="hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>

        <div className="hidden items-center gap-2 md:flex">
          <Link href="/sign-in">
            <Button variant="ghost" size="sm">
              Log in
            </Button>
          </Link>
          <Link href="/sign-up">
            <Button size="sm">Get started</Button>
          </Link>
        </div>

        <button
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-muted md:hidden"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </nav>

      <div
        className={cn(
          "mx-auto mt-2 max-w-6xl overflow-hidden rounded-3xl border border-border bg-background shadow-sm transition-all md:hidden",
          open ? "max-h-96 opacity-100" : "pointer-events-none max-h-0 opacity-0",
        )}
      >
        <ul className="flex flex-col p-2">
          {NAV.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={() => setOpen(false)}
                className="block rounded-2xl px-4 py-3 text-sm hover:bg-muted"
              >
                {item.label}
              </Link>
            </li>
          ))}
          <li className="mt-2 grid grid-cols-2 gap-2 p-2">
            <Link href="/sign-in" onClick={() => setOpen(false)}>
              <Button variant="outline" className="w-full" size="sm">
                Log in
              </Button>
            </Link>
            <Link href="/sign-up" onClick={() => setOpen(false)}>
              <Button className="w-full" size="sm">
                Get started
              </Button>
            </Link>
          </li>
        </ul>
      </div>
    </header>
  );
}
