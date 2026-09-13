"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import groups from "@/lib/website/navigation.json";
export function WebsiteMenus({ mobile = false }: { mobile?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const path = usePathname();
  useEffect(() => {
    function close(e: PointerEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(null);
    }
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return (
    <div
      ref={root}
      className={mobile ? "flex flex-col gap-2" : "flex items-center gap-1"}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
          root.current
            ?.querySelector<HTMLButtonElement>(`[data-group="${open}"]`)
            ?.focus();
          setOpen(null);
        }
      }}
    >
      {groups.map((g) => (
        <div key={g.label} className={mobile ? "relative" : "relative"}>
          <button
            data-group={g.label}
            type="button"
            aria-expanded={open === g.label}
            aria-controls={id + g.label}
            onClick={() => setOpen(open === g.label ? null : g.label)}
            className="flex min-h-11 items-center gap-2 rounded-full px-3 text-sm text-inherit hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {g.label}
            <span aria-hidden="true">{open === g.label ? "−" : "+"}</span>
          </button>
          {open === g.label && (
            <div
              id={id + g.label}
              className={
                mobile
                  ? "grid gap-1 pl-4"
                  : "absolute left-0 top-full z-50 mt-2 grid max-h-[70vh] w-64 gap-1 overflow-y-auto rounded-2xl border border-white/15 bg-[#151719] p-3 text-white shadow-xl"
              }
            >
              {g.links.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  aria-current={path === l.href ? "page" : undefined}
                  onClick={() => setOpen(null)}
                  className="block rounded-lg px-3 py-3 text-sm hover:bg-white/10 focus-visible:outline focus-visible:outline-2"
                >
                  {l.label}
                </Link>
              ))}
            </div>
          )}
        </div>
      ))}
      <Link
        href="/pricing"
        aria-current={path === "/pricing" ? "page" : undefined}
        className="rounded-full px-3 py-3 text-sm focus-visible:outline focus-visible:outline-2"
      >
        Pricing
      </Link>
    </div>
  );
}
