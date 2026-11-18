import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { MODEL_CATALOG } from "@agenteschat/providers";
import { updateAgent } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * The model picker in place: an agent's owner changes its API model, among the keys the workspace connected, as they
 * choose its plan's. Everything else on the agent (its name, its budget) stays admins'.
 */

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

test("its owner changes its API model, not its name or budget; another member changes nothing", async () => {
  f = await setup();
  const fx = f;
  const lia = await addMember(fx.db, fx.org.id, "member", "lia");
  const bob = await addMember(fx.db, fx.org.id, "member", "bob");
  await fx.db.update(schema.agents).set({ ownerUserId: lia.id }).where(eq(schema.agents.id, fx.agent.id));
  const saved = await updateAgent(fx.db, lia.id, fx.org.id, fx.agent.id, { model: "auto" });
  expect(saved.model).toBe("auto");
  await expect(updateAgent(fx.db, lia.id, fx.org.id, fx.agent.id, { name: "Outro" })).rejects.toThrow();
  await expect(
    updateAgent(fx.db, lia.id, fx.org.id, fx.agent.id, { model: "auto", monthlyBudgetNanoUsd: 1 }),
  ).rejects.toThrow();
  await expect(updateAgent(fx.db, bob.id, fx.org.id, fx.agent.id, { model: "auto" })).rejects.toThrow();
  // Admins as before.
  expect((await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { name: "Nova" })).name).toBe("Nova");
});

test("a model of another provider than its key's leaves that key for the workspace's default one", async () => {
  f = await setup();
  const fx = f;
  const openai = Object.entries(MODEL_CATALOG).find(([, m]) => m.provider === "openai")?.[0];
  if (!openai) throw new Error("no OpenAI model in the catalog");
  const same = await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { model: "claude-sonnet-5-5" });
  expect(same.credentialId).toBe(fx.credential.id);
  const moved = await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { model: openai });
  expect([moved.model, moved.credentialId]).toEqual([openai, null]);
});
