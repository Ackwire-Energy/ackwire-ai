import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { ApiError } from "../src/api/http";
import { keys } from "../src/api/keys";
import type { ComputerSetup, Me } from "../src/api/types";
import {
  agentsWaitingForComputer,
  computerName,
  newerSetup,
  noComputerChoice,
  SETUP_STAGES,
  SETUP_STEPS,
  setupNoticeKey,
  setupPending,
  setupPortrait,
  setupView,
  WORKSPACE_COMPUTER_KIND,
} from "../src/lib/computer";
import { errorText, holdText, standingRefusalText } from "../src/lib/errors";
import { canReduceAccess } from "../src/lib/machines";
import { applyWorkspaceEvent } from "../src/realtime/machines";

/** The key and its values, so a test sees which words were picked (the words themselves: packages/i18n). */
const t = ((key: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length > 0 ? `${key} ${JSON.stringify(o)}` : key) as unknown as TFunction;

const external = (patch: Partial<ComputerSetup> = {}): ComputerSetup => ({
  mode: "external",
  state: "preparing",
  step: null,
  reason: null,
  since: "2026-10-24T18:49:04.020Z",
  requestedAt: "2026-10-24T18:49:00.000Z",
  expectedReadyAt: null,
  secondsLeft: null,
  secondsWaited: 4,
  notifyByEmail: false,
  specs: null,
  machineId: null,
  ...patch,
});

describe("the workspace's own computer (ADR 0056 §10)", () => {
  test("nothing to show where people connect their own computers, or before the answer", () => {
    expect(setupView(undefined)).toBeNull();
    expect(setupView({ ...external(), mode: "pair", state: null })).toBeNull();
  });

  test("preparing: the step, its number of the four, and the line to show", () => {
    expect(SETUP_STEPS).toEqual(["reserving", "starting", "installing", "connecting"]);
    const view = setupView(external({ step: "starting", specs: { cpus: 4, memoryGb: 8, diskGb: 100 } }));
    expect(view).toMatchObject({
      phase: "preparing",
      step: "starting",
      stepNumber: 2,
      reason: null,
      textKey: "computerSetup.step.starting",
      chipKey: "computerSetup.chip.preparing",
      specs: { cpus: 4, memoryGb: 8, diskGb: 100 },
    });
    // A step the app doesn't know (a newer provisioner) is no step.
    expect(setupView(external({ step: "polishing" as never }))?.step).toBeNull();
  });

  test("no state: the workspace is on hold and waits for no computer, so nothing says one is on its way", () => {
    const paused = setupView(external({ state: null, since: null, requestedAt: null, secondsWaited: null }));
    expect(paused).toMatchObject({
      phase: "paused",
      step: null,
      stepNumber: 0,
      textKey: "computerSetup.status.paused",
      chipKey: "computerSetup.chip.paused",
    });
    expect(setupPending(paused)).toBe(false);
  });

  test("what it is doing within its step: the stage's own words, still that step's number; else the step's", () => {
    expect(setupView(external({ step: "installing", stage: "updating" }))).toMatchObject({
      step: "installing",
      stepNumber: 3,
      textKey: "computerSetup.stage.updating",
    });
    expect(setupView(external({ step: "starting", stage: "wiping" }))?.textKey).toBe("computerSetup.stage.wiping");
    // A stage its step already says, one under another step, one this app doesn't know yet (an older provisioner's
    // last checks among them), or none: the step.
    for (const stage of ["apps", "wiping", "defragmenting", "finishing", "toString", null, undefined])
      expect(setupView(external({ step: "installing", stage }))?.textKey).toBe("computerSetup.step.installing");
    // No step said, or not preparing: no stage either.
    expect(setupView(external({ stage: "updating" }))?.textKey).toBe("computerSetup.status.preparing");
    expect(setupView(external({ state: "waiting", step: "installing", stage: "updating" }))?.textKey).toBe(
      "computerSetup.status.capacity",
    );
  });

  test("a wait is for an available computer, whatever reason it gives; problem and ready have their own words", () => {
    expect(setupView(external({ state: "waiting", reason: "capacity", step: "starting" }))).toMatchObject({
      phase: "waiting",
      step: null,
      reason: "capacity",
      textKey: "computerSetup.status.capacity",
      chipKey: "computerSetup.chip.capacity",
    });
    // An older server's approval, or no reason at all: no wait for an approval anymore.
    expect(setupView(external({ state: "waiting", reason: "approval" as never }))?.textKey).toBe(
      "computerSetup.status.capacity",
    );
    expect(setupView(external({ state: "waiting" }))?.reason).toBe("capacity");
    expect(setupView(external({ state: "problem" }))?.textKey).toBe("computerSetup.status.problem");
    expect(setupView(external({ state: "ready", machineId: "m1" }))).toMatchObject({
      phase: "ready",
      machineId: "m1",
      chipKey: "computerSetup.chip.ready",
    });
  });

  test("every state names one of the keys packages/i18n words (plain-computer-copy.test.ts)", () => {
    const lines = new Set<string>();
    for (const state of ["preparing", "waiting", "problem", "ready", null] as const)
      for (const step of [null, ...SETUP_STEPS])
        for (const reason of [null, "approval" as never, "capacity"] as const)
          for (const stage of [null, ...Object.keys(SETUP_STAGES)]) {
            const view = setupView(external({ state, step, reason, stage }));
            if (view) lines.add(view.textKey).add(view.chipKey);
          }
    expect([...lines].sort()).toEqual([
      "computerSetup.chip.capacity",
      "computerSetup.chip.paused",
      "computerSetup.chip.preparing",
      "computerSetup.chip.problem",
      "computerSetup.chip.ready",
      "computerSetup.stage.booting",
      "computerSetup.stage.firewall",
      "computerSetup.stage.network",
      "computerSetup.stage.ordering",
      "computerSetup.stage.restarting",
      "computerSetup.stage.updating",
      "computerSetup.stage.wiping",
      "computerSetup.status.capacity",
      "computerSetup.status.paused",
      "computerSetup.status.preparing",
      "computerSetup.status.problem",
      "computerSetup.status.ready",
      "computerSetup.step.connecting",
      "computerSetup.step.installing",
      "computerSetup.step.reserving",
      "computerSetup.step.starting",
    ]);
  });

  test("the portrait: lit once ready and online, dimmed on its way, dark when stuck", () => {
    const at = (state: ComputerSetup["state"]) =>
      setupView(external({ state })) as NonNullable<ReturnType<typeof setupView>>;
    expect(setupPortrait(at("preparing"), false)).toBe("paused");
    expect(setupPortrait(at("waiting"), false)).toBe("paused");
    expect(setupPortrait(at("problem"), false)).toBe("offline");
    expect(setupPortrait(at("ready"), true)).toBe("online");
    expect(setupPortrait(at("ready"), false)).toBe("offline");
    expect(setupPortrait(at(null), false)).toBe("paused");
    expect(setupPending(at("waiting"))).toBe(true);
    expect(setupPending(at("ready"))).toBe(false);
    expect(setupPending(null)).toBe(false);
  });

  test("who waits for it: the agents no computer lists", () => {
    const agents = [{ id: "ada" }, { id: "theo" }, { id: "lia" }];
    const machines = [{ agents: [{ id: "theo", name: "Theo", handle: "theo" }] }];
    expect(agentsWaitingForComputer(agents, machines).map((a) => a.id)).toEqual(["ada", "lia"]);
    expect(agentsWaitingForComputer(agents, [])).toHaveLength(3);
  });

  test("a closed notice stays closed for the same state and shows again for a new one", () => {
    const starting = setupView(external({ step: "starting" })) as NonNullable<ReturnType<typeof setupView>>;
    const installing = setupView(external({ step: "installing" })) as NonNullable<ReturnType<typeof setupView>>;
    const waiting = setupView(external({ state: "waiting", reason: "capacity" })) as NonNullable<
      ReturnType<typeof setupView>
    >;
    expect(setupNoticeKey("o1", starting)).toBe(setupNoticeKey("o1", { ...starting }));
    expect(new Set([starting, installing, waiting].map((v) => setupNoticeKey("o1", v))).size).toBe(3);
    expect(setupNoticeKey("o1", starting)).not.toBe(setupNoticeKey("o2", starting));
  });

  test("named in the reader's words while it keeps the name it got, in any language; a name given to it stays", () => {
    const managed = (name: string) => ({ kind: "managed" as const, name });
    const ours = t("computerSetup.title", { org: "Oficina" });
    // Before it exists, and under the name it got in its first owner's language, whichever that was.
    expect(computerName(t, "Oficina", null)).toBe(ours);
    expect(computerName(t, "Oficina", managed("Oficina's computer"))).toBe(ours);
    expect(computerName(t, "Oficina", managed("Computador da Oficina"))).toBe(ours);
    // Renamed by an admin: theirs. Any other computer: its own.
    expect(computerName(t, "Oficina", managed("Servidor da loja"))).toBe("Servidor da loja");
    expect(computerName(t, "Oficina", { kind: "connected", name: "Oficina's computer" })).toBe("Oficina's computer");
    // The server's own: its runner's name, and what it is until the runner names it.
    expect(computerName(t, "Oficina", { kind: "host", name: "srv-1" })).toBe("srv-1");
    expect(computerName(t, "Oficina", { kind: "host", name: "" })).toBe("machines.host.label");
  });

  test("drawn as a server before and after it exists, never as the cloud computer an agent gets", () => {
    expect(WORKSPACE_COMPUTER_KIND).toBe("linux");
  });

  test('"no computer" in the pickers: a Daytona sandbox, the workspace\'s computer on its way, or plainly none', () => {
    const at = (state: ComputerSetup["state"]) => setupView(external({ state }));
    // People connect their own computers: Daytona's sandbox only where the server has them, never "the cloud".
    expect(noComputerChoice(null, true, false)).toBe("cloud");
    expect(noComputerChoice(null, false, false)).toBeNull();
    expect(noComputerChoice(null, false, true)).toBe("none");
    // On its way: the agents with no computer get it, so that's what the choice is.
    for (const state of ["preparing", "waiting", "problem"] as const) {
      expect(noComputerChoice(at(state), false, false)).toBe("workspace");
    }
    // Ready, or on hold with none on its way, on a server with no cloud computer: never offered, only shown for an
    // agent that has none.
    for (const state of ["ready", null] as const) {
      expect(noComputerChoice(at(state), false, false)).toBeNull();
      expect(noComputerChoice(at(state), false, true)).toBe("none");
      expect(noComputerChoice(at(state), true, false)).toBe("cloud");
    }
  });

  test("nobody turns a tool off or takes a folder away on the workspace's own computer", () => {
    expect(canReduceAccess({ canManage: true, kind: "connected" })).toBe(true);
    expect(canReduceAccess({ canManage: true })).toBe(true);
    expect(canReduceAccess({ canManage: false, kind: "connected" })).toBe(false);
    expect(canReduceAccess({ canManage: true, kind: "managed" })).toBe(false);
  });

  test("an answer that left before an event never undoes it; a newer one, or one after a reset, does", () => {
    const ready = external({ state: "ready", since: "2026-10-24T19:00:00.000Z", machineId: "m1" });
    const stale = external({ state: "preparing", step: "connecting", since: "2026-10-24T18:59:00.000Z" });
    expect(newerSetup(ready, stale)).toBe(ready);
    expect(newerSetup(stale, ready)).toBe(ready);
    expect(newerSetup(undefined, stale)).toBe(stale);
    // Taken back (since null): the next answer starts over.
    const reset = external({ state: "preparing", since: null });
    expect(newerSetup(reset, stale)).toBe(stale);
  });
});

describe("live: machine.provisioning and org.standing", () => {
  test("a provisioning event replaces the setup; ready refreshes the computers", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.computerSetup("o1"), external({ step: "reserving" }));
    let refetched = 0;
    qc.getQueryCache().subscribe((e) => {
      if (e.type === "updated" && e.action.type === "invalidate") refetched++;
    });
    qc.setQueryData(keys.machines("o1"), []);
    expect(
      applyWorkspaceEvent(qc, "o1", {
        type: "machine.provisioning",
        state: "waiting",
        reason: "capacity",
        step: null,
        since: "2026-10-24T19:00:00.000Z",
        requestedAt: "2026-10-24T18:49:00.000Z",
        expectedReadyAt: null,
        secondsLeft: null,
        secondsWaited: 660,
        specs: { cpus: 4, memoryGb: 8, diskGb: 100 },
        machineId: null,
      } as { type: string }),
    ).toBe(true);
    expect(qc.getQueryData<ComputerSetup>(keys.computerSetup("o1"))).toEqual({
      mode: "external",
      state: "waiting",
      step: null,
      stage: null,
      reason: "capacity",
      since: "2026-10-24T19:00:00.000Z",
      requestedAt: "2026-10-24T18:49:00.000Z",
      expectedReadyAt: null,
      secondsLeft: null,
      secondsWaited: 660,
      // The event doesn't say whether the server sends email: what the answer said stays.
      notifyByEmail: false,
      specs: { cpus: 4, memoryGb: 8, diskGb: 100 },
      machineId: null,
    });
    expect(refetched).toBe(0);
    // What it is doing within its step comes with it.
    applyWorkspaceEvent(qc, "o1", {
      type: "machine.provisioning",
      state: "preparing",
      step: "installing",
      stage: "restarting",
      secondsLeft: 257,
    } as { type: string });
    expect(qc.getQueryData<ComputerSetup>(keys.computerSetup("o1"))).toMatchObject({
      stage: "restarting",
      secondsLeft: 257,
    });
    applyWorkspaceEvent(qc, "o1", { type: "machine.provisioning", state: "ready", machineId: "m1" } as {
      type: string;
    });
    expect(qc.getQueryData<ComputerSetup>(keys.computerSetup("o1"))).toMatchObject({ state: "ready", machineId: "m1" });
    expect(qc.getQueryState(keys.machines("o1"))?.isInvalidated).toBe(true);
    expect(applyWorkspaceEvent(qc, "o1", { type: "machine.status" })).toBe(false);
  });

  test("a standing event sets that workspace's standing in /me (the reason only when told) and asks for its setup", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.computerSetup("o1"), external({ state: "waiting", reason: "capacity" }));
    const me: Me = {
      user: { id: "u1", name: "Walt", email: "w@x.co", image: null },
      organizations: [
        { id: "o1", name: "Acme", role: "owner" },
        { id: "o2", name: "Beta", role: "member" },
      ],
    };
    qc.setQueryData(keys.me, me);
    applyWorkspaceEvent(qc, "o1", { type: "org.standing", orgId: "o1", state: "hold", reason: null } as {
      type: string;
    });
    const after = qc.getQueryData<Me>(keys.me);
    expect(after?.organizations[0]?.standing).toEqual({ state: "hold", reason: null });
    expect(after?.organizations[1]?.standing).toBeUndefined();
    // On hold it waits for no computer, active again it waits for one: the server's answer follows the standing.
    expect(qc.getQueryState(keys.computerSetup("o1"))?.isInvalidated).toBe(true);
    applyWorkspaceEvent(qc, "o1", { type: "org.standing", orgId: "o1", state: "suspended", reason: "Pagamento" } as {
      type: string;
    });
    expect(qc.getQueryData<Me>(keys.me)?.organizations[0]?.standing).toEqual({
      state: "suspended",
      reason: "Pagamento",
    });
  });
});

