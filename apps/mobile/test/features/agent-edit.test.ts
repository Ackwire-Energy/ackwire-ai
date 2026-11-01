import { describe, expect, test } from "bun:test";
import { coordinatorNote } from "@agenteschat/client/lib/coordinator";
import { agentsByAnyHandle } from "@agenteschat/client/lib/directory";
import {
  handleAfterRename,
  handleProblemText,
  presetChannels,
  presetLevels,
  ROLE_DEFAULTS,
  ROLE_IDS,
  takenHandles,
} from "@agenteschat/client/lib/new-agent";
import {
  type AgentDraft,
  agentChanges,
  editableFields,
  fullLook,
  sameLook,
  shuffleLook,
} from "../../src/features/agents/edit";
import { firstBlockedStep, NEW_AGENT_PHONE_STEPS, stepBlocked } from "../../src/features/agents/new-agent";
import { AGENT_ACCESSORIES, AGENT_COLORS, AGENT_EYES } from "../../src/features/shared/logic";
import { translator } from "./fixtures";

describe("an agent's look", () => {
  test("every part is set, unknown values fall back to the default agent", () => {
    expect(fullLook({ color: "rose", eyes: "happy", accessory: "crown" })).toEqual({
      color: "rose",
      eyes: "happy",
      accessory: "crown",
    });
    expect(fullLook({ color: "plaid", eyes: 3 })).toEqual({ color: "sky", eyes: "round", accessory: "none" });
    expect(fullLook(undefined)).toEqual({ color: "sky", eyes: "round", accessory: "none" });
  });

  test("Sortear always lands on a different look", () => {
    const now = fullLook({ color: "sky", eyes: "round", accessory: "none" });
    // A "random" that would give the same look every time still moves.
    expect(
      sameLook(
        shuffleLook(now, () => 0),
        now,
      ),
    ).toBe(false);
    let seed = 1;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    for (let i = 0; i < 50; i++) {
      const next = shuffleLook(now, rand);
      expect(sameLook(next, now)).toBe(false);
      expect(AGENT_COLORS).toContain(next.color);
      expect(AGENT_EYES).toContain(next.eyes);
      expect(AGENT_ACCESSORIES).toContain(next.accessory);
    }
  });

  test("every role starts with a look the phone can draw", () => {
    for (const id of ROLE_IDS) {
      const look = ROLE_DEFAULTS[id].look;
      expect(fullLook(look)).toEqual(look);
    }
  });
});

describe("editing an agent", () => {
  const saved: AgentDraft = {
    name: "Nina",
    handle: "nina",
    role: "Atendimento",
    instructions: "Responde clientes.",
    look: { color: "teal", eyes: "happy", accessory: "headset" },
    coordinator: false,
  };

  test("admins change everything, its person only the look, others nothing", () => {
    expect([...editableFields({ admin: true, owner: false })].sort()).toEqual([
      "coordinator",
      "instructions",
      "look",
      "name",
      "role",
    ]);
    expect([...editableFields({ admin: false, owner: true })]).toEqual(["look"]);
    expect(editableFields({ admin: false, owner: false }).size).toBe(0);
  });

  test("a save sends only what changed and may change", () => {
    const all = editableFields({ admin: true, owner: false });
    expect(agentChanges(saved, saved, all)).toBeNull();
    expect(
      agentChanges(saved, { ...saved, name: " Nina B ", look: { ...saved.look, accessory: "crown" } }, all),
    ).toEqual({ name: "Nina B", appearance: { color: "teal", eyes: "happy", accessory: "crown" } });
    // Its person's draft can't carry a new name.
    const own = editableFields({ admin: false, owner: true });
    expect(agentChanges(saved, { ...saved, name: "Outra", instructions: "x" }, own)).toBeNull();
    // An emptied name is never sent.
    expect(agentChanges(saved, { ...saved, name: "  " }, all)).toBeNull();
  });

  test("who coordinates the team (ADR 0093): admins switch it, its person can't; the line says who does now", async () => {
    const turnedOn = { ...saved, coordinator: true };
    expect(agentChanges(saved, turnedOn, editableFields({ admin: true, owner: false }))).toEqual({ coordinator: true });
    expect(agentChanges(saved, turnedOn, editableFields({ admin: false, owner: true }))).toBeNull();
    const pt = await translator("pt-BR");
    const en = await translator("en");
    const nina = { id: "nina", name: "Nina", coordinator: false };
    const team = [nina, { id: "theo", name: "Theo", coordinator: true }];
    expect(coordinatorNote(pt, team, "nina", false)).toBe("Hoje quem coordena é o Theo.");
    expect(coordinatorNote(pt, team, "nina", true)).toBe("Hoje quem coordena é o Theo. Só um agente coordena por vez.");
    expect(coordinatorNote(en, team, "nina", true)).toBe(
      "Theo coordinates the team now. One agent coordinates at a time.",
    );
    expect(coordinatorNote(pt, team, "theo", true)).toBeNull();
    expect(coordinatorNote(pt, [nina], "nina", false)).toBe("Ninguém coordena o time agora.");
  });
});

