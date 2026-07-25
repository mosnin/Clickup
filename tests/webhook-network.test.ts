import { describe, expect, it } from "vitest";
import {
  assertSafeWebhookDestination,
  isUnsafeWebhookAddress,
} from "../convex/_webhookNetwork";

describe("webhook network boundary", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
  ])("rejects private or reserved address %s", (address) => {
    expect(isUnsafeWebhookAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => {
      expect(isUnsafeWebhookAddress(address)).toBe(false);
    },
  );

  it("rejects a public hostname that resolves privately", async () => {
    await expect(
      assertSafeWebhookDestination(
        "https://hooks.example.com/operate",
        async () => [{ address: "127.0.0.1", family: 4 }],
      ),
    ).rejects.toThrow(/unsafe webhook destination/i);
  });

  it("accepts a public hostname only when every answer is public", async () => {
    await expect(
      assertSafeWebhookDestination(
        "https://hooks.example.com/operate",
        async () => [
          { address: "1.1.1.1", family: 4 },
          { address: "2606:4700:4700::1111", family: 6 },
        ],
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects credentials and non-HTTPS destinations", async () => {
    const resolvePublic = async () => [{ address: "1.1.1.1", family: 4 }];
    await expect(
      assertSafeWebhookDestination(
        "https://user:secret@hooks.example.com/operate",
        resolvePublic,
      ),
    ).rejects.toThrow(/unsafe webhook destination/i);
    await expect(
      assertSafeWebhookDestination(
        "http://hooks.example.com/operate",
        resolvePublic,
      ),
    ).rejects.toThrow(/unsafe webhook destination/i);
  });
});
