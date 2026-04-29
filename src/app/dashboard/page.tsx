import Link from "next/link";
import { mockPersonalSpaces, mockTeamWorkspaces } from "@/lib/mock-data";

export default function DashboardHome() {
  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Home
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Jump back into your spaces and team workspaces.
        </p>
      </header>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Personal
        </h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {mockPersonalSpaces.map((space) => (
            <li key={space.id}>
              <Link
                href="/dashboard/personal"
                className="block rounded-3xl border border-border bg-background p-5 transition-colors hover:border-brand-500"
              >
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block h-3 w-3 rounded-full"
                    style={{ backgroundColor: space.color }}
                  />
                  <span className="font-medium">{space.name}</span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  Your private space — only you can see what&apos;s in here.
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Team workspaces
          </h2>
          <Link
            href="/onboarding"
            className="text-sm font-medium text-brand-600 hover:underline"
          >
            New workspace →
          </Link>
        </div>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {mockTeamWorkspaces.map((ws) => (
            <li key={ws.id}>
              <Link
                href={`/dashboard/w/${ws.id}`}
                className="block rounded-3xl border border-border bg-background p-5 transition-colors hover:border-brand-500"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{ws.name}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {ws.role}
                  </span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {ws.spaces.length} space{ws.spaces.length === 1 ? "" : "s"}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
