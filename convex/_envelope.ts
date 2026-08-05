// Attenuation: what a provisioned agent is allowed to be.
//
// The problem this solves is the plural. One human approving one agent is a
// reasonable amount of consent; one human approving twenty is a person
// clicking Approve twenty times, which is not consent, it is fatigue. So a
// grant authorizes a *fleet* — but a fleet that could provision members with
// powers its own grant does not have is just privilege escalation with a
// friendlier name.
//
// Hence one rule, applied without exception:
//
//   A provisioned agent's governance is the INTERSECTION of what was
//   requested and what the grant permits. Never the union, never the
//   request, never the grant.
//
// Attenuation is monotonic — provisioning can only narrow — which is what
// makes a chain of it safe: whatever an orchestrator does, and whatever an
// agent it provisioned goes on to do, nothing downstream can hold a power
// the human at the top did not hand over.
//
// Pure and dependency-free on purpose: this is the security boundary of the
// whole fleet feature, so it is testable in isolation and has no way to
// reach a database, a clock, or a caller's identity.

export type AgentRole = "member" | "readonly";

/** What a human authorized. The ceiling for everything provisioned under it. */
export type Envelope = {
  /** Strongest role any member may hold. */
  role: AgentRole;
  /**
   * Lists the fleet is fenced to. `undefined` means "not fenced" — the whole
   * scope. An empty array is NOT the same thing and means a fleet fenced to
   * nothing, which is a legitimate (if useless) thing to have authorized.
   */
  allowedListIds?: string[];
  /** Ceiling on each member's per-day mutation budget. */
  dailyActionLimit: number;
  /** How many agents may exist under this grant at once. */
  maxAgents: number;
};

/** What an orchestrator asked for on behalf of a new agent. */
export type Request = {
  role?: AgentRole;
  allowedListIds?: string[];
  dailyActionLimit?: number;
};

export type Attenuated = {
  role: AgentRole;
  allowedListIds?: string[];
  dailyActionLimit: number;
};

// "member" outranks "readonly" — a readonly grant can never produce a
// writing agent, whatever it asks for.
function weakestRole(a: AgentRole, b: AgentRole): AgentRole {
  return a === "readonly" || b === "readonly" ? "readonly" : "member";
}

/**
 * Intersect a request with its envelope.
 *
 * Total: every input produces a valid result, because the fallback at every
 * step is the envelope's own value. There is deliberately no way to express
 * "refuse" here — a request for more than the grant allows is quietly
 * narrowed rather than rejected, since an orchestrator asking for too much
 * is far more often a default it did not think about than an attack, and
 * failing the provision would strand a fleet over a field nobody set.
 */
export function attenuate(envelope: Envelope, request: Request): Attenuated {
  // Absent means "whatever the grant says", not "the strongest available".
  const role = weakestRole(envelope.role, request.role ?? envelope.role);

  // Fencing composes by intersection, and an unfenced side contributes no
  // constraint. Both fenced → only lists in both. Order does not matter.
  let allowedListIds: string[] | undefined;
  if (envelope.allowedListIds && request.allowedListIds) {
    const permitted = new Set(envelope.allowedListIds);
    allowedListIds = request.allowedListIds.filter((id) => permitted.has(id));
  } else {
    allowedListIds = envelope.allowedListIds ?? request.allowedListIds;
  }

  // A request may lower its own budget but never raise it.
  //
  // Two distinct cases, and conflating them is a real hole: a value this
  // function cannot read (absent, NaN, Infinity) falls back to the
  // envelope, but a NEGATIVE number is a value it can read perfectly well
  // and it means "narrower than zero", so it clamps to zero. Treating -5 as
  // unreadable handed the caller the FULL envelope budget instead of the
  // narrowest — a narrowing function that widens on hostile input.
  const asked = request.dailyActionLimit;
  const usable =
    typeof asked === "number" && Number.isFinite(asked)
      ? Math.max(0, asked)
      : envelope.dailyActionLimit;
  const dailyActionLimit = Math.min(envelope.dailyActionLimit, usable);

  return { role, allowedListIds, dailyActionLimit };
}

/**
 * Whether an envelope is at least as restrictive as another.
 *
 * Used to check that a grant being created sits inside the authority of
 * whoever is creating it — the same rule one level up, so an orchestrator
 * cannot mint a sub-fleet wider than its own.
 */
export function withinEnvelope(outer: Envelope, inner: Envelope): boolean {
  if (outer.role === "readonly" && inner.role === "member") return false;
  if (inner.dailyActionLimit > outer.dailyActionLimit) return false;
  if (inner.maxAgents > outer.maxAgents) return false;
  if (outer.allowedListIds) {
    // An unfenced inner envelope inside a fenced outer one is wider by
    // definition, so it fails before the subset check gets a chance to.
    if (!inner.allowedListIds) return false;
    const permitted = new Set(outer.allowedListIds);
    if (!inner.allowedListIds.every((id) => permitted.has(id))) return false;
  }
  return true;
}

// Ceilings on the ceiling. A human choosing "let it run a fleet" is not
// choosing a number of agents; these bound what that phrase can ever mean,
// so a compromised orchestrator's blast radius stays finite even if the
// consent screen is later changed to offer something larger.
export const MAX_FLEET_SIZE = 50;
export const DEFAULT_FLEET_SIZE = 10;

export function clampFleetSize(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_FLEET_SIZE;
  }
  return Math.max(1, Math.min(MAX_FLEET_SIZE, Math.floor(value)));
}
