"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Picker } from "@/components/ui/picker";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { AnimatedNumber } from "@/components/motion";

// x402 billing for agents. A prepaid credit wallet per scope (personal space
// or a workspace); agents top it up by paying via x402 and metered actions
// consume credits. Deliberately icon-free per the brief — pure typography on
// the bento surface.

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
        <div className="h-40 animate-pulse rounded-2xl bg-muted/40" />
        <div className="h-48 animate-pulse rounded-2xl bg-muted/40" />
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
          <div
            key={i}
            className="h-40 animate-pulse rounded-2xl bg-muted/40"
          />
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
        <div className="rounded-2xl bento p-6">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Credit balance
          </p>
          <p className="mt-2 text-5xl font-bold tracking-tight tabular-nums">
            <AnimatedNumber value={wallet.balance} />
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            {wallet.lifetimeCredits.toLocaleString()} purchased ·{" "}
            {wallet.lifetimeSpent.toLocaleString()} spent
          </p>
          <span
            className={cn(
              "mt-4 inline-block rounded-full px-2.5 py-1 text-[11px] font-medium",
              metering.enabled
                ? "bg-pastel-green text-foreground"
                : "bg-muted text-muted-foreground",
            )}
          >
            {metering.enabled
              ? `Metering on · ${metering.actionCredits} credit${metering.actionCredits === 1 ? "" : "s"}/action`
              : "Metering off · actions are free"}
          </span>
        </div>

        {/* Pricing */}
        <div className="rounded-2xl bento p-6 lg:col-span-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Pricing
          </p>
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
        </div>
      </div>

      {/* How agents pay */}
      <div className="rounded-2xl bento p-6">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          How agents top up
        </p>
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
      </div>

      {/* Ledger */}
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Payments
        </h3>
        {wallet.payments.length === 0 ? (
          <div className="mt-3 rounded-2xl bento p-8 text-center text-sm text-muted-foreground">
            No payments yet. When an agent tops up its wallet, each payment
            shows here.
          </div>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-2xl bento">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2.5">Credits</th>
                  <th scope="col" className="px-4 py-2.5">Amount</th>
                  <th scope="col" className="px-4 py-2.5">Status</th>
                  <th scope="col" className="hidden px-4 py-2.5 sm:table-cell">
                    Reference
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right">When</th>
                </tr>
              </thead>
              <tbody>
                {wallet.payments.map((p) => (
                  <tr
                    key={p._id}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-4 py-2.5 font-medium tabular-nums">
                      {p.status === "settled"
                        ? `+${p.creditsGranted.toLocaleString()}`
                        : "-"}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {p.status === "settled"
                        ? formatAtomic(
                            p.amountAtomic,
                            pricing.assetDecimals,
                            p.asset === pricing.asset
                              ? pricing.assetSymbol
                              : p.asset,
                          )
                        : "-"}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11px] font-medium",
                          p.status === "settled"
                            ? "bg-pastel-green text-foreground"
                            : "bg-pastel-red text-foreground",
                        )}
                      >
                        {p.status}
                      </span>
                      {p.reason && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {p.reason}
                        </span>
                      )}
                    </td>
                    <td className="hidden px-4 py-2.5 font-mono text-xs text-muted-foreground sm:table-cell">
                      {p.txReference ? truncMiddle(p.txReference, 8) : "-"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                      {timeAgo(p.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
