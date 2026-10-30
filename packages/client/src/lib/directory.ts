import type { Agent, FormerAgent } from "../api/types";

/** An agent no longer in the team as the directories hold it: its name, role and look; nobody talks to it. */
export const formerAgent = (a: FormerAgent): Agent => ({
  id: a.id,
  name: a.name,
  handle: "",
  role: a.role,
  instructions: "",
  model: "",
  ownerUserId: null,
  hasCredential: false,
  createdAt: "",
  canTalk: false,
  former: a.deleted ? "deleted" : "archived",
  ...(a.appearance ? { appearance: a.appearance } : {}),
});

/** Agents no longer in the team by id (ADR 0082), apart from the team's so no list or picker offers them. */
export const formerById = (former: FormerAgent[] = []) => new Map(former.map((a) => [a.id, formerAgent(a)] as const));
