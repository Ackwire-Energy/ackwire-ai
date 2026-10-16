import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { schema } from "@agenteschat/db";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Feito."] }) });
});
afterEach(() => t.close());

test("routines API: parse, create, run now, history, pause", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  expect(await (await api("/routines/parse-schedule", { json: { phrase: "dias úteis às 9h" } })).json()).toMatchObject({
    ok: true,
    cron: "0 9 * * 1-5",
    description: "Every week, on weekdays, at 09:00 (UTC)",
    timezone: "UTC",
    rule: { freq: "weekly", byWeekday: ["MO", "TU", "WE", "TH", "FR"], times: ["09:00"] },
  });
  // A locale doesn't change it (descriptions are English).
  expect(
    await (await api("/routines/parse-schedule", { json: { phrase: "dias úteis às 9h", locale: "en" } })).json(),
  ).toMatchObject({ ok: true, description: "Every week, on weekdays, at 09:00 (UTC)" });
  const created = await api("/routines", {
    json: {
      agentId,
      prompt: "Resuma o dia",
      target: { type: "channel", channelId },
      trigger: { type: "schedule", phrase: "dias úteis às 9h" },
    },
  });
  expect(created.status).toBe(201);
  const routine = (await created.json()) as { id: string; active: boolean; nextRunAt: string };
  expect(routine.active).toBe(true);
  await api(`/routines/${routine.id}/run`, { json: {} });
  await t.drain();
  const runs = (await (await api(`/routines/${routine.id}/runs`)).json()) as { runs: { status: string }[] };
  expect(runs.runs.map((r) => r.status)).toEqual(["ok"]);
  const paused = await api(`/routines/${routine.id}`, { method: "PATCH", json: { active: false } });
  expect(await paused.json()).toMatchObject({ active: false, nextRunAt: null });
});

test("webhooks: signature checked; a GitHub PR opened fires the routine listening to it", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  await api("/routines", {
    json: {
      agentId,
      prompt: "Revise o PR novo.",
      target: { type: "channel", channelId },
      trigger: { type: "event", event: "github.pr_opened" },
    },
  });
  const hook = (await (await api("/webhooks", { json: { provider: "github" } })).json()) as {
    url: string;
    secret: string;
  };
  const path = new URL(hook.url).pathname;
  const payload = JSON.stringify({
    action: "opened",
    repository: { full_name: "acme/app" },
    pull_request: { number: 7, title: "Fix login", html_url: "https://github.com/acme/app/pull/7" },
  });
  const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  const send = (signature: string) =>
    t.app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });
  expect((await send(sign("wrong"))).status).toBe(401);
  const ok = await send(sign(hook.secret));
  expect(ok.status).toBe(202);
  expect(await ok.json()).toMatchObject({ event: "github.pr_opened", fired: 1 });
  await t.drain();
  const trigger = (await t.db.select().from(schema.messages)).find((m) => typeof m.meta.routineId === "string");
  expect(trigger?.body).toContain("PR #7 opened in acme/app: Fix login");
});
