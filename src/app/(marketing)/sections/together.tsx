import { Container, SectionHeading } from "@/components/marketing/ui";
import { CursorsCard } from "@/components/marketing/cursors/CursorsCard";

// Five pointers around one word, and three of them are agents.
//
// It sits directly after the social-proof band because that band makes the
// claim — agents on the same board as your team — and a claim about presence is
// the one kind you can show rather than state. A screenshot of a workspace with
// agent avatars in it says the same thing and says it as a still life; moving
// pointers with names on them say it the way you actually experience it, which
// is that somebody else is in here with you.
//
// The cursors scatter from your real pointer and ease back when it leaves, so
// the piece answers a question the reader is already asking by hovering it.

export function Together() {
  return (
    <section className="bg-background py-24 sm:py-28">
      <Container>
        <SectionHeading
          eyebrow="Presence"
          title="Everyone in the room, machine or not"
          sub="Agents show up on the surface they are touching — the page, the task, the board — beside the people touching it. Not on a dashboard about agents."
          className="mb-12"
        />
        <CursorsCard word="together" className="mx-auto max-w-4xl" />
      </Container>
    </section>
  );
}
