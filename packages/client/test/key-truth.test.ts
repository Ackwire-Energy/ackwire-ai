import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import { ApiError } from "../src/api/http";
import type { Credential } from "../src/api/types";
import { keyRemovalText } from "../src/lib/ai-accounts";
import { keyRefusal } from "../src/lib/errors";
import { rightHandFallback, rightHandOnKey, savedKeyLine, settleSavedKey, thinksWithLine } from "../src/lib/right-hand";

const i18n = i18next.createInstance();
void i18n.init({ lng: "en", resources, initAsync: false });
const t: TFunction = i18n.t.bind(i18n);

const refused = (code: string, params: Record<string, unknown>) => new ApiError(422, code, "refused", params);

test("a key with no credit says why, in the provider's words, and where to add it", () => {
  const out = keyRefusal(
    t,
    refused("provider_key_no_credit", { provider: "OpenAI", said: "You exceeded your quota." }),
  );
  expect(out?.text).toContain("OpenAI says this key has no credit");
  expect(out?.text).toContain("OpenAI said: You exceeded your quota.");
  expect(out?.href).toBe("https://platform.openai.com/settings/organization/billing/overview");
  expect(out?.site).toBe("platform.openai.com");
});

test("a refused key points at the provider's keys page, and any other failure isn't a refusal", () => {
  expect(keyRefusal(t, refused("provider_key_invalid", { provider: "Claude", said: "" }))?.href).toBe(
    "https://platform.claude.com/settings/keys",
  );
  expect(keyRefusal(t, refused("org.paused", {}))).toBeNull();
  expect(keyRefusal(t, new Error("x"))).toBeNull();
});

test("removing a key says what happens to the agents on it, before it happens", () => {
  const key = { id: "k1", usedBy: [{ id: "a", name: "Lodi" }] };
  expect(keyRemovalText(t, { id: "k1", usedBy: [] }, [{ id: "k1" }], false)).toContain("No agent thinks with it");
  expect(keyRemovalText(t, key, [{ id: "k1" }], false)).toContain("Lodi thinks with this key and has nothing else");
  expect(keyRemovalText(t, key, [{ id: "k1" }, { id: "k2" }], false)).toContain("moves to another key");
  expect(keyRemovalText(t, key, [{ id: "k1" }], true)).toContain("moves to another key");
  const two = { id: "k1", usedBy: [...key.usedBy, { id: "b", name: "Rio" }] };
  expect(keyRemovalText(t, two, [{ id: "k1" }], false)).toContain("think with this key and have nothing else");
});

test("the right hand's words say which of its AIs moved", () => {
  expect(thinksWithLine(t, "workspace", "Lodi", "OpenAI")).toBe(
    "Lodi now thinks with OpenAI for everyone without a plan of their own.",
  );
  expect(thinksWithLine(t, "mine", "Lodi", "ChatGPT")).toBe(
    "Your conversation with Lodi now thinks with ChatGPT. Only yours does.",
  );
  expect(thinksWithLine(t, undefined, "Rio", "OpenAI")).toBe("Rio now thinks with OpenAI.");
});

test("what a person without a plan reads names the key, or that there is none", () => {
  const ai = { brain: "model", ownerId: null, servesYou: true } as const;
  const say = (over: object, platform = false) =>
    rightHandFallback(t, { ...ai, ...over }, "me", { name: "Lodi" }, () => undefined, platform);
  expect(say({ key: { provider: "openai", label: "OpenAI" } })).toContain("the workspace's key: OpenAI");
  expect(say({ key: null })).toContain("no API key yet");
  expect(say({ key: null }, true)).toContain("the workspace's API key");
});

test("a key for the right hand: the workspace's moves first, so a refusal leaves the person's own; a model it can't run becomes Automatic", async () => {
  const calls: unknown[] = [];
  const api = {
    agents: {
      setBrain: async (_o: string, _a: string, input: unknown) => void calls.push(input),
      update: async (_o: string, _a: string, patch: unknown) => void calls.push(patch),
    },
  } as never;
  await rightHandOnKey(api, "o", { id: "lodi", model: "claude-opus" }, { id: "k1", provider: "openai" }, []);
  expect(calls).toEqual([
    { scope: "workspace", brain: "model" },
    { credentialId: "k1", model: "auto" },
    { brain: "model" },
  ]);
});

