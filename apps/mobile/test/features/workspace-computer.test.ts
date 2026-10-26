import { describe, expect, test } from "bun:test";
import { type OutageTargetLike, targetOptions } from "@agenteschat/client/lib/machine-outages";
import { computerIcon, type MachineOutage, targetText } from "../../src/features/outages/logic";
import { suspendedOf } from "../../src/lib/org-choice";
import { translator } from "./fixtures";

/** The workspace's own computer (ADR 0056 §10): the server names it ("Computador da Acme"), its system never said. */
const managed: OutageTargetLike = {
  kind: "machine",
  machineId: "ws",
  name: "Computador da Acme",
  platform: "other",
  managed: true,
  online: true,
  brains: ["claude_code"],
  reasonOff: null,
};
const air: MachineOutage = {
  machineId: "air",
  name: "MacBook Air",
  platform: "darwin",
  offlineSince: "2026-10-18T20:00:00.000Z",
  waitingRuns: 0,
  agents: [{ agentId: "ada", name: "Ada", brain: "claude_code", waiting: { routines: 0, conversations: 1 } }],
};

describe("the workspace's own computer on the phone (the switch sheet's card)", () => {
  test("as a target: its name, always on, one user per agent, drawn as a server", async () => {
    const t = await translator("pt-BR");
    const [option] = targetOptions(air, [managed], ["ada"]);
    expect(option).toMatchObject({ managed: true, enabled: true });
    if (!option) throw new Error("no option");
    expect(targetText(t, option)).toEqual({
      title: "Computador da Acme",
      tag: "Sempre ligado",
      desc: "Só deste workspace · um usuário para cada agente",
    });
    expect(computerIcon(option.platform, option.kind === "cloud")).toBe("computerLinux");
    const en = await translator("en");
    expect(targetText(en, option)).toMatchObject({ desc: "Just for this workspace · one user per agent" });
  });
});

describe("a suspended organization on the phone", () => {
  const orgs = [
    { id: "a", name: "Acme", standing: { state: "suspended", reason: "uso fora dos termos" } },
    { id: "b", name: "Beta" },
    { id: "c", name: "Casa", standing: { state: "hold", reason: null } },
    { id: "d", name: "Dez", standing: { state: "suspended", reason: null } },
  ];

  test("the chosen one suspended: why (when told) and where else to go", () => {
    expect(suspendedOf(orgs, "a")).toEqual({
      reason: "uso fora dos termos",
      others: [orgs[1], orgs[2]],
    });
    expect(suspendedOf(orgs, "d")?.reason).toBeNull();
  });

  test("active or on hold: no suspended screen", () => {
    expect(suspendedOf(orgs, "b")).toBeNull();
    expect(suspendedOf(orgs, "c")).toBeNull();
    expect(suspendedOf(orgs, null)).toBeNull();
  });
});
