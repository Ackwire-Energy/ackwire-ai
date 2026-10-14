import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  createLocalKeyWrapper,
  deriveSecret,
  openSecret,
  sealSecret,
  sha256,
} from "../src";
import { SECRET } from "./fixtures";

test("AES-GCM round-trips and authenticates the associated data", () => {
  const key = randomBytes(32);
  const sealed = aesGcmEncrypt(key, Buffer.from("hello"), "org-a");
  expect(sealed.startsWith("v1.")).toBe(true);
  expect(aesGcmDecrypt(key, sealed, "org-a").toString()).toBe("hello");
  expect(() => aesGcmDecrypt(key, sealed, "org-b")).toThrow();
  const [v, iv, ct, tag] = sealed.split(".");
  const tampered = [v, iv, `${ct?.slice(0, -2)}AA`, tag].join(".");
  expect(() => aesGcmDecrypt(key, tampered, "org-a")).toThrow();
});

test("envelope encryption: random data key per secret, wrapped by the KEK", async () => {
  const wrapper = createLocalKeyWrapper(SECRET);
  const a = await sealSecret(wrapper, "sk-ant-secret", "aad");
  const b = await sealSecret(wrapper, "sk-ant-secret", "aad");
  expect(a.kekId).toBe("local:v1");
  expect(a.ciphertext).not.toBe(b.ciphertext);
  expect(a.wrappedDataKey).not.toBe(b.wrappedDataKey);
  expect(a.ciphertext).not.toContain("sk-ant");
  expect(await openSecret([wrapper], a, "aad")).toBe("sk-ant-secret");
});

test("opening fails with another master secret, another owner, or an unknown KEK", async () => {
  const wrapper = createLocalKeyWrapper(SECRET);
  const sealed = await sealSecret(wrapper, "sk", "org-a|cred-1");
  await expect(
    openSecret([createLocalKeyWrapper("another-secret".padEnd(48, "y"))], sealed, "org-a|cred-1"),
  ).rejects.toThrow();
  await expect(openSecret([wrapper], sealed, "org-b|cred-1")).rejects.toThrow();
  await expect(openSecret([wrapper], { ...sealed, kekId: "kms:v9" }, "org-a|cred-1")).rejects.toThrow(/no key wrapper/);
});

test("KEK rotation: old secrets open with a legacy wrapper", async () => {
  const old = { ...createLocalKeyWrapper("old-secret".padEnd(48, "z")), id: "local:v0" };
  const sealed = await sealSecret(old, "sk-old", "aad");
  expect(await openSecret([createLocalKeyWrapper(SECRET), old], sealed, "aad")).toBe("sk-old");
});

test("derived secrets differ per purpose and are stable", () => {
  expect(deriveSecret(SECRET, "sessions")).toBe(deriveSecret(SECRET, "sessions"));
  expect(deriveSecret(SECRET, "sessions")).not.toBe(deriveSecret(SECRET, "provider-credentials-kek"));
  expect(sha256("x")).toHaveLength(64);
});