describe("renaming an agent on the phone", () => {
  const saved: AgentDraft = { name: "Ada", handle: "ada", role: "Dev", instructions: "", look: fullLook(undefined) };
  const all = editableFields({ admin: true, owner: false });

  test("its @ follows the new name until one is typed in Menções; Salvar sends both", () => {
    const draft = { ...saved, name: "Claudio", handle: handleAfterRename(saved, "Claudio") };
    expect(draft.handle).toBe("claudio");
    expect(agentChanges(saved, draft, all)).toEqual({ name: "Claudio", handle: "claudio" });
    expect(agentChanges(saved, { ...saved, handle: handleAfterRename(saved, "Ada", "dra") }, all)).toEqual({
      handle: "dra",
    });
    expect(handleAfterRename(saved, "Claudio", "clau")).toBe("clau");
    // The agent's own person changes its look only: never its @.
    expect(agentChanges(saved, draft, editableFields({ admin: false, owner: true }))).toBeNull();
  });

  test("Menções says why a taken @ can't be used and offers a free one; its own old @ comes back", async () => {
    const t = await translator("pt-BR");
    const agents = [
      { id: "a1", handle: "ada", previousHandles: ["dra"] },
      { id: "a2", handle: "atlas", previousHandles: ["zeus"] },
    ];
    const taken = takenHandles(agents, [{ handle: "walter" }, { handle: null }], "a1");
    expect(handleProblemText(t, "atlas", taken)).toBe("@atlas já é de outro agente ou pessoa. Que tal @atlas-2?");
    expect(handleProblemText(t, "zeus", taken)).toBe("@zeus já é de outro agente ou pessoa. Que tal @zeus-2?");
    expect(handleProblemText(t, "walter", taken)).toBe("@walter já é de outro agente ou pessoa. Que tal @walter-2?");
    expect(handleProblemText(t, "dra", taken)).toBeNull();
    expect(handleProblemText(t, "x", taken)).toBe(
      "Use de 2 a 32 letras minúsculas, números, hífen ou _, começando por letra ou número.",
    );
    expect(t("agent.handleMoves", { handle: "claudio", old: "ada" })).toBe(
      "As menções passam a ser por @claudio. @ada continua funcionando.",
    );
    expect(t("agent.identityHelp")).toBe("É como todo mundo vê o agente. O @ acompanha o nome.");
  });

  test("a notice that names an old @ shows the agent now called by another", () => {
    const byHandle = agentsByAnyHandle([
      { id: "a1", name: "Claudio", handle: "claudio", previousHandles: ["ada"] },
      { id: "a2", name: "Atlas", handle: "atlas" },
    ]);
    expect(byHandle.get("ada")?.name).toBe("Claudio");
    expect(byHandle.get("claudio")?.name).toBe("Claudio");
    expect(byHandle.get("atlas")?.name).toBe("Atlas");
  });
});

describe("creating an agent on the phone", () => {
  const taken = new Set(["ada", "walt"]);

  test("the steps that fit a thumb, in the web's order", () => {
    expect([...NEW_AGENT_PHONE_STEPS]).toEqual(["role", "identity", "instructions", "review"]);
  });

  test("a role first, then a name and a free @", () => {
    const draft = { role: null, name: "", handle: "", taken };
    expect(firstBlockedStep(draft)).toBe(0);
    expect(stepBlocked("identity", { ...draft, role: "dev", name: "Ada", handle: "ada" })).toBe(true);
    expect(stepBlocked("identity", { ...draft, role: "dev", name: "Ada", handle: "ada-2" })).toBe(false);
    expect(stepBlocked("identity", { ...draft, role: "dev", name: "Ada", handle: "-x" })).toBe(true);
    expect(firstBlockedStep({ role: "custom", name: "Lu", handle: "lu", taken })).toBe(-1);
  });

  test("a role brings its apps' levels and the channels the workspace has", () => {
    const items = [
      { id: "c1", def: { id: "github" } },
      { id: "c2", def: { id: "stripe" } },
      { id: "c3", def: null },
    ];
    expect(presetLevels("dev", items)).toEqual({ c1: "write", c2: "none", c3: "none" });
    expect(presetLevels("custom", items)).toEqual({ c1: "none", c2: "none", c3: "none" });
    const channels = [
      { id: "1", name: "Engenharia" },
      { id: "2", name: "geral" },
    ];
    expect(presetChannels("dev", channels)).toEqual(["1"]);
    expect(presetChannels("assistant", channels)).toEqual(["2"]);
  });
});
