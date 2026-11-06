import { expect, test } from "bun:test";
import { ROUTINE_TEMPLATES, templateRule } from "@agenteschat/client/lib/routine-templates";
import {
  type ConnectorListingEntry,
  connectorListing,
  EVENT_WEBHOOK,
  normalizeRule,
  ruleToCron,
  type ScheduleRule,
} from "@agenteschat/engine";

const catalog = connectorListing({ oauthApps: {}, composio: {} as never }) as ConnectorListingEntry[];

test("every app a routine template names is in the connector catalog", () => {
  const ids = new Set(catalog.map((d) => d.id));
  for (const x of ROUTINE_TEMPLATES)
    if ("apps" in x)
      expect({ key: x.key, missing: x.apps.filter((id) => !ids.has(id)) }).toEqual({ key: x.key, missing: [] });
});

test("the server takes every template's schedule as it is", () => {
  for (const x of ROUTINE_TEMPLATES) {
    if (x.kind !== "schedule") continue;
    const rule = templateRule(x, { start: "2026-11-06", timezone: "America/Sao_Paulo" }) as ScheduleRule;
    expect({ key: x.key, cron: ruleToCron(normalizeRule(rule)) === null }).toEqual({ key: x.key, cron: false });
  }
});

test("no template waits on a webhook, which nobody can set up from the app", () => {
  const waiting = ROUTINE_TEMPLATES.filter((x) => x.kind === "event" && EVENT_WEBHOOK[x.event]).map((x) => x.key);
  expect(waiting).toEqual([]);
});
