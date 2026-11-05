import { describe, expect, test } from "bun:test";
import type { AgentGroup, Channel, Member, TeamAgent } from "@agenteschat/client";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";
import { teamSections } from "../../src/features/team/logic";

const agent = (id: string, over: Partial<TeamAgent> = {}): TeamAgent => ({
  id,
  name: id,
  handle: id.toLowerCase(),
  role: "",
  appearance: null,
  ownerUserId: null,
  capabilities: [],
  busy: false,
  canTalk: true,
  channelIds: [],
  ...over,
});
const member = (userId: string, name: string) => ({ userId, name }) as Member;
const channel = (id: string, name: string) => ({ id, name }) as Channel;
const input = {
  agents: [
    agent("Ada", { ownerUserId: "u-lukas", channelIds: ["c-eng"] }),
    agent("Milo", { channelIds: ["c-fin"] }),
    agent("Lodi"),
  ],
  groups: [
    { id: "g-eng", name: "Engenharia", agentIds: ["Ada"], leadUserId: "u-lukas", backupUserId: "u-gone" },
  ] as AgentGroup[],
  members: [member("u-lukas", "Lukas")],
  channels: [channel("c-fin", "financeiro"), channel("c-eng", "engenharia")],
  rightHandId: "Lodi",
};
const shape = (view: "list" | "chart" | "map") =>
  teamSections(view, input).map((s) => [s.title, s.agents.map((a) => a.name)]);

describe("Equipe on the phone (ADR 0148)", () => {
  test("Lista by setor, Organograma by person, Mapa by channel: the web's views, the right hand left out", () => {
    expect(shape("list")).toEqual([
      ["Engenharia", ["Ada"]],
      [null, ["Milo"]],
    ]);
    // Each setor says who leads it and who covers, as the web's card (someone who left reads as nobody).
    expect(teamSections("list", input)[0]).toMatchObject({ lead: "Lukas", backup: null });
    expect(shape("chart")).toEqual([
      ["Lukas", ["Ada"]],
      [null, ["Milo"]],
    ]);
    expect(shape("map")).toEqual([
      ["#financeiro", ["Milo"]],
      ["#engenharia", ["Ada"]],
    ]);
  });

  test("its words exist in English and Portuguese", () => {
    expect(featureKeysEn.team.mapHint).toContain("{{name}}");
    expect(featureKeysPtBR.team.mapHint).toContain("{{name}}");
    expect(featureKeysPtBR.agents.noGroupSection).toBe("Sem setor");
  });
});
