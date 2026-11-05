import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { accountOutOfReach, deletedByText, deletingText, restorable } from "@agenteschat/client/lib/deletion";
import { suspendedText } from "@agenteschat/client/lib/errors";
import { type OutageTargetLike, targetOptions } from "@agenteschat/client/lib/machine-outages";
import { computerIcon, type MachineOutage, targetText } from "../../src/features/outages/logic";
import { deletingOf, suspendedOf } from "../../src/lib/org-choice";
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
    expect(computerIcon(option.platform)).toBe("computerLinux");
    const en = await translator("en");
    expect(targetText(en, option)).toMatchObject({ desc: "Just for this workspace · one user per agent" });
  });
});

describe("an organization being deleted on the phone", () => {
  const deletion = {
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    requestedAt: new Date().toISOString(),
    requestedBy: { id: "u2", name: "Bia" },
  };
  const orgs = [
    { id: "a", name: "Acme", role: "member" as const, deletion },
    { id: "b", name: "Beta", role: "owner" as const },
    { id: "c", name: "Casa", role: "owner" as const, standing: { state: "suspended" as const, reason: null } },
  ];

  test("the chosen one: its screen, and where else to go (none suspended)", () => {
    expect(deletingOf(orgs, "a")).toEqual({ org: orgs[0], others: [orgs[1]] });
    expect(deletingOf(orgs, "b")).toBeNull();
  });

  test("who deleted it and when it goes; only owners restore it, and only before that", async () => {
    const t = await translator("pt-BR");
    expect(deletingText(t, "pt-BR", deletion)).toMatch(
      /^Este workspace já está sendo apagado\. Não precisa fazer nada, ele some em .+\.$/,
    );
    expect(deletingText(t, "pt-BR", { ...deletion, dueAt: null })).toBe(
      "Este workspace já está sendo apagado. Não precisa fazer nada.",
    );
    expect(deletedByText(t, "pt-BR", deletion)).toMatch(/^Bia apagou em .+\.$/);
    expect(deletedByText(t, "pt-BR", { ...deletion, requestedBy: null })).toMatch(/^Alguém apagou em .+\.$/);
    expect(restorable(orgs[0])).toBe(false);
    expect(restorable({ role: "owner", deletion })).toBe(true);
    expect(restorable({ role: "owner", deletion: { ...deletion, dueAt: null } })).toBe(false);
  });
});

describe("Apagar conta on the phone's closed screens and first run", () => {
  const read = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
  const deletion = { dueAt: new Date(Date.now() + 86_400_000).toISOString(), requestedAt: null, requestedBy: null };

  test("offered only with no workspace that opens", () => {
    const closing = { id: "a", role: "owner" as const, deletion };
    expect(accountOutOfReach([closing, { id: "b", role: "member" as const }])).toBe(false);
    expect(accountOutOfReach([closing])).toBe(true);
    expect(accountOutOfReach([])).toBe(true);
  });

  test("every entry goes through WholeAccount, which asks that, after Sair", () => {
    expect(read("ui/auth/WholeAccount.tsx")).toContain("if (!accountOutOfReach(orgs)) return null;");
    for (const screen of [
      "ui/auth/DeletingWorkspace.tsx",
      "ui/auth/SuspendedWorkspace.tsx",
      "features/onboarding/OnboardingFlow.tsx",
    ]) {
      const code = read(screen);
      expect(code).not.toContain('label={t("deleteAccount.menu")}');
      expect(code.indexOf("<WholeAccount")).toBeGreaterThan(code.indexOf('t("mobile.org.signOut")'));
    }
  });

  test("the first workspace that opens is the main action, Restaurar only with nowhere else to go", () => {
    expect(read("ui/auth/DeletingWorkspace.tsx")).toContain(
      'variant={others.some(workspaceOpens) ? "secondary" : "primary"}',
    );
    for (const screen of ["ui/auth/DeletingWorkspace.tsx", "ui/auth/SuspendedWorkspace.tsx"])
      expect(read(screen)).toContain('variant={i === 0 && workspaceOpens(o) ? "primary" : "secondary"}');
  });

  test("the lists and the deletion screen say closed and same-named apart", () => {
    expect(read("features/me/PreferencePages.tsx")).toContain("sub={notes.get(o.id)}");
    const screen = read("features/me/DeleteAccountScreen.tsx");
    expect(screen).toContain('t("deleteAccount.title")');
    expect(screen).toContain('t("deleteAccount.intro")');
    expect(screen).toContain('t("deleteAccount.oneWorkspace")');
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
      cloud: false,
      others: [orgs[1], orgs[2]],
    });
    expect(suspendedOf(orgs, "d")?.reason).toBeNull();
  });

  test("its line: why, and on agentes.chat Cloud how to contest it", async () => {
    const t = await translator("pt-BR");
    expect(suspendedText(t, suspendedOf(orgs, "a"))).toBe("Este workspace está suspenso: uso fora dos termos");
    const cloud = [{ id: "e", name: "Eco", standing: { state: "suspended", reason: "Termos 5: spam", cloud: true } }];
    expect(suspendedText(t, suspendedOf(cloud, "e"))).toBe(
      "Este workspace está suspenso: Termos 5: spam. Para contestar, escreva para legal@agentes.chat.",
    );
    expect(suspendedText(t, suspendedOf(orgs, "d"))).toBe(
      "As conversas e os agentes dele estão fechados por enquanto.",
    );
  });

  test("active or on hold: no suspended screen", () => {
    expect(suspendedOf(orgs, "b")).toBeNull();
    expect(suspendedOf(orgs, "c")).toBeNull();
    expect(suspendedOf(orgs, null)).toBeNull();
  });
});
