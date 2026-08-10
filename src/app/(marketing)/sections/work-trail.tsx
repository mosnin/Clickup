import { Container, SectionHeading } from "@/components/marketing/ui";
import { CodeTrailCard } from "@/components/marketing/code-trail/CodeTrailCard";

// The trail of work an agent leaves behind it.
//
// Placed just before the closing CTA, where the page stops describing features
// and starts describing what a day looks like. The section either side of it is
// prose; this is the only block on the page that does nothing until you touch
// it, which is most of why it belongs here — after a long scroll, an element
// that answers the pointer is a reason to still be reading.
//
// It is fragments of source rather than task titles on purpose. Every other
// surface on this page shows the human view of the work; this one shows what is
// underneath it, cut mid-expression, layered, and running off the edge of the
// frame — a window onto something larger, which is the accurate picture of what
// a fleet is doing while you are not looking at it.

export function WorkTrail() {
  return (
    <section className="bg-background py-24 sm:py-28">
      <Container>
        <SectionHeading
          eyebrow="Observability"
          title="Every move, on the record"
          sub="Runs, steps, claims, spend and decisions land in an append-only log as they happen — so what an agent did is a query, not an archaeology project."
          className="mb-12"
        />
        <CodeTrailCard />
      </Container>
    </section>
  );
}
