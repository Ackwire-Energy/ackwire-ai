import { expect, test } from "bun:test";
import { addsAgentsTo, editsMemory, leavesChannel, managesChannel, setsAutoReply } from "../src/lib/permissions";

const member = { permissions: ["read", "post"] };
const manager = { permissions: ["read", "post", "manage_channels"] };
const room = { createdByUserId: "bia", isMember: true };

test("a channel is managed by its creator while in it, or who manages channels, no one else", () => {
  expect(managesChannel(room, "bia", member)).toBe(true);
  expect(managesChannel({ ...room, isMember: false }, "bia", member)).toBe(false);
  expect(managesChannel({ ...room, isMember: false }, "caio", manager)).toBe(true);
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
  expect(addsAgentsTo(other, "bia", member)).toBe(false);
  expect(addsAgentsTo(other, "caio", manager)).toBe(true);
  expect(addsAgentsTo(undefined, "caio", member)).toBe(false);
});

test("an agent's memory is edited by its owner or who reviews memory", () => {
  const bot = { ownerUserId: "caio" };
  const reviewer = { permissions: ["read", "review_memory"] };
  expect(editsMemory(bot, "caio", member)).toBe(true);
  expect(editsMemory(bot, "davi", reviewer)).toBe(true);
  expect(editsMemory(bot, "davi", member)).toBe(false);
});

test("a channel's exceptions (ADR 0134): the list's `can` decides managing when the server sends it", () => {
  const member = { permissions: ["read", "post"] };
  const admin = { permissions: ["read", "post", "manage_channels"] };
  expect(managesChannel({ isMember: true, can: { post: true, callAgents: true, manage: true } }, "u", member)).toBe(
    true,
  );
  expect(managesChannel({ isMember: true, can: { post: true, callAgents: true, manage: false } }, "u", admin)).toBe(
    false,
  );
  expect(managesChannel({ isMember: true }, "u", admin)).toBe(true);
});

test("anyone in a channel may leave it, except #general, where everyone stays", () => {
  expect(leavesChannel({ name: "eng", isMember: true })).toBe(true);
  expect(leavesChannel({ name: "eng", isMember: false })).toBe(false);
  expect(leavesChannel({ name: "general", isMember: true })).toBe(false);
});
