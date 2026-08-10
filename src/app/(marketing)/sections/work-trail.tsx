import { Container, SectionHeading } from "@/components/marketing/ui";
import { CodeTrailCard } from "@/components/marketing/code-trail/CodeTrailCard";

// The trail of work an agent leaves behind it.
//
// PLACEMENT. Last content block before the closing CTA. The page's order is
// claim → evidence → who it is for; this is the coda — not another claim, but
// what all of it leaves behind once the work is done. It is also the only block
// on the page that does nothing until you touch it, which matters here
// specifically: after a long scroll, an element that answers the pointer is a
// reason to still be reading.
//
// It is fragments of source rather than task titles on purpose. Every other
// surface on this page shows the human view of the work; this one shows what is
// underneath it, cut mid-expression, layered, and running off the edge of the
// frame — a window onto something larger, which is the accurate picture of what
// a fleet is doing while you are not looking at it.
//
// And it is OUR source. The piece arrived carrying GLSL and numpy, which is a
// coherent domain and the wrong one under a heading about runs and approvals:
// shader maths here quietly says the picture came from another product. The
// fragments are now claims, runs, budgets and handoffs, in the two languages an
// agent actually touches — the MCP client and the Python it runs.

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
