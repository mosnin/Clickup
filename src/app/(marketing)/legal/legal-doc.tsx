import Link from "next/link";
import {
  LEGAL_DISCLAIMER,
  LEGAL_ENTITY,
  LEGAL_UPDATED,
  type LegalDoc,
} from "@/lib/legal";

// Sober legal-document renderer: a padded header, a "last updated" line, a
// template disclaimer, an on-this-page index, and prose sections with
// anchor targets. Pure typography — no icons, chips, or chrome.

function anchorId(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/^\d+\.\s*/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function LegalDocPage({ doc }: { doc: LegalDoc }) {
  return (
    <article className="px-4 pb-24 pt-32 sm:px-6 sm:pt-40">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/legal"
          className="text-sm font-medium text-ember-600 transition-colors hover:text-ember-700"
        >
          Legal
        </Link>
        <h1 className="mt-3 text-balance text-4xl font-semibold tracking-[-0.025em] sm:text-5xl">
          {doc.title}
        </h1>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground sm:text-lg">
          {doc.summary}
        </p>
        <p className="mt-6 text-sm text-muted-foreground">
          Last updated {LEGAL_UPDATED} · {LEGAL_ENTITY}
        </p>

        <div className="mt-6 rounded-2xl border border-black/[0.06] bg-white/70 px-5 py-4 text-sm leading-relaxed text-foreground/70">
          {LEGAL_DISCLAIMER}
        </div>

        <div className="mt-10 space-y-4">
          {doc.intro.map((p, i) => (
            <p key={i} className="text-[15px] leading-relaxed text-foreground/80">
              {p}
            </p>
          ))}
        </div>

        {/* On this page */}
        <nav
          aria-label="On this page"
          className="mt-12 border-t border-black/[0.07] pt-6"
        >
          <p className="text-[13px] font-medium text-muted-foreground">
            On this page
          </p>
          <ol className="mt-3 space-y-1.5">
            {doc.sections.map((s) => (
              <li key={s.heading}>
                <a
                  href={`#${anchorId(s.heading)}`}
                  className="text-sm text-foreground/75 transition-colors hover:text-foreground"
                >
                  {s.heading}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-12 space-y-12">
          {doc.sections.map((s) => (
            <section
              key={s.heading}
              id={anchorId(s.heading)}
              className="scroll-mt-28"
            >
              <h2 className="text-xl font-semibold tracking-[-0.01em]">
                {s.heading}
              </h2>
              <div className="mt-4 space-y-4">
                {s.body.map((p, i) => (
                  <p
                    key={i}
                    className="text-[15px] leading-relaxed text-foreground/80"
                  >
                    {p}
                  </p>
                ))}
              </div>
              {s.bullets && (
                <ul className="mt-4 space-y-2.5">
                  {s.bullets.map((b, i) => (
                    <li
                      key={i}
                      className="relative pl-5 text-[15px] leading-relaxed text-foreground/80 before:absolute before:left-0 before:top-[0.7em] before:h-1.5 before:w-1.5 before:-translate-y-1/2 before:rounded-full before:bg-ember-400"
                    >
                      {b}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      </div>
    </article>
  );
}
