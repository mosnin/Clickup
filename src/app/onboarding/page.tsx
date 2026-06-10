import type { Metadata } from "next";
import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { OnboardingForm } from "./onboarding-form";

export const metadata: Metadata = { title: "Welcome" };

export default async function OnboardingPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await currentUser();
  const firstName = user?.firstName ?? "there";

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-4 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Hey {firstName}. Find your pace.
        </h1>
        <p className="mt-2 text-muted-foreground">
          Three small choices and you&apos;re working. Each one is skippable.
        </p>
      </header>
      <OnboardingForm />
    </div>
  );
}
