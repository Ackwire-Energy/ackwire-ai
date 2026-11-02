import { expect, test } from "bun:test";
import { addsAgentsTo, editsMemory, managesChannel, setsAutoReply, undoesMemoryChange } from "../src/lib/permissions";

const member = { permissions: ["read", "post"] };
const manager = { permissions: ["read", "post", "manage_channels"] };
const room = { createdByUserId: "bia" };

test("a channel is managed by its creator or who manages channels, no one else", () => {
  expect(managesChannel(room, "bia", member)).toBe(true);
  expect(managesChannel(room, "caio", member)).toBe(false);
  expect(managesChannel(room, "caio", manager)).toBe(true);
  expect(managesChannel(undefined, "caio", manager)).toBe(true);
  expect(managesChannel({ createdByUserId: null }, null, member)).toBe(false);
});

test("an agent's reply mode in a channel: who manages the channel, or the agent's owner", () => {
  const bot = { ownerUserId: "caio" };
  expect(setsAutoReply(room, bot, "caio", member)).toBe(true);
  expect(setsAutoReply(room, bot, "bia", member)).toBe(true);
  expect(setsAutoReply(room, bot, "davi", manager)).toBe(true);
  expect(setsAutoReply(room, bot, "davi", member)).toBe(false);
  expect(setsAutoReply(room, { ownerUserId: null }, null, member)).toBe(false);
  expect(setsAutoReply(room, undefined, "caio", member)).toBe(false);
});

test("an agent goes in or out of a channel its person is in and may post in, or manages", () => {
  const joined = { ...room, isMember: true };
  const other = { ...room, isMember: false };
  expect(addsAgentsTo(joined, "caio", member)).toBe(true);
  expect(addsAgentsTo(joined, "caio", { permissions: ["read"] })).toBe(false);
  expect(addsAgentsTo(other, "caio", member)).toBe(false);
  expect(addsAgentsTo(other, "bia", member)).toBe(true);
  expect(addsAgentsTo(other, "caio", manager)).toBe(true);
  expect(addsAgentsTo(undefined, "caio", member)).toBe(false);
});

test("a memory change is undone by who may edit the memory, or its requester within the window", () => {
  const bot = { ownerUserId: "caio" };
  const reviewer = { permissions: ["read", "review_memory"] };
  const asked = { requestedByUserId: "bia" };
  const now = Date.parse("2026-01-01T12:00:00Z");
  const fresh = "2026-01-01T11:58:00Z";
  const old = "2026-01-01T11:50:00Z";
  expect(editsMemory(bot, "caio", member)).toBe(true);
  expect(editsMemory(bot, "davi", reviewer)).toBe(true);
  expect(editsMemory(bot, "davi", member)).toBe(false);
  expect(undoesMemoryChange(asked, bot, "davi", member, fresh, now)).toBe(false);
  expect(undoesMemoryChange(asked, bot, "bia", member, fresh, now)).toBe(true);
  expect(undoesMemoryChange(asked, bot, "bia", member, undefined, now)).toBe(true);
  expect(undoesMemoryChange(asked, bot, "bia", member, old, now)).toBe(false);
  expect(undoesMemoryChange(asked, bot, "caio", member, old, now)).toBe(true);
  expect(undoesMemoryChange(asked, bot, "davi", reviewer, old, now)).toBe(true);
  expect(undoesMemoryChange({ requestedByUserId: "" }, bot, "", member)).toBe(false);
});
