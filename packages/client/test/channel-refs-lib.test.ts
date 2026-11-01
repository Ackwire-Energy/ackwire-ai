import { expect, test } from "bun:test";
import {
  channelOptions,
  channelQuery,
  channelRefsOf,
  insertChannelRef,
  resolveChannelRef,
  splitChannelRefs,
} from "../src/lib/channel-refs";

const eng = { id: "c-eng", name: "eng", isMember: true };
const general = { id: "c-gen", name: "general", isMember: true };
const vendas = { id: "c-ven", name: "vendas", isMember: false };

test("splits #names out of a text, keeping what was typed; never a#b, &#39; or ##", () => {
  expect(splitChannelRefs("veja #Eng.")).toEqual([{ text: "veja " }, { text: "#Eng", name: "eng" }, { text: "." }]);
  expect(splitChannelRefs("a#b &#39; ##dois")).toEqual([{ text: "a#b &#39; ##dois" }]);
  expect(splitChannelRefs("(#infra)")).toEqual([{ text: "(" }, { text: "#infra", name: "infra" }, { text: ")" }]);
});

test("the stored channel wins over the current names; else by name, ignoring case; unknown is null", () => {
  expect(resolveChannelRef("engenharia", { engenharia: "c-eng" }, [eng])).toEqual({ id: "c-eng", known: eng });
  expect(resolveChannelRef("ENG", {}, [eng])).toEqual({ id: "c-eng", known: eng });
  expect(resolveChannelRef("antigo", { antigo: "c-old" }, [eng])).toEqual({ id: "c-old", known: null });
  expect(resolveChannelRef("nada", undefined, [eng])).toBeNull();
});

test("meta.channelRefs: only a map of strings, the same object each time", () => {
  const meta = { channelRefs: { eng: "c-eng" } };
  expect(channelRefsOf(meta)).toBe(meta.channelRefs);
  expect(channelRefsOf({ channelRefs: ["x"] })).toEqual({});
  expect(channelRefsOf({ channelRefs: { eng: 1 } })).toEqual({});
  expect(channelRefsOf(undefined)).toBe(channelRefsOf({}));
});

test("the # picker: query at the caret, names starting with it first, then mine; insert #name + space", () => {
  expect(channelQuery("veja #en", 8)).toEqual({ start: 5, query: "en" });
  expect(channelQuery("a#b", 3)).toBeNull();
  expect(channelOptions("en", [vendas, general, eng]).map((c) => c.name)).toEqual(["eng", "general", "vendas"]);
  expect(channelOptions("", [vendas, general, eng]).map((c) => c.name)).toEqual(["eng", "general", "vendas"]);
  expect(channelOptions("ven", [vendas, general, eng]).map((c) => c.name)).toEqual(["vendas"]);
  expect(insertChannelRef("veja #en agora", { start: 5, query: "en" }, "eng")).toEqual({
    text: "veja #eng agora",
    caret: 10,
  });
});
