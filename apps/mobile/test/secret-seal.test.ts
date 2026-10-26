import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { accountCodeAad } from "@agenteschat/client/lib/secret-box";
import { generateSecretKeyPair, openSecret } from "../../../packages/adapters/src/secret-box";
import { sealSecretWith } from "../src/lib/secret-seal";

const random = (n: number) => new Uint8Array(randomBytes(n));

describe("a secret sealed on the phone (pure JS) opens on the computer (WebCrypto)", () => {
  test("a sign-in code and a plan's key come out as sent", async () => {
    const pair = await generateSecretKeyPair();
    const aad = accountCodeAad("login-1", "org-1");
    for (const text of ["abc123#state-xyz", "sk-sp-0123456789abcdef", "ção ✓"]) {
      const box = sealSecretWith(random, pair.publicKey, text, aad);
      expect(box.v).toBe(1);
      expect(await openSecret(pair.privateKey, box, aad)).toBe(text);
    }
  });

  test("bound to its request: another sign-in's AAD doesn't open it", async () => {
    const pair = await generateSecretKeyPair();
    const box = sealSecretWith(random, pair.publicKey, "code", accountCodeAad("login-1", "org-1"));
    await expect(openSecret(pair.privateKey, box, accountCodeAad("login-2", "org-1"))).rejects.toThrow();
  });

  test("empty or too large is refused before sealing", async () => {
    const pair = await generateSecretKeyPair();
    expect(() => sealSecretWith(random, pair.publicKey, "", "x")).toThrow("empty");
    expect(() => sealSecretWith(random, pair.publicKey, "a".repeat(16 * 1024 + 1), "x")).toThrow("too_large");
  });
});
