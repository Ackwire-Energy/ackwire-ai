import { describe, expect, test } from "bun:test";
import { endsWithSentinel, isSentinelOnly, replyPolicyFor, stripSentinel, visibleText } from "../src/reply-policy";

const run = (over: Partial<{ trigger: "mention" | "router" | "dm" | "forum"; background: boolean }> = {}) => ({
  agentId: "a1",
  trigger: "router" as const,
  background: false,
  ...over,
});
const person = (meta: Record<string, unknown> = {}) => ({ authorType: "person" as const, meta });

describe("replyPolicyFor", () => {
  test("only runs nobody called by name may pass", () => {
    expect(replyPolicyFor(run(), person())).toEqual({ mayPass: true, background: false });
    // Brought in after another agent spoke (`meta.joined`).
    expect(replyPolicyFor(run(), { authorType: "agent", meta: {} }).mayPass).toBe(true);
    for (const trigger of ["mention", "dm", "forum"] as const)
      expect(replyPolicyFor(run({ trigger }), person()).mayPass).toBe(false);
  });

  test("never a quote reply to it, a follow-up, a routine's call or a run a person answered", () => {
    expect(replyPolicyFor(run(), person({ replyTo: { author: { type: "agent", id: "a1" } } })).mayPass).toBe(false);
    // Quoting another agent: still brought in.
    expect(replyPolicyFor(run(), person({ replyTo: { author: { type: "agent", id: "a2" } } })).mayPass).toBe(true);
    expect(replyPolicyFor(run(), person(), { followUp: true }).mayPass).toBe(false);
    expect(replyPolicyFor(run(), person({ routine: { id: "r", name: "x" } })).mayPass).toBe(false);
    expect(replyPolicyFor(run(), person(), { answerOwed: true }).mayPass).toBe(false);
  });

  test("background runs never post their answer", () => {
    expect(replyPolicyFor(run({ trigger: "mention", background: true }), person())).toEqual({
      mayPass: false,
      background: true,
    });
  });
});

describe("the sentinel", () => {
  test("alone, in any wrapping, is sentinel-only", () => {
    for (const t of [
      "NO_REPLY",
      " NO_REPLY. ",
      "**NO_REPLY**",
      "`NO_REPLY`",
      "no_reply",
      "NO-REPLY",
      "NOREPLY",
      "[NO_REPLY]",
      '"NO_REPLY"',
      "NO REPLY",
      "\n\nNO_REPLY\n",
      "NO_REPLY\nNO_REPLY",
      "NO",
      "NO_RE",
    ])
      expect(isSentinelOnly(t)).toBe(true);
  });

  test("real answers are never the sentinel", () => {
    for (const t of ["", "  ", "No reply.", "No", "no", "Não.", "Sem NO_REPLY_COUNT aqui", "NOW"])
      expect(isSentinelOnly(t)).toBe(false);
  });

  test("stripped anywhere on its own line, or glued to the start or end of real text", () => {
    expect(stripSentinel("Nada novo.\n\nNO_REPLY")).toBe("Nada novo.");
    expect(stripSentinel("NO_REPLY\n\nNovidade: 3 avaliações.")).toBe("Novidade: 3 avaliações.");
    expect(stripSentinel("Primeiro.\n`NO_REPLY`\nSegundo.")).toBe("Primeiro.\nSegundo.");
    expect(stripSentinel("NO_REPLY Claro, aqui está.")).toBe("Claro, aqui está.");
    expect(stripSentinel("NO_REPLYClaro.")).toBe("Claro.");
    expect(stripSentinel("Feito. NO_REPLY")).toBe("Feito.");
    expect(stripSentinel("Feito.NO_REPLY")).toBe("Feito.");
    expect(stripSentinel("Feito. **NO_REPLY**")).toBe("Feito.");
    // Part of an identifier, or another word: left alone.
    expect(stripSentinel("A flag SEND_NO_REPLY está ligada.")).toBe("A flag SEND_NO_REPLY está ligada.");
    expect(stripSentinel("NO_REPLY_COUNT é 3")).toBe("NO_REPLY_COUNT é 3");
    expect(stripSentinel("No reply from the client yet.")).toBe("No reply from the client yet.");
    expect(stripSentinel("NO")).toBe("");
  });

  test("endsWithSentinel: the model meant silence (alone, or closing a note)", () => {
    expect(endsWithSentinel("NO_REPLY")).toBe(true);
    expect(endsWithSentinel("Nada novo desde ontem.\n\nNO_REPLY")).toBe(true);
    expect(endsWithSentinel("Nada novo. NO_REPLY")).toBe(true);
    expect(endsWithSentinel("NO_REPLY\n\nNovidade: 3 avaliações.")).toBe(false);
    expect(endsWithSentinel("Novidade.")).toBe(false);
  });

  test("streaming: held while it could still be the word, never shown, and what was shown only grows", () => {
    const stream = (chunks: string[]) => {
      let all = "";
      let shown = "";
      const seen: string[] = [];
      for (const c of chunks) {
        all += c;
        const v = visibleText(all, false);
        expect(v.startsWith(shown)).toBe(true);
        shown = v;
        seen.push(v);
      }
      const end = visibleText(all, true);
      if (end.startsWith(shown)) shown = end;
      return { shown, seen };
    };
    for (const chunks of [
      ["NO", "_REP", "LY"],
      ["**NO_", "REPLY**", "."],
      ["N", "O"],
    ]) {
      const { shown, seen } = stream(chunks);
      expect(shown.trim()).toBe("");
      for (const s of seen) expect(s).not.toContain("NO");
    }
    const glued = stream(["NO_REP", "LY Claro", ", aqui."]);
    expect(glued.shown).toBe("Claro, aqui.");
    const closing = stream(["Nada ", "novo.\n\n", "NO_R", "EPLY"]);
    expect(closing.shown.trim()).toBe("Nada novo.");
    for (const s of closing.seen) expect(s).not.toContain("NO");
    const suffix = stream(["Feito. ", "NO_", "REPLY"]);
    expect(suffix.shown.trim()).toBe("Feito.");
    for (const s of suffix.seen) expect(s).not.toContain("NO");
    // Ordinary text streams at once (a word that only starts like it is shown as soon as it isn't).
    const plain = stream(["Os builds ", "rodam no ", "GitHub Actions."]);
    expect(plain.seen).toEqual(["Os builds ", "Os builds rodam no ", "Os builds rodam no GitHub Actions."]);
    expect(stream(["NOW ", "is fine"]).shown).toBe("NOW is fine");
  });
});
