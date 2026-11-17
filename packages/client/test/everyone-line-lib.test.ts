import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next from "i18next";
import { everyoneLineOf } from "../src/lib/routing";
import type { ReceiptView } from "../src/realtime/receipts";

const pt = (() => {
  const i = i18next.createInstance();
  void i.init({ lng: "pt-BR", resources, initAsync: false, interpolation: { escapeValue: false } });
  return i.t;
})();
const names = { agent: (id: string) => ({ a: "Ada", b: "Bruno", c: "Clara" })[id] ?? id };
const view = (over: Partial<ReceiptView> = {}): ReceiptView => ({
  seen: ["a", "b", "c"],
  status: { kind: "claimed", agents: ["a"] },
  done: false,
  referenced: ["b", "c"],
  ...over,
});

describe("the line under a mention of everyone", () => {
  test("one answered for all: who saw it, who answers, then that it answered; its face first", () => {
    const shape = { everyoneShape: { answer: "one", by: "a" } };
    expect(everyoneLineOf(pt, shape, view({ seen: ["b", "a", "c"] }), names)).toEqual({
      text: "3 agentes viram · Ada responde por todos",
      hint: "Uma resposta servia para todos, então só Ada respondeu. Os outros agentes leram a mensagem.",
      faces: ["a", "b", "c"],
    });
    const done = view({ status: { kind: "handled", agents: ["a"] }, done: true });
    expect(everyoneLineOf(pt, shape, done, names)?.text).toBe("3 agentes viram · Ada respondeu por todos");
  });

  test("none: only who saw it; each, any other message, or one agent alone: no line", () => {
    expect(everyoneLineOf(pt, { everyoneShape: { answer: "none" } }, view({ status: null }), names)?.text).toBe(
      "3 agentes viram",
    );
    expect(everyoneLineOf(pt, { everyoneShape: { answer: "each" } }, view(), names)).toBeNull();
    expect(everyoneLineOf(pt, {}, view(), names)).toBeNull();
    expect(everyoneLineOf(pt, { everyoneShape: { answer: "none" } }, view({ seen: ["a"] }), names)).toBeNull();
  });
});