describe("the workspace's standing in words (ADR 0056 §8)", () => {
  test("the hold banner: the reason when told, else only paused for review; nothing otherwise", () => {
    expect(holdText(t, { state: "hold", reason: "verificação de pagamento" })).toBe(
      'standing.onHold {"reason":"verificação de pagamento"}',
    );
    // Silent: the same words a refused run says.
    expect(holdText(t, { state: "hold", reason: null })).toBe("standing.paused");
    expect(holdText(t, { state: "active", reason: null })).toBeNull();
    expect(holdText(t, { state: "suspended", reason: null })).toBeNull();
    expect(holdText(t, undefined)).toBeNull();
  });

  test("refusals, from the API or a run, in the person's language with the reason told", () => {
    expect(standingRefusalText(t, "run.org_paused", { reason: "payment check" })).toBe(
      'standing.onHold {"reason":"payment check"}',
    );
    expect(standingRefusalText(t, "run.org_paused", { reason: "  " })).toBe("standing.paused");
    expect(standingRefusalText(t, "run.org_suspended", undefined)).toBe("standing.suspended");
    expect(standingRefusalText(t, "run.org_suspended", { reason: "spam" })).toBe(
      'standing.suspendedFor {"reason":"spam"}',
    );
    expect(standingRefusalText(t, "run.agent_paused", null)).toBe("standing.agentPaused");
    expect(standingRefusalText(t, "run.budget_exceeded", null)).toBeNull();
    expect(standingRefusalText(t, undefined, null)).toBeNull();
    // The API's own codes, through errorText.
    expect(errorText(t, new ApiError(403, "org.paused", "This workspace is on hold: x", { reason: "x" }))).toBe(
      'standing.onHold {"reason":"x"}',
    );
    expect(errorText(t, new ApiError(403, "org.suspended", "This workspace is unavailable for now."))).toBe(
      "standing.suspended",
    );
    expect(errorText(t, new ApiError(403, "agent.paused", "This agent is paused for now."))).toBe(
      "standing.agentPaused",
    );
  });
});
