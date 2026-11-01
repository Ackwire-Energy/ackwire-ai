import { afterEach, expect } from "bun:test";
import { schema } from "@agenteschat/db";
import { decideApproval, runAuthority } from "../../src";
import { ALL_GITHUB_SCOPES, fakeGithub } from "../tool-fixtures";
import { closeWorlds, type World, world } from "./harness";
import { assertInvariants } from "./invariants";
import { scenario } from "./known";
import { deployTool } from "./tools";

// I2 (no idle end) and its bounds (I6): every turn ends working, waiting on something visible, or done.

afterEach(closeWorlds);

const nudges = async (w: World, kind: string) =>
  (await w.steps((await w.runs()).map((r) => r.id))).filter((s) => s.data.nudged === kind).length;

const openQuestions = async (w: World) =>
  (await w.db.select().from(schema.agentQuestions)).filter((q) => q.status === "open");

scenario("S17", "an unkept promise gets one nudge; a turn that set up its waker is not nudged again", async () => {
  const w = await world({
    agents: ["otto"],
    judge: {
      followThrough: (s) => (String(s.reply).startsWith("Agora começo") ? "continue" : "done"),
    },
    script: {
      otto: [
        { text: "Agora começo o #4." },
        {
          text: "Comecei o #4; volto em 30 minutos com o resultado.",
          calls: [{ name: "follow_up", input: { minutes: 30, note: "Ver o #4 e reportar.", about: "o #4" } }],
        },
        { text: "Comecei o #4; volto em 30 minutos com o resultado." },
        { text: "O #4 está pronto: o export agora gera o PDF." },
      ],
    },
  });
  await w.say("@otto e o #4?");
  await w.settle();
  await w.advance(31);
  expect(await nudges(w, "promise")).toBe(1);
  expect(w.judgedAs("follow_through")).toHaveLength(2);
  expect((await w.posts("otto")).at(-1)?.body).toContain("pronto");
  await assertInvariants(w);
});

scenario("S18", "a blocker described instead of asked becomes a question card the person is notified of", async () => {
  const blocker =
    "O que falta: 1. Script de migração. 2. Preciso de uma credencial read-only do banco e de um teste no Teams. Termino o script e te mostro.";
  const w = await world({
    agents: ["otto"],
    judge: { followThrough: () => "ask" },
    script: { otto: [{ text: blocker }, { text: blocker }] },
  });
  await w.say("@otto como está a integração com o Teams?");
  await w.settle();
  const [run] = await w.runs("otto");
  expect(run?.status).toBe("waiting_input");
  expect(await openQuestions(w)).toHaveLength(1);
  const notified = (await w.db.select().from(schema.notifications)).filter((n) => n.kind === "agent_question");
  expect(notified.map((n) => n.userId)).toEqual([w.owner.id]);
  await assertInvariants(w);
});

scenario("S31", "a run in circles ends as stuck with Continuar, and nothing continues it", async () => {
  const w = await world({
    agents: ["otto"],
    judge: { stuck: 0.9, followThrough: () => "continue" },
    setup: { toolSources: [deployTool()] },
    script: { otto: () => ({ calls: [{ name: "deploy", input: { env: "prod" } }] }) },
  });
  await w.say("@otto faz o deploy");
  await w.settle();
  const [run] = await w.runs("otto");
  expect(run?.status).toBe("done");
  expect((await w.posts("otto")).map((m) => m.meta.stepLimit)).toEqual([{ stuck: true }]);
  expect(await nudges(w, "promise")).toBe(0);
  await assertInvariants(w);
});

scenario("S32", "a promise repeated without acting: bounded continues, then a question card", async () => {
  const w = await world({
    agents: ["otto"],
    judge: { followThrough: () => "continue" },
    script: { otto: () => ({ text: "Vou fazer agora." }) },
  });
  await w.say("@otto arruma o teste do login");
  await w.settle();
  expect(w.f.provider.calls.length).toBeLessThanOrEqual(4);
  expect(await openQuestions(w)).toHaveLength(1);
  await assertInvariants(w);
});

