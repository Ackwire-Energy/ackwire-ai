import { describe, expect, test } from "bun:test";
import type { OrgRole } from "../src/api/types";
import {
  modeSwitchLines,
  PERSONAL_SETTINGS,
  personalHelperRole,
  personalSettingsHost,
  personalSettingsNav,
  settingsSectionNameKey,
  settingsSectionTextKey,
} from "../src/lib/personal-view";

/* What a personal workspace shows (ADR 0158): only the view changes, for the web and the phone app alike. */

const personal = { mode: "personal" as const };
const team = { mode: "team" as const };
const sections = (ids: string[]) => ids.map((id) => ({ id }));

describe("a personal workspace's settings list", () => {
  test("the six first in their order, then every other section the person may open, in its usual order", () => {
    const open = sections([
      "account",
      "notifications",
      "general",
      "members",
      "roles",
      "vault",
      "connectors",
      "skills",
      "computers",
      "usage",
      "keys",
      "storage",
      "billing",
    ]);
    const { main, advanced } = personalSettingsNav(open);
    expect(main.map((s) => s.id)).toEqual([...PERSONAL_SETTINGS]);
    // Connectors, skills and billing are on AI and apps' and Plan and usage's pages, not listed again.
    expect(advanced.map((s) => s.id)).toEqual(["notifications", "members", "roles", "storage"]);
  });

  test("a section the person can't open is left out; a part whose page they can't open stays under Advanced", () => {
    const { main, advanced } = personalSettingsNav(sections(["account", "vault", "connectors", "usage"]));
    expect(main.map((s) => s.id)).toEqual(["account", "usage", "vault"]);
    expect(advanced.map((s) => s.id)).toEqual(["connectors"]);
  });

  test("a part's page: AI and apps for connectors and skills, Plan and usage for billing, when it opens", () => {
    const open = new Set(["keys", "usage"]);
    expect(personalSettingsHost("connectors", open)).toBe("keys");
    expect(personalSettingsHost("skills", open)).toBe("keys");
    expect(personalSettingsHost("billing", open)).toBe("usage");
    expect(personalSettingsHost("vault", open)).toBeNull();
    expect(personalSettingsHost("connectors", new Set(["usage"]))).toBeNull();
  });

  test("names and lines: a personal workspace's own for the sections it renames, the usual ones elsewhere", () => {
    expect(settingsSectionNameKey(personal, "general")).toBe("settings.section.generalPersonal");
    expect(settingsSectionNameKey(personal, "keys")).toBe("settings.section.keysPersonal");
    expect(settingsSectionNameKey(personal, "usage")).toBe("settings.section.usagePersonal");
    expect(settingsSectionNameKey(personal, "vault")).toBe("settings.section.vault");
    expect(settingsSectionNameKey(team, "general")).toBe("settings.section.general");
    // An older server says no mode: a team's.
    expect(settingsSectionNameKey({}, "keys")).toBe("settings.section.keys");
    expect(settingsSectionTextKey(personal, "connectors")).toBe("settings.sectionText.connectorsPersonal");
    expect(settingsSectionTextKey(personal, "roles")).toBe("settings.sectionText.roles");
    expect(settingsSectionTextKey(team, "connectors")).toBe("settings.sectionText.connectors");
  });
});

describe("switching the mode", () => {
  test("to a team's: what comes into sight", () => {
    expect(modeSwitchLines("team", 3).map((l) => l.key)).toEqual([
      "personalMode.toTeam.channels",
      "personalMode.toTeam.roles",
      "personalMode.toTeam.admin",
    ]);
  });

  test("to personal: what changes, and that the others see it too only when there are others", () => {
    expect(modeSwitchLines("personal", 0).map((l) => l.key)).not.toContain("personalMode.toPersonal.others");
    const lines = modeSwitchLines("personal", 2);
    expect(lines.at(-1)).toEqual({ icon: "members", key: "personalMode.toPersonal.others", count: 2 });
    expect(lines).toHaveLength(5);
  });
});

describe("inviting in a personal workspace", () => {
  const role = (over: Partial<OrgRole>): OrgRole => ({
    id: "r",
    kind: "custom",
    name: "Role",
    icon: "shield",
    color: "indigo",
    position: 0,
    permissions: [],
    mentionable: false,
    hoist: false,
    people: 0,
    editable: true,
    givable: true,
    ...over,
  });

  test("helps run it: the highest role the inviter may give that holds administrator", () => {
    const roles = [
      role({ id: "everyone", kind: "everyone", position: 9, permissions: ["post"] }),
      role({ id: "editor", position: 1, permissions: ["edit_wiki"] }),
      role({ id: "admin-2", position: 2, permissions: ["administrator"] }),
      role({ id: "admin", position: 0, permissions: ["administrator"] }),
    ];
    expect(personalHelperRole(roles)?.id).toBe("admin");
  });

  test("none to give (an Admin above the inviter's own): no second choice", () => {
    expect(personalHelperRole([role({ permissions: ["administrator"], givable: false })])).toBeNull();
    expect(personalHelperRole([role({ permissions: ["edit_wiki"] })])).toBeNull();
  });
});
