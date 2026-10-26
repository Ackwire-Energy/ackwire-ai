import { describe, expect, test } from "bun:test";
import type { AgentBrainLine } from "@agenteschat/client";
import { brainLine } from "@agenteschat/client/lib/brain";
import { resources } from "@agenteschat/i18n";
import { markOf, PROVIDER_MARKS } from "@agenteschat/ui/brand/marks";
import i18next, { type TFunction } from "i18next";
import { featureKeysEn } from "../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../src/features/i18n/keys.pt-BR";
import { withMobileKeys } from "../src/i18n/merge";
import { LOGO_SIZES, MARK_GRADIENT, markShapes, STACK_RING, stackChips } from "../src/ui/provider-marks";

async function translator(lng: "pt-BR" | "en"): Promise<TFunction> {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng,
    fallbackLng: "pt-BR",
    resources: withMobileKeys(resources, { "pt-BR": featureKeysPtBR, en: featureKeysEn }),
    interpolation: { escapeValue: false },
  });
  return i18n.t;
}

/** What the phone's ProviderLogo draws for a brain line: the mark's id, or null (no logo). */
const drawn = (line: { mark: string | null }) => (line.mark ? markOf(line.mark) : null);

describe("Pensa com: the brain by its maker's mark", () => {
  test("each computer brain or plan account draws its maker's mark; the API draws none", async () => {
    const t = await translator("pt-BR");
    const line = (brain: AgentBrainLine) => brainLine(t, brain, "Claude Sonnet 5.5");
    expect(drawn(line({ kind: "claude_code", model: "Sonnet" }))).toBe("claude");
    expect(drawn(line({ kind: "codex", model: "GPT-6 Sol" }))).toBe("openai");
    expect(drawn(line({ kind: "claude_code", model: "GLM-5.3", provider: "zai" }))).toBe("zai");
    expect(drawn(line({ kind: "claude_code", model: "Kimi K3", provider: "kimi" }))).toBe("kimi");
    expect(line({ kind: "model", model: null })).toEqual({ text: "Claude Sonnet 5.5", kind: "agent", mark: null });
    // A plan this phone has no mark for yet still shows (its initial), never another maker's mark.
    expect(line({ kind: "claude_code", model: "x", provider: "newplan" }).mark).toBe("newplan");
    expect(markOf("newplan")).toBeNull();
    // The waiting card and the switch sheet name the brains by the same marks.
    expect(markOf("claude_code")).toBe("claude");
    expect(markOf("codex")).toBe("openai");
    for (const id of Object.keys(PROVIDER_MARKS)) expect(markOf(id)).toBe(id as keyof typeof PROVIDER_MARKS);
  });

  test("the owner and admins also read where it runs; everyone else, the brain and its model", async () => {
    const pt = await translator("pt-BR");
    const en = await translator("en");
    // The server sends `computer` only to the agent's owner and the admins.
    const owner: AgentBrainLine = { kind: "claude_code", model: "Sonnet", computer: "MacBook do Walter" };
    const others: AgentBrainLine = { kind: "claude_code", model: "Sonnet" };
    expect(brainLine(pt, owner, "").text).toBe("Claude Code · Sonnet no MacBook do Walter");
    expect(brainLine(pt, others, "").text).toBe("Claude Code · Sonnet");
    expect(brainLine(en, owner, "").text).toBe("Claude Code · Sonnet on MacBook do Walter");
    expect(brainLine(pt, { kind: "codex", model: "auto" }, "").text).toBe("Codex · Automático");
    expect(pt("mobile.intentAgents.thinks")).toBe("Pensa com");
    expect(en("mobile.intentAgents.thinks")).toBe("Thinks with");
  });
});

describe("the marks as the phone draws them", () => {
  const INK = "#1c1c1e";

  test("in the maker's own colors: a second color as its own shape, the gradient, the dark files' parts", () => {
    // Claude for the `anthropic` provider, in Clay.
    expect(markShapes("anthropic", "light", INK)).toEqual({
      key: "claude",
      gradient: null,
      shapes: [{ d: PROVIDER_MARKS.claude.path, fill: "#D97757" }],
    });
    // Kimi's K in ink, its dot always blue.
    expect(markShapes("moonshot", "dark", INK)?.shapes.map((s) => s.fill)).toEqual([INK, "#1783FF"]);
    // OpenCode's block is darker on a dark theme, as in its own dark file.
    expect(markShapes("opencode", "light", INK)?.shapes.map((s) => s.fill)).toEqual([INK, "#CFCECD"]);
    expect(markShapes("opencode", "dark", INK)?.shapes.map((s) => s.fill)).toEqual([INK, "#4B4646"]);
    // MiniMax: its gradient, never a flat color.
    const minimax = markShapes("minimax", "light", INK);
    expect(minimax?.gradient).toEqual(["#E21680", "#FF633A"]);
    expect(minimax?.shapes[0]?.fill).toBe(`url(#${MARK_GRADIENT})`);
    // A one-color mark takes the ink it is given, with no color of its own.
    expect(markShapes("codex", "light", INK)?.shapes).toEqual([{ d: PROVIDER_MARKS.openai.path, fill: INK }]);
    expect(markShapes("newplan", "light", INK)).toBeNull();
  });

  test("a stack: 20 pt chips with a 12 pt mark, in the order given, each over the one before", () => {
    const [chip, mark] = LOGO_SIZES.chip;
    expect([chip, mark]).toEqual([20, 12]);
    const chips = stackChips(["claude_code", "codex", "zai", "kimi"]);
    expect(chips.map((c) => markOf(c.id))).toEqual(["claude", "openai", "zai", "kimi"]);
    expect(chips.map((c) => c.marginLeft)).toEqual([0, -2, -2, -2]);
    // The next chip and its ring cover only the space around a mark, never the mark itself.
    for (const c of chips.slice(1)) expect(-c.marginLeft + STACK_RING).toBeLessThanOrEqual((chip - mark) / 2);
  });
});
