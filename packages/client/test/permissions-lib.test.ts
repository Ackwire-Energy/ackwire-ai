import { expect, test } from "bun:test";
import type { OrgRole, Person } from "../src/api/types";
import { addsAgentsTo, managesChannel, setsAutoReply } from "../src/lib/permissions";
import { removesMember } from "../src/lib/roles";

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

test("removing someone from the workspace: someone else, below the viewer, while they manage members", () => {
  const roles = [
    { id: "admin", kind: "custom", position: 0 },
    { id: "devs", kind: "custom", position: 1 },
    { id: "everyone", kind: "everyone", position: 2 },
  ] as OrgRole[];
  const owner = { role: "owner", rank: -1, userId: "ana", permissions: ["manage_members", "manage_owners"] };
  const admin = { role: "member", rank: 0, userId: "bia", permissions: ["manage_members"] };
  const dev = { role: "member", rank: 1, userId: "caio", permissions: ["read"] };
  const person = (userId: string, role: string, roleIds: string[]) => ({ userId, role, roleIds }) as Person;
  const ana = person("ana", "owner", []);
  const bia = person("bia", "member", ["admin"]);
  const davi = person("davi", "member", ["admin"]);
  const caio = person("caio", "member", ["devs"]);
  const eva = person("eva", "member", []);
  // Never themselves: that is leaving.
  expect(removesMember(owner, ana, roles)).toBe(false);
  expect(removesMember(admin, bia, roles)).toBe(false);
  // An owner removes anyone else, another owner too (the server keeps the last one).
  expect(removesMember(owner, person("otto", "owner", []), roles)).toBe(true);
  expect(removesMember(owner, bia, roles)).toBe(true);
  // An admin: only below them, never an owner or a peer.
  expect(removesMember(admin, ana, roles)).toBe(false);
  expect(removesMember(admin, davi, roles)).toBe(false);
  expect(removesMember(admin, caio, roles)).toBe(true);
  expect(removesMember(admin, eva, roles)).toBe(true);
  // Without managing members, nobody.
  expect(removesMember(dev, eva, roles)).toBe(false);
});
