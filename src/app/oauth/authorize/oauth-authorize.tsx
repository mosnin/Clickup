"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";

function randomCode() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `opc_${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

async function credentialHash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function OAuthAuthorize({ resource }: { resource: string }) {
  const searchParams = useSearchParams();
  const clientId = searchParams.get("client_id") ?? "";
  const redirectUri = searchParams.get("redirect_uri") ?? "";
  const responseType = searchParams.get("response_type") ?? "";
  const isCompanyOsResource = resource.endsWith("/api/companyos");
  const scope =
    searchParams.get("scope") ??
    (isCompanyOsResource
      ? "companyos:account:read companyos:data:read"
      : "openid email operate:read operate:write");
  const state = searchParams.get("state") ?? "";
  const codeChallenge = searchParams.get("code_challenge") ?? "";
  const codeChallengeMethod =
    searchParams.get("code_challenge_method") ?? "";
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const validShape =
    responseType === "code" &&
    Boolean(clientId && redirectUri && codeChallenge && resource);
  const requestArgs = useMemo(
    () =>
      validShape && isAuthenticated
        ? {
            clientId,
            redirectUri,
            scope,
            resource,
            codeChallenge,
            codeChallengeMethod,
          }
        : "skip" as const,
    [
      clientId,
      codeChallenge,
      codeChallengeMethod,
      redirectUri,
      scope,
      resource,
      validShape,
      isAuthenticated,
    ],
  );
  const request = useQuery(api.oauth.authorizationRequest, requestArgs);
  const approve = useMutation(api.oauth.approveAuthorization);
  const [agentId, setAgentId] = useState<Id<"agents"> | "">("");
  const [workspaceId, setWorkspaceId] = useState<Id<"workspaces"> | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = (approved: boolean) => {
    const target = new URL(redirectUri);
    if (approved) {
      target.searchParams.set("code", randomCode());
    } else {
      target.searchParams.set("error", "access_denied");
      target.searchParams.set(
        "error_description",
        "The user declined the Operate connection",
      );
    }
    if (state) target.searchParams.set("state", state);
    return target;
  };

  const connect = async () => {
    const isCompanyOs = request?.authorizationKind === "companyos";
    if ((isCompanyOs && !workspaceId) || (!isCompanyOs && !agentId)) {
      setError(
        isCompanyOs
          ? "Choose the Operate workspace Company OS may read."
          : "Choose the Operate agent whose permissions this connection should use.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    const target = finish(true);
    const code = target.searchParams.get("code")!;
    try {
      const codeHash = await credentialHash(code);
      await approve({
        clientId,
        redirectUri,
        scope,
        resource,
        codeChallenge,
        codeHash,
        ...(isCompanyOs
          ? { workspaceId: workspaceId as Id<"workspaces"> }
          : { agentId: agentId as Id<"agents"> }),
      });
      window.location.assign(target.toString());
    } catch (cause) {
      setError(errorMessage(cause, "Could not authorize this connection"));
      setBusy(false);
    }
  };

  if (!validShape) {
    return (
      <OAuthShell>
        <h1 className="text-xl font-semibold">Invalid connection request</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The client did not send a complete OAuth authorization-code request.
        </p>
      </OAuthShell>
    );
  }
  if (authLoading || !isAuthenticated || request === undefined) {
    return (
      <OAuthShell>
        <p className="text-sm text-muted-foreground">
          Verifying the connection…
        </p>
      </OAuthShell>
    );
  }
  return (
    <OAuthShell>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-600 dark:text-brand-500">
        Secure connection
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Connect {request.clientName} to Operate
      </h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {request.authorizationKind === "companyos"
          ? "Choose the workspace whose operating context Company OS may sync. This connection is read only and cannot run Operate tools."
          : "Choose an agent identity. The connection inherits that agent's workspace, list restrictions, role, budgets, and approval gates."}
      </p>
      {request.authorizationKind === "companyos" &&
      request.workspaces.length > 0 ? (
        <>
          <label className="mt-6 block text-sm font-medium" htmlFor="oauth-workspace">
            Workspace
          </label>
          <select
            id="oauth-workspace"
            value={workspaceId}
            onChange={(event) =>
              setWorkspaceId(event.target.value as Id<"workspaces"> | "")
            }
            className="mt-2 h-11 w-full rounded-xl bg-background px-3 text-sm outline-none ring-brand-500/20 focus:ring-4"
          >
            <option value="">Choose a workspace…</option>
            {request.workspaces.map((workspace) => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>
                {workspace.name} · {workspace.role}
              </option>
            ))}
          </select>
          <RequestedAccess scopes={request.scopes} />
          {error && (
            <p className="mt-4 rounded-xl bg-pastel-red px-3 py-2 text-sm text-neutral-900">
              {error}
            </p>
          )}
          <ConsentActions
            busy={busy}
            disabled={!workspaceId}
            connect={connect}
            cancel={() => window.location.assign(finish(false).toString())}
          />
        </>
      ) : request.authorizationKind === "mcp" && request.agents.length > 0 ? (
        <>
          <label className="mt-6 block text-sm font-medium" htmlFor="oauth-agent">
            Agent identity
          </label>
          <select
            id="oauth-agent"
            value={agentId}
            onChange={(event) =>
              setAgentId(event.target.value as Id<"agents"> | "")
            }
            className="mt-2 h-11 w-full rounded-xl bg-background px-3 text-sm outline-none ring-brand-500/20 focus:ring-4"
          >
            <option value="">Choose an agent…</option>
            {request.agents.map((agent) => (
              <option key={agent.agentId} value={agent.agentId}>
                {agent.name} · {agent.scopeName}
                {agent.role === "readonly" ? " · read only" : ""}
              </option>
            ))}
          </select>
          <RequestedAccess scopes={request.scopes} />
          {error && (
            <p className="mt-4 rounded-xl bg-pastel-red px-3 py-2 text-sm text-neutral-900">
              {error}
            </p>
          )}
          <ConsentActions
            busy={busy}
            disabled={!agentId}
            connect={connect}
            cancel={() => window.location.assign(finish(false).toString())}
          />
        </>
      ) : (
        <div className="mt-6 rounded-xl bg-pastel-yellow p-4 text-sm text-neutral-900">
          {request.authorizationKind === "companyos"
            ? "You need to be an owner or admin of an active Operate workspace to connect Company OS."
            : "Create an active agent in Operate first, then restart this connection."}
        </div>
      )}
      <p className="mt-5 text-xs leading-5 text-muted-foreground">
        Operate never shares your password or API keys with the client. You can
        {request.authorizationKind === "companyos"
          ? " disconnect the installation or revoke its token to cut off access immediately."
          : " pause the agent to cut off access immediately."}
      </p>
    </OAuthShell>
  );
}

function RequestedAccess({ scopes }: { scopes: string[] }) {
  return (
    <div className="mt-5 rounded-xl bg-muted/40 p-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Requested access
      </p>
      <ul className="mt-2 space-y-1 text-sm">
        {scopes.includes("companyos:account:read") && (
          <li>Read your Operate account and selected workspace identity.</li>
        )}
        {scopes.includes("companyos:data:read") && (
          <li>
            Sync read-only workspace, project, list, task, agent, and run data.
          </li>
        )}
        {scopes.includes("operate:read") && (
          <li>Read space, list, task, roadmap, document, and agent data.</li>
        )}
        {scopes.includes("operate:write") && (
          <li>Create and update work using the chosen agent&apos;s guardrails.</li>
        )}
        {scopes.includes("email") && (
          <li>
            Share your verified primary email so ChatGPT can enforce Enterprise
            workspace-domain restrictions.
          </li>
        )}
      </ul>
    </div>
  );
}

function ConsentActions({
  busy,
  disabled,
  connect,
  cancel,
}: {
  busy: boolean;
  disabled: boolean;
  connect: () => Promise<void>;
  cancel: () => void;
}) {
  return (
    <div className="mt-6 flex gap-3">
      <Button className="flex-1" onClick={connect} disabled={busy || disabled}>
        {busy ? "Connecting…" : "Connect"}
      </Button>
      <Button variant="outline" onClick={cancel} disabled={busy}>
        Cancel
      </Button>
    </div>
  );
}

function OAuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-page p-5">
      <div className="w-full max-w-lg rounded-3xl bg-card p-6 shadow-xl sm:p-8">
        <Link href="/" aria-label="Operate home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/operate-logo-black.svg"
            alt="operate.to"
            className="h-6 w-auto dark:invert"
          />
        </Link>
        <div className="mt-8">{children}</div>
      </div>
    </main>
  );
}
