import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { RegisterServiceWorker } from "@/components/register-service-worker";

// Why this test exists, stated plainly: three UI defects were fixed,
// deployed, and confirmed live in production's own stylesheet — while the
// device reporting them kept rendering the old shell, because the service
// worker registered once on first visit and was never asked again. Every fix
// this project ships reaches a returning PWA user through exactly this
// component, so "does it ask for a new build, and does the page take it" is a
// correctness question, not a nicety.
//
// jsdom has no ServiceWorkerContainer, so the container is stubbed. That is
// the right fidelity here: what is being asserted is the *contract this
// component has with the browser* — that it calls update(), that it listens
// for controllerchange, and that it reloads exactly once and never on a first
// install — not the browser's own caching behaviour.

type Listener = () => void;

function stubServiceWorker(opts: { hasController: boolean }) {
  const update = vi.fn().mockResolvedValue(undefined);
  const listeners = new Map<string, Listener[]>();
  const registration = { update } as unknown as ServiceWorkerRegistration;

  const container = {
    controller: opts.hasController ? ({} as ServiceWorker) : null,
    register: vi.fn().mockResolvedValue(registration),
    addEventListener: (type: string, fn: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: (type: string, fn: Listener) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== fn),
      );
    },
  };

  Object.defineProperty(navigator, "serviceWorker", {
    value: container,
    configurable: true,
  });

  return {
    update,
    register: container.register,
    fire: (type: string) => {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function asProduction() {
  // The component is a deliberate no-op outside production. vi.stubEnv is
  // the supported path — NODE_ENV's descriptor is not writable directly.
  vi.stubEnv("NODE_ENV", "production");
}

describe("service worker updates reach the reader", () => {
  it("asks for a new build on mount and again when the tab returns", async () => {
    asProduction();
    const sw = stubServiceWorker({ hasController: true });
    render(<RegisterServiceWorker />);
    await vi.waitFor(() => expect(sw.register).toHaveBeenCalled());
    // Mount is one ask…
    await vi.waitFor(() => expect(sw.update).toHaveBeenCalledTimes(1));

    // …and coming back to the app is the other. A returning reader is
    // exactly who a stale precache strands.
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(sw.update).toHaveBeenCalledTimes(2));
  });

  it("reloads exactly once when a new worker takes over", async () => {
    asProduction();
    const sw = stubServiceWorker({ hasController: true });
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload },
      configurable: true,
    });

    render(<RegisterServiceWorker />);
    await vi.waitFor(() => expect(sw.register).toHaveBeenCalled());

    // A new worker controlling the page does not re-render what is already
    // on screen — without this reload the reader keeps looking at the old
    // HTML and the old CSS.
    sw.fire("controllerchange");
    expect(reload).toHaveBeenCalledTimes(1);
    // Guarded: a second event must not start a reload loop.
    sw.fire("controllerchange");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload a first-time visitor", async () => {
    asProduction();
    // No existing controller = the app is installing, not updating.
    // Reloading here is a flash for nothing.
    const sw = stubServiceWorker({ hasController: false });
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload },
      configurable: true,
    });

    render(<RegisterServiceWorker />);
    await vi.waitFor(() => expect(sw.register).toHaveBeenCalled());
    sw.fire("controllerchange");
    expect(reload).not.toHaveBeenCalled();
  });
});
