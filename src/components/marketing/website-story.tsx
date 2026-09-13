import {
  Container,
  CtaButton,
  SectionHeading,
} from "@/components/marketing/ui";
import { GsapReveal } from "@/components/marketing/gsap";
import stories from "@/lib/website/stories.json";
export function WebsiteStory({ slug }: { slug: keyof typeof stories }) {
  const s = stories[slug];
  return (
    <>
      <section className="mk-band pb-20 pt-36">
        <Container>
          <div className="max-w-3xl">
            <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              {s.title}
            </h1>
            <p className="mt-6 text-lg leading-relaxed text-white/75">
              {s.sub}
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <CtaButton href="/sign-up">Get started</CtaButton>
              <CtaButton href="/demo" variant="ghostDark">
                Request a demo
              </CtaButton>
            </div>
          </div>
        </Container>
      </section>
      <section className="py-20">
        <Container>
          <SectionHeading title="The problem to solve" sub={s.problem} />
          <GsapReveal className="mt-14">
            <ol className="grid gap-6 md:grid-cols-3">
              {s.steps.map((x, i) => (
                <li key={x.title} className="mk-panel-2 rounded-2xl p-7">
                  <span className="font-mono text-azure-300">0{i + 1}</span>
                  <h2 className="mt-5 text-2xl text-foreground">{x.title}</h2>
                  <p className="mt-4 leading-relaxed text-muted-foreground">
                    {x.body}
                  </p>
                </li>
              ))}
            </ol>
          </GsapReveal>
        </Container>
      </section>
      <section className="pb-24">
        <Container>
          <div className="grid gap-10 md:grid-cols-2">
            {s.benefits.map((x) => (
              <div key={x.title}>
                <h2 className="text-2xl text-foreground">{x.title}</h2>
                <p className="mt-4 leading-relaxed text-muted-foreground">
                  {x.body}
                </p>
              </div>
            ))}
          </div>
          <aside className="mt-14 border-t border-white/15 pt-8">
            <h2 className="text-xl text-foreground">Before you begin</h2>
            <p className="mt-3 max-w-3xl leading-relaxed text-muted-foreground">
              {s.limits}
            </p>
          </aside>
        </Container>
      </section>
      <section className="mk-band py-20">
        <Container>
          <h2 className="text-3xl text-white">
            Start with one task you can review.
          </h2>
          <div className="mt-8 flex flex-wrap gap-4">
            <CtaButton href="/sign-up">Get started</CtaButton>
            <CtaButton href="/demo" variant="ghostDark">
              Request a demo
            </CtaButton>
          </div>
        </Container>
      </section>
    </>
  );
}
