import type { Metadata } from "next";

export const metadata: Metadata = { title: "About" };

export default function AboutPage() {
  return (
    <section className="px-4 py-16 sm:py-24">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">
          About ClickUp Clone
        </h1>
        <p className="mt-6 text-lg text-muted-foreground">
          We&apos;re building a focused productivity suite for individuals and teams
          — fast, modern, and yours.
        </p>
        <div className="prose prose-zinc mt-10 max-w-none text-foreground">
          <p>
            This project is an open scaffolding for a ClickUp-style app, built
            with Next.js, Convex, Clerk, and Resend. It runs equally well on
            desktop and mobile, and installs as a PWA so you can pin it to your
            dock or home screen.
          </p>
        </div>
      </div>
    </section>
  );
}
