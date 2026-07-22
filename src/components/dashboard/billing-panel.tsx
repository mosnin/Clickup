"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Picker } from "@/components/ui/picker";
import { Card, CardContent, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { AnimatedNumber } from "@/components/motion";

// x402 billing for agents. A prepaid credit wallet per scope (personal space
// or a workspace); agents top it up by paying via x402 and metered actions
// consume credits. Deliberately icon-free per the brief — pure typography on
// the shell's card/table grammar.

type Scope = { type: "user" | "workspace"; id: string; label: string };

function formatAtomic(atomic: string, decimals: number, symbol: string): string {
  let big: bigint;
  try {
    big = BigInt(atomic);
  } catch {
    return `${atomic} ${symbol}`;
  }
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = big / scale;
  const frac = (big % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} ${symbol}`;
}

function truncMiddle(s: string, keep = 6): string {
  if (s.length <= keep * 2 + 1) return s;
  return `${s.slice(0, keep)}…${s.slice(-4)}`;
}

// Discrete-card wrapper for a data table — same grammar as the admin
// console's TableCard: card surface, full-bleed table inside.
function TableCard({ children }: { children: React.ReactNode }) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardContent className="px-0 py-0">{children}</CardContent>
    </Card>
  );
}

export function BillingTab() {
  const tree = useQuery(api.sidebar.tree, {});
  const [scopeKey, setScopeKey] = useState("personal");

  const scopes: Scope[] = useMemo(() => {
    if (!tree) return [];
    return [
      { type: "user", id: tree.currentClerkId, label: "Personal space" },
      ...tree.workspaces.map((w) => ({
        type: "workspace" as const,
        id: w._id as string,
        label: w.name,
      })),
    ];
  }, [tree]);

  const active =
    scopes.find(
      (s) => (s.type === "user" ? "personal" : `ws:${s.id}`) === scopeKey,
    ) ?? scopes[0];

  if (tree === undefined) {
    return (
      <div className="space-y-4">
        <div className="h-9 w-40 animate-pulse rounded-full bg-muted" />
        <Card className="h-40 animate-pulse bg-muted/40" />
        <Card className="h-48 animate-pulse bg-muted/40" />
      </div>
    );
  }
  if (tree === null || !active) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Agent credits
        </h2>
        {scopes.length > 1 && (
          <Picker
            label={active.label}
            selectedId={
              active.type === "user" ? "personal" : `ws:${active.id}`
            }
            options={scopes.map((s) => ({
              id: s.type === "user" ? "personal" : `ws:${s.id}`,
              label: s.label,
            }))}
            onSelect={setScopeKey}
          />
        )}
      </div>
      <ScopeBilling scope={active} />
    </div>
  );
}

function ScopeBilling({ scope }: { scope: Scope }) {
  const wallet = useQuery(api.x402.walletForScope, {
    scopeType: scope.type,
    scopeId: scope.id,
  });

  if (wallet === undefined) {
    return (
      <div className="grid gap-4 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="h-40 animate-pulse bg-muted/40" />
        ))}
      </div>
    );
  }
  if (wallet === null) return null;

  const { pricing, metering } = wallet;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Balance */}
        <Card className="gap-2 p-6">
          <CardDescription className="text-[11px] font-medium uppercase tracking-wider">
            Credit balance
          </CardDescription>
          <p className="mt-2 text-5xl font-bold tracking-tight tabular-nums">
            <AnimatedNumber value={wallet.balance} />
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            {wallet.lifetimeCredits.toLocaleString()} purchased ·{" "}
            {wallet.lifetimeSpent.toLocaleString()} spent
          </p>
          <Badge
            className={cn(
              "mt-4 w-fit border-transparent",
              metering.enabled
                ? "bg-pastel-green text-foreground"
                : "bg-muted text-muted-foreground",
            )}
          >
            {metering.enabled
              ? `Metering on · ${metering.actionCredits} credit${metering.actionCredits === 1 ? "" : "s"}/action`
              : "Metering off · actions are free"}
          </Badge>
        </Card>

        {/* Pricing */}
        <Card className="gap-2 p-6 lg:col-span-2">
          <CardDescription className="text-[11px] font-medium uppercase tracking-wider">
            Pricing
          </CardDescription>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <Row label="Network" value={pricing.network} />
            <Row label="Asset" value={pricing.assetSymbol} />
            <Row
              label="Price per credit"
              value={formatAtomic(
                String(pricing.creditPriceAtomic),
                pricing.assetDecimals,
                pricing.assetSymbol,
              )}
            />
            <Row
              label={`${pricing.exampleBundle.credits.toLocaleString()} credits`}
              value={pricing.exampleBundle.display}
            />
            <Row label="Facilitator" value={pricing.facilitator} />
            <Row label="Pay to" value={truncMiddle(pricing.payTo)} mono />
          </dl>
        </Card>
      </div>

      {/* How agents pay */}
      <Card className="gap-2 p-6">
        <CardDescription className="text-[11px] font-medium uppercase tracking-wider">
          How agents top up
        </CardDescription>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Your agents can pay for their own usage, with no card and no human
          in the loop. When an agent runs low, it buys more credits by itself
          using the open x402 payment standard. The steps below are what the
          agent does; you never have to.
        </p>
        <ol className="mt-4 space-y-2.5">
          {[
            {
              t: "Check the balance",
              d: "The agent calls get_wallet (MCP) or GET /api/x402 to see credits and price.",
            },
            {
              t: "Request a charge",
              d: "buy_credits (or a bare POST /api/x402) returns the x402 402 challenge: amount, asset, network, and pay-to address.",
            },
            {
              t: "Sign and settle",
              d: "The agent signs an X-PAYMENT authorization and submits it to settle_payment (or re-POSTs with the X-PAYMENT header). The facilitator verifies and settles it.",
            },
            {
              t: "Credits land",
              d: "On settlement the wallet is credited, replay-protected, so each payment counts once, and metered work resumes.",
            },
          ].map((step, i) => (
            <li key={step.t} className="flex gap-3">
              <span className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background tabular-nums">
                {i + 1}
              </span>
              <span className="text-sm leading-relaxed">
                <span className="font-medium">{step.t}.</span>{" "}
                <span className="text-muted-foreground">{step.d}</span>
              </span>
            </li>
          ))}
        </ol>
      </Card>

      {/* Ledger */}
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Payments
        </h3>
        {wallet.payments.length === 0 ? (
          <Card className="mt-3 items-center py-8 text-center">
            <CardContent className="text-sm text-muted-foreground">
              No payments yet. When an agent tops up its wallet, each payment
              shows here.
            </CardContent>
          </Card>
        ) : (
          <div className="mt-3">
            <TableCard>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Credits</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden sm:table-cell">
                      Reference
                    </TableHead>
                    <TableHead className="text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {wallet.payments.map((p) => (
                    <TableRow key={p._id}>
                      <TableCell className="font-medium tabular-nums">
                        {p.status === "settled"
                          ? `+${p.creditsGranted.toLocaleString()}`
                          : "-"}
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {p.status === "settled"
                          ? formatAtomic(
                              p.amountAtomic,
                              pricing.assetDecimals,
                              p.asset === pricing.asset
                                ? pricing.assetSymbol
                                : p.asset,
                            )
                          : "-"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={cn(
                            "border-transparent",
                            p.status === "settled"
                              ? "bg-pastel-green text-foreground"
                              : "bg-pastel-red text-foreground",
                          )}
                        >
                          {p.status}
                        </Badge>
                        {p.reason && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {p.reason}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                        {p.txReference ? truncMiddle(p.txReference, 8) : "-"}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {timeAgo(p.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableCard>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 font-medium", mono && "font-mono text-[13px]")}>
        {value}
      </dd>
    </div>
  );
}
