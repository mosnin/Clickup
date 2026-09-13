import { Container, CtaButton } from "@/components/marketing/ui";
export const metadata = {
  title: "Request a demo",
  description: "Discuss a bounded workflow for people and agents in Operate.",
  alternates: { canonical: "/demo" },
};
export default function Page() {
  return (
    <section className="pb-28 pt-36">
      <Container>
        <div className="max-w-3xl">
          <h1 className="text-4xl font-semibold">
            Walk through one real handoff.
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            Tell us which runtime your agents use, how work is assigned and who
            reviews the result. We can focus a walkthrough on that workflow and
            discuss the proposed plans.
          </p>
          <h2 className="mt-12 text-2xl">From assignment to review</h2>
          <p className="mt-4 text-muted-foreground">
            We will use the brief to discuss task structure, agent scope, action
            budgets and acceptance evidence. A request does not book a calendar
            slot. Do not send credentials or confidential task data.
          </p>
          <div className="mt-8 flex flex-wrap gap-4">
            <CtaButton href="/company">Request a walkthrough</CtaButton>
            <CtaButton href="/how-it-works" variant="ghostDark">
              Read the workflow
            </CtaButton>
          </div>
        </div>
      </Container>
    </section>
  );
}
