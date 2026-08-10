import { Container } from "@/components/marketing/ui";
import { DesignTilesCard } from "@/components/marketing/design-tiles/DesignTilesCard";

// The product, as five words in five colours.
//
// PLACEMENT. Between <Showcase /> and <FeatureCards /> — a caption to the
// screenshots and a lead-in to the grid. It names what you have just been
// looking at and what the next section is about to itemise, which is the one
// job a section this small can do.
//
// Every other block on this page is an argument — a villain, a proof, a grid of
// claims — and five of those back to back flattens all of them. This says the
// whole product in one line and then gets out of the way. It is a breath.
//
// The words are the surfaces (tasks, docs, goals, chat, agents), so the tiles
// are a table of contents for everything the page has just claimed. They keep
// re-rolling their colours on their own timers, which is what stops a static
// list of nouns from reading as a footer that wandered up the page.

export function SurfacesBar() {
  return (
    <section className="bg-background py-16 sm:py-20" aria-labelledby="surfaces-bar">
      <Container>
        <h2 id="surfaces-bar" className="sr-only">
          What operate.to gives every team
        </h2>
        {/* The shared charcoal plate, so the bar sits on a surface rather than
            in a hole cut in the canvas — the tiles are saturated blocks butted
            edge to edge, and against pure black their outer edges have nothing
            to end against.

            `data-canvas-card` goes on the PLATE, not only on the bar inside it:
            the plate token vocabulary is scoped to that attribute, and a
            wrapper without it resolves `--border-line` to nothing — which is
            not a fallback but an invalid declaration, so the rule silently does
            not apply. */}
        <div
          data-canvas-card
          className="canvas-plate mx-auto max-w-3xl rounded-[12px] border border-[var(--border-line)] px-6 py-10 sm:px-10"
        >
          <DesignTilesCard />
        </div>
        <p className="mx-auto mt-8 max-w-xl text-center text-sm text-muted-foreground">
          One workspace, five surfaces — and an agent can reach every one of
          them through the same API your team uses.
        </p>
      </Container>
    </section>
  );
}
