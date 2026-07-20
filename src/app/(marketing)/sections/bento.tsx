import { Container, Placeholder } from "@/components/marketing/ui";
import { GsapReveal } from "@/components/marketing/gsap";
import { BENTO } from "@/lib/marketing-content";

// Phase G — bento tile grid: 2x3 (2-up on tablet, 3-up on desktop) of
// small illustrated feature tiles.

export function Bento() {
  return (
    <section className="bg-background py-16">
      <Container>
        <h2 className="sr-only">More of the system, at a glance.</h2>
        <GsapReveal stagger className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {BENTO.tiles.map((tile) => (
            <div
              key={tile.title}
              className="rounded-[20px] bg-muted p-2 transition-transform duration-300 hover:-translate-y-0.5 hover:shadow-lg"
            >
              <Placeholder
                label={tile.visual}
                ratio="16/10"
                className="overflow-hidden rounded-[14px]"
              />
              <div className="px-5 pb-5 pt-4">
                <h3 className="text-[15px] font-semibold tracking-tight text-foreground">
                  {tile.title}
                </h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                  {tile.body}
                </p>
              </div>
            </div>
          ))}
        </GsapReveal>
      </Container>
    </section>
  );
}
