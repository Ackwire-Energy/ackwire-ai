import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { keys } from "../src/api/keys";
import type { Hold } from "../src/api/types";
import { holdLine } from "../src/lib/holds";
import { applyMachineEvent } from "../src/realtime/machines";

/** The key and its values, so a test sees which words were picked (the words themselves: packages/i18n). */
const t = ((key: string, o?: Record<string, unknown>) =>
  o ? `${key}${JSON.stringify(o)}` : key) as unknown as TFunction;

const HOLD: Hold = {
  id: "h1",
  agentId: "a1",
  machineId: "m1",
  what: "Telegram bot",
  why: "answers the support group",
  kind: "program",
  since: "2026-11-12T09:00:00.000Z",
  until: null,
};
const NOW = new Date("2026-11-12T12:00:00.000Z");

test("a hold's line: what, then which agent kept it, since when and until when (its program, its browser, a time)", () => {
  const program = holdLine(t, HOLD, { agent: "Dev", locale: "en", now: NOW });
  expect(program.what).toBe("Telegram bot");
  expect(program.meta).toStartWith('agentComputer.kept.meta{"name":"Dev","since":"format.todayAt');
  expect(program.meta).toEndWith('"until":"agentComputer.kept.untilStops"}');
  expect(holdLine(t, { ...HOLD, kind: "browser" }, { agent: "Dev", locale: "en", now: NOW }).meta).toContain(
    "agentComputer.kept.untilClosed",
  );
  const timed = holdLine(
    t,
    { ...HOLD, kind: "time", until: "2026-11-13T18:00:00.000Z" },
    { agent: "Dev", locale: "en", now: NOW },
  );
  expect(timed.meta).toContain('agentComputer.kept.until{\\"time\\":\\"format.tomorrowAt');
});

test("machine.holds asks for that agent's holds again, and nothing else of the computer", () => {
  const qc = new QueryClient();
  const asked: unknown[] = [];
  qc.invalidateQueries = (async (filters?: { queryKey?: unknown }) => {
    asked.push(filters?.queryKey);
  }) as QueryClient["invalidateQueries"];
  expect(applyMachineEvent(qc, "o1", { type: "machine.holds", machineId: "m1", agentId: "a1" } as never)).toBe(true);
  expect(asked).toEqual([keys.agentHolds("o1", "a1")]);
});