const key = (id: string, over: Partial<Credential> = {}): Credential => ({
  id,
  provider: "openai",
  label: "OpenAI",
  keyHint: "0000",
  createdAt: "2026-11-01T00:00:00.000Z",
  revokedAt: null,
  ...over,
});
const endpoint = (id: string, label: string, check?: "ok" | "no_tools" | "failed"): Credential =>
  key(id, {
    provider: "custom",
    label,
    endpoint: {
      style: "openai",
      baseURL: "https://api.example.com/v1",
      models: [{ id: "m1", ...(check ? { check } : {}) }],
    },
  });

/** A connect flow's API: the workspace's keys and default, and every call it makes. */
function keyApi(keys: Credential[], defaultId: string | null) {
  const calls: [string, ...unknown[]][] = [];
  const api = {
    agents: {
      credentials: async () => keys,
      makeDefaultCredential: async (_o: string, id: string) => void calls.push(["makeDefault", id]),
      setBrain: async (_o: string, a: string, input: unknown) => void calls.push(["setBrain", a, input]),
      update: async (_o: string, a: string, patch: unknown) => void calls.push(["update", a, patch]),
    },
    orgs: { settings: async () => ({ defaultCredentialId: defaultId }) },
  } as never;
  return { api, calls };
}

test("a key saved for one agent goes on it, and the line names the agent", async () => {
  const saved = endpoint("k2", "Gateway Sul", "ok");
  const { api, calls } = keyApi([saved], null);
  const out = await settleSavedKey(
    api,
    "o",
    saved,
    { id: "ada", name: "Ada", model: "auto", brain: "claude_code" },
    [],
  );
  expect(calls).toEqual([
    ["setBrain", "ada", { brain: "model" }],
    ["update", "ada", { credentialId: "k2", model: "custom:k2:m1" }],
  ]);
  expect(savedKeyLine(t, out, saved)).toBe("Saved. Ada now thinks with Gateway Sul.");
});

test("a key saved for everyone says who really thinks with it: it, the default it replaced, or the default still", async () => {
  const fresh = endpoint("k2", "Gateway Sul", "ok");
  // No default yet: the newest key is what agents without their own use.
  let run = keyApi([fresh], null);
  let out = await settleSavedKey(run.api, "o", fresh, undefined, []);
  expect(run.calls).toEqual([]);
  expect(savedKeyLine(t, out, fresh)).toBe("Saved. Agents without their own AI think with it.");
  // The default thinks: it stays, and the line names it (a button may switch).
  const northwind = endpoint("k1", "Northwind", "ok");
  run = keyApi([northwind, fresh], "k1");
  out = await settleSavedKey(run.api, "o", fresh, undefined, []);
  expect(run.calls).toEqual([]);
  expect(out).toEqual({ kind: "other", other: "Northwind" });
  expect(savedKeyLine(t, out, fresh)).toBe("Saved. Your agents still think with Northwind.");
  // The default can't think and this one can: it becomes the default by itself, and says so.
  const broken = endpoint("k1", "Northwind", "failed");
  run = keyApi([broken, fresh], "k1");
  out = await settleSavedKey(run.api, "o", fresh, undefined, []);
  expect(run.calls).toEqual([["makeDefault", "k2"]]);
  expect(out).toEqual({ kind: "made", other: "Northwind" });
  expect(savedKeyLine(t, out, fresh)).toBe("Saved. Your agents now think with it instead of Northwind.");
  // Neither thinks: nothing moves, and the line says none of its models passed.
  const untested = endpoint("k2", "Gateway Sul");
  run = keyApi([broken, untested], "k1");
  out = await settleSavedKey(run.api, "o", untested, undefined, []);
  expect(run.calls).toEqual([]);
  expect(savedKeyLine(t, out, untested)).toBe("None of Gateway Sul's models has passed a test yet.");
});
