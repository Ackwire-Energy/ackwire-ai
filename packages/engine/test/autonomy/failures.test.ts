import { afterEach, expect } from "bun:test";
import { ProviderError } from "@agenteschat/providers";
import { closeWorlds, world } from "./harness";
import { assertInvariants } from "./invariants";
import { scenario } from "./known";

// I5 (failures reach someone, and work resumes): no failure ends with only a `run.finished` event.

afterEach(closeWorlds);

scenario("S29", "a provider outage parks the run, which finishes when the provider is back", async () => {
  let down = true;
  const w = await world({
    agents: ["otto"],
    script: {
      otto: () => (down ? { error: new ProviderError("overloaded", true, 529) } : { text: "O build 812 passou." }),
    },
  });
  await w.say("@otto o build passou?");
  await w.settle();
  expect((await w.runs("otto"))[0]?.status).not.toBe("failed");
  down = false;
  await w.advance(60);
  expect((await w.runs("otto")).map((r) => r.status)).toEqual(["done"]);
  expect((await w.posts("otto")).at(-1)?.body).toContain("passou");
  await assertInvariants(w);
});

scenario("S30", "a delegate that fails is reported back to the agent that handed it the work", async () => {
  const w = await world({
    agents: ["ada", "lia"],
    script: {
      ada: [
        { text: "@lia revisa o #227, por favor" },
        { text: "A Lia não conseguiu revisar o #227; revisei eu: aprovado." },
      ],
      lia: () => ({ error: new ProviderError("invalid request", false, 400) }),
    },
  });
  await w.say("@ada pede para a lia revisar o #227");
  await w.settle();
  expect((await w.runs("lia")).map((r) => r.status)).toEqual(["failed"]);
  expect(await w.runs("ada")).toHaveLength(2);
  expect((await w.posts("ada")).at(-1)?.body).toContain("não conseguiu");
  await assertInvariants(w);
});

scenario(
  "S44",
  "a router that fails on a message meant for the agents never leaves it silently unanswered",
  async () => {
    const body = "alguém consegue ver por que o deploy falhou?";
    const w = await world({
      agents: ["otto", "ada"],
      route: { [body]: { needs: 0.9, fail: true } },
      script: { otto: [{ text: "Vi: faltou a variável DATABASE_URL no deploy." }] },
    });
    const events = w.f.listen(w.channelId);
    const message = await w.say(body);
    await w.settle();
    await Bun.sleep(5);
    const [decision] = (await w.decisions()).filter((d) => d.messageId === message.id);
    expect(decision?.error).toContain("router step unavailable");
    // An agent answers it, or the person is told at once that only a mention reaches one now.
    const routed = events.find((e) => e.type === "message.routed" && e.messageId === message.id) as
      | { reason?: string }
      | undefined;
    const answered = (await w.runs()).length > 0;
    expect(answered || routed?.reason === "mention_needed").toBe(true);
    await assertInvariants(w);
  },
);