scenario("S33", "an offer of reversible work inside the request is done, not asked", async () => {
  const w = await world({
    agents: ["otto"],
    judge: {
      followThrough: (s) =>
        String(s.reply).includes("Quer que eu crie") ? { main: "done", controller: "continue" } : "done",
    },
    script: {
      otto: [
        { text: "Triagem: login e PDF são críticos; export, push e busca podem esperar. Quer que eu crie as issues?" },
        { calls: [{ name: "create_issue", input: { title: "Login falha com SSO" } }] },
        { text: "Criei a issue do login; as outras seguem a mesma triagem." },
      ],
    },
  });
  await w.grant("otto", ["issues:write"]);
  await w.say("@otto faz a triagem desses 5 bugs: login, export, pdf, push, busca");
  await w.settle();
  expect((await w.calls("otto")).map((c) => [c.name, c.isError])).toEqual([["create_issue", false]]);
  await assertInvariants(w);
});

scenario("S34", "an approval waits visibly; after it the agent acts and reports", async () => {
  const github = fakeGithub();
  const w = await world({
    agents: ["otto"],
    setup: { toolSources: [github.source] },
    script: {
      otto: [
        {
          calls: [
            {
              name: "github_merge_pr",
              input: {
                repo: "acme/app",
                pr: 227,
                why: "A Nina aprovou o #227 e o CI passou: o merge fecha o release de hoje.",
              },
            },
          ],
        },
        { text: "Merge feito: o #227 está na main." },
      ],
    },
  });
  await w.grant(
    "otto",
    ALL_GITHUB_SCOPES.map((s) => s.scope),
  );
  await w.say("@otto faz o merge do #227");
  await w.settle();
  const [run] = await w.runs("otto");
  expect(run?.status).toBe("waiting_approval");
  await assertInvariants(w);
  const [approval] = await w.db.select().from(schema.approvals);
  await decideApproval({ db: w.db, pubsub: w.f.pubsub }, w.owner.id, w.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await w.settle();
  expect(github.executed.map((e) => e.tool)).toEqual(["github_merge_pr"]);
  expect((await w.runs("otto"))[0]?.status).toBe("done");
  expect((await w.posts("otto")).at(-1)?.body).toContain("Merge feito");
  await assertInvariants(w);
});

scenario("S41", "a follow-up waits with no nudge, then wakes the agent for the same person", async () => {
  const w = await world({
    agents: ["otto"],
    judge: { followThrough: (s) => (String(s.reply).includes("volto") ? "continue" : "done") },
    script: {
      otto: [
        {
          text: "O deploy 88 está rodando; volto em 30 minutos.",
          calls: [{ name: "follow_up", input: { minutes: 30, note: "Checar o deploy 88.", about: "o deploy" } }],
        },
        { text: "O deploy 88 está rodando; volto em 30 minutos." },
        { text: "Deploy 88 concluído sem erros." },
      ],
    },
  });
  await w.say("@otto acompanha o deploy 88");
  await w.settle();
  expect(await nudges(w, "promise")).toBe(0);
  await w.advance(31);
  const runs = await w.runs("otto");
  expect(runs).toHaveLength(2);
  expect((await runAuthority(w.db, runs[1] as NonNullable<(typeof runs)[1]>)).kind).toBe("person");
  expect((await w.posts("otto")).at(-1)?.body).toContain("concluído");
  await assertInvariants(w);
});

scenario("S45", "a second promise after real tool work gets its second continue, not an ask", async () => {
  const w = await world({
    agents: ["otto"],
    judge: {
      followThrough: (s) => (/vou criar|criar a do export/.test(String(s.reply)) ? "continue" : "done"),
    },
    script: {
      otto: [
        { text: "Agora vou criar as issues." },
        { calls: [{ name: "create_issue", input: { title: "Login falha com SSO" } }] },
        { text: "Criei a do login; agora vou criar a do export." },
        { calls: [{ name: "create_issue", input: { title: "Export trava com 10 mil linhas" } }] },
        { text: "Criei as duas issues: login e export." },
      ],
    },
  });
  await w.grant("otto", ["issues:write"]);
  await w.say("@otto cria as issues do login e do export");
  await w.settle();
  expect(await nudges(w, "promise")).toBe(2);
  expect(await nudges(w, "ask")).toBe(0);
  expect(await openQuestions(w)).toHaveLength(0);
  expect((await w.calls("otto")).map((c) => c.name)).toEqual(["create_issue", "create_issue"]);
  await assertInvariants(w);
});
