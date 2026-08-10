import { Container, SectionHeading } from "@/components/marketing/ui";
import { AiLightsCard } from "@/components/marketing/ai-lights/AiLightsCard";

// One agent surface becoming the next, lit once per handover.
//
// PLACEMENT. Directly after <SocialProof />, before <Showcase />. That band
// makes the page's central claim — agents on the same board as your team — and
// the next thing after a claim like that should be the thing itself, not a
// screenshot of it. It is also the quietest moment on the page: one small
// object on black between a loud band and a slab of product shots, which is
// what stops the middle of the page reading as one long grid.
//
// It was briefly in the hero and that was wrong twice over. The hero already
// closes on the curl command and the dashboard shot, so a third object made it
// a queue rather than an opening; and the card carried a pale demo plate,
// which on a black page is a third surface fighting the two that were already
// there. `bare` drops the plate — the body and its light sit straight on the
// canvas.
//
// The four states are operate's own: claim a task, work it, hand it back for
// approval; a sprint being cleared; the CLI claiming the next task; somebody
// typing an instruction. A generic "Indexing 45%" said nothing about us.

export function AgentAtWork() {
  return (
    <section className="bg-background py-24 sm:py-28">
      <Container>
        <SectionHeading
          eyebrow="In flight"
          title="You can watch it work"
          sub="Claim, build, hand back. An agent moves through the same states your team does, and the surface tells you which one it is in without you opening anything."
          className="mb-14"
        />
        <AiLightsCard bare />
      </Container>
    </section>
  );
}
