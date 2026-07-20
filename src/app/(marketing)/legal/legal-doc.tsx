import Link from "next/link";
import { Container } from "@/components/marketing/ui";
import {
  LEGAL_DISCLAIMER,
  LEGAL_ENTITY,
  LEGAL_UPDATED,
  type LegalDoc,
} from "@/lib/legal";

// Sober legal-document renderer: breadcrumb, title, effective date, a
// template disclaimer, and restrained prose sections with anchor targets.
// Pure typography — no icons, chips, or animation.

function anchorId(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/^\d+\.\s*/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function LegalDocPage({ doc }: { doc: LegalDoc }) {
  return (
    <article>
      <Container className="max-w-2xl pb-24 pt-32">
        <Link
          href="/legal"
          aria-label="Back to Legal center"
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Legal
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">
          {doc.title}
        </h1>
        <p className="mt-2 text-xs text-muted-foreground">
          Last updated {LEGAL_UPDATED} &middot; {LEGAL_ENTITY}
        </p>

        <p className="mt-6 text-[15px] leading-relaxed text-foreground/80">
          {doc.summary}
        </p>

        <p className="mt-6 border-t border-border pt-6 text-sm leading-relaxed text-muted-foreground">
          {LEGAL_DISCLAIMER}
        </p>

        <div className="mt-10 space-y-4">
          {doc.intro.map((p, i) => (
            <p key={i} className="text-[15px] leading-relaxed text-foreground/80">
              {p}
            </p>
          ))}
        </div>

        {doc.sections.map((s) => (
          <section key={s.heading} id={anchorId(s.heading)} className="scroll-mt-28">
            <h2 className="mt-10 text-lg font-semibold">{s.heading}</h2>
            {s.body.map((p, i) => (
              <p key={i} className="mt-4 text-[15px] leading-relaxed text-foreground/80">
                {p}
              </p>
            ))}
            {s.bullets && (
              <ul className="mt-4 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-foreground/80">
                {s.bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </Container>
    </article>
  );
}
