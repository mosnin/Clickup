import { describe, expect, it } from "vitest";
import {
  DEVICE_GRANT,
  deviceErrorCode,
  type DeviceClaimState,
} from "../src/lib/oauth-server";
import type { DeviceRequestState } from "../convex/agentAuth";

// The two ends of the wire declare this union separately — Convex cannot
// import from src/ and the Next tree should not depend on a Convex module
// for a string set. These two assignments fail to compile if either side
// grows or loses a state, which is the only moment the drift is cheap to
// fix: a new state reaching a route that has no branch for it would fall
// through to minting a key.
const _convexToRoute: DeviceClaimState = null as unknown as DeviceRequestState;
const _routeToConvex: DeviceRequestState = null as unknown as DeviceClaimState;
void _convexToRoute;
void _routeToConvex;

// The device grant's wire contract.
//
// Every agent runtime that already speaks RFC 8628 branches on these exact
// strings — that is the whole reason to implement the standard rather than
// invent a polling endpoint. A wrong code turns a working connection into a
// runtime that either gives up or spins forever, and neither failure points
// at this mapping, so it is worth pinning explicitly.

describe("the device grant identifier", () => {
  it("is the URN, verbatim", () => {
    expect(DEVICE_GRANT).toBe("urn:ietf:params:oauth:grant-type:device_code");
  });
});

describe("state → RFC 8628 error code", () => {
  it("maps every state to the code the RFC defines", () => {
    const expected: Record<DeviceClaimState, string | null> = {
      approved: null,
      pending: "authorization_pending",
      denied: "access_denied",
      expired: "expired_token",
      claimed: "invalid_grant",
      not_found: "invalid_grant",
    };
    for (const [state, code] of Object.entries(expected)) {
      expect(deviceErrorCode(state as DeviceClaimState)).toBe(code);
    }
  });

  it("returns slow_down only for a too-eager poller", () => {
    expect(deviceErrorCode("pending", true)).toBe("slow_down");
    expect(deviceErrorCode("pending", false)).toBe("authorization_pending");
    // slowDown is meaningless on a terminal state and must not leak into it:
    // a client told to slow down on a denied request would keep polling.
    expect(deviceErrorCode("denied", true)).toBe("access_denied");
    expect(deviceErrorCode("expired", true)).toBe("expired_token");
    expect(deviceErrorCode("approved", true)).toBeNull();
  });

  it("answers a replayed code and an unknown one identically", () => {
    // Distinguishing them would let somebody probe for live device codes.
    expect(deviceErrorCode("claimed")).toBe(deviceErrorCode("not_found"));
  });

  it("signals success only for approved", () => {
    const states: DeviceClaimState[] = [
      "pending",
      "denied",
      "expired",
      "claimed",
      "not_found",
    ];
    // A key is issued on exactly one state. Anything else returning null
    // would mean the route falls through to minting one.
    for (const state of states) expect(deviceErrorCode(state)).not.toBeNull();
    expect(deviceErrorCode("approved")).toBeNull();
  });
});
