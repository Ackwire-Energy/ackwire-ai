import { describe, expect, test } from "bun:test";
import type { AgentBrain, MachineAccount, PlanUsage } from "@agenteschat/client";
import { planOf, planReplies } from "@agenteschat/client/lib/plans";
import type { TFunction } from "i18next";
import { accountKindOf, agentAccounts, takenFrom, thinkingUsage } from "../../src/features/ai/logic";
import { translator } from "./fixtures";

const usage = (used: number): PlanUsage => ({
  windows: [{ kind: "five_hour", usedPercent: used }],
  source: "turn",
  at: "2026-10-27T12:00:00.000Z",
});

const account = (id: string, over: Partial<MachineAccount> = {}): MachineAccount => ({
  id,
  kind: "claude_code",
  label: id,
  email: null,
  plan: "max",
  status: "active",
  ownerId: "u1",
  ownerName: "Walter Nogueira",
  mine: true,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
  ...over,
});

type View = Pick<AgentBrain, "accounts" | "account" | "ownSignIn" | "ownUsage">;

describe("the agent's AI", () => {
  test("only a plan brain has accounts to pick", () => {
    expect(accountKindOf("claude_code")).toBe("claude_code");
    expect(accountKindOf("codex")).toBe("codex");
    expect(accountKindOf("model")).toBeNull();
    expect(accountKindOf(undefined)).toBeNull();
  });

  test("its page lists the viewer's own accounts of that kind, and someone else's only while it's this agent's", () => {
    const view: View = {
      account: "theirs-now",
      ownSignIn: false,
      ownUsage: {},
      accounts: [
        account("mine"),
        account("codex", { kind: "codex" }),
        account("theirs", { mine: false }),
        account("theirs-now", { mine: false }),
      ],
    };
    expect(agentAccounts(view, "claude_code").map((a) => a.id)).toEqual(["mine", "theirs-now"]);
    expect(agentAccounts(view, "codex").map((a) => a.id)).toEqual(["codex"]);
  });

  test("the usage shown is its account's, or the computer's own sign-in's only where that thinks for it", () => {
    const base: View = { account: "a1", ownSignIn: true, ownUsage: { claude_code: usage(40) }, accounts: [] };
    expect(thinkingUsage({ ...base, accounts: [account("a1", { usage: usage(90) })] }, "claude_code")).toEqual(
      usage(90),
    );
    expect(thinkingUsage({ ...base, accounts: [account("a1")] }, "claude_code")).toBeUndefined();
    expect(thinkingUsage({ ...base, account: null }, "claude_code")).toEqual(usage(40));
    expect(thinkingUsage({ ...base, account: null, ownSignIn: false }, "claude_code")).toBeUndefined();
    expect(thinkingUsage({ ...base, account: null }, "codex")).toBeUndefined();
  });

  test("picking an account another agent thinks with takes it from that one", () => {
    expect(takenFrom(account("a", { usedBy: ["Infra"] }), "Dev")).toEqual(["Infra"]);
    expect(takenFrom(account("a", { usedBy: ["Dev"] }), "Dev")).toEqual([]);
  });

  test("the line under Atende outras pessoas follows the switch: its key by state, for one agent or all of them", () => {
    const keyOf = ((key: string) => key) as unknown as TFunction;
    const line = (on: boolean, agent: string | null) => planReplies(keyOf, { on, agent, brain: "claude_code" }).line;
    expect([line(false, "Ada"), line(true, "Ada"), line(false, null), line(true, null)]).toEqual([
      "aiAccounts.share.line.off",
      "aiAccounts.share.line.on",
      "aiAccounts.share.line.offAll",
      "aiAccounts.share.line.onAll",
    ]);
  });

  test("its words: whom the agent answers in each state and on which plan, the plan's terms behind the ⓘ", async () => {
    const en = await translator("en");
    const pt = await translator("pt-BR");
    const says = (t: TFunction, on: boolean, over: Partial<Parameters<typeof planReplies>[1]> = {}) =>
      planReplies(t, { on, agent: "Ada", brain: "claude_code", plan: "max", ...over });
    expect(says(en, false)).toEqual({
      line: "Ada answers only you, on your Claude plan.",
      about: "About the plan's terms",
      text: "Claude plans are for personal use. Letting other people use yours is a gray area in Claude's terms.",
    });
    expect(says(en, true).line).toBe("Ada answers anyone who can talk to her, on your Claude plan.");
    expect(says(pt, false)).toEqual({
      line: "A Ada só atende você, pelo seu plano do Claude.",
      about: "Sobre os termos do plano",
      text: "Os planos do Claude são para uso pessoal. Deixar outras pessoas usarem o seu é uma zona cinzenta nos termos do Claude.",
    });
    expect(says(pt, true).line).toBe("A Ada atende quem pode falar com ela, pelo seu plano do Claude.");
    expect(says(pt, true, { agent: "Theo" }).line).toBe(
      "O Theo atende quem pode falar com ele, pelo seu plano do Claude.",
    );
    // Every agent of a plan's panel.
    expect([false, true].map((on) => says(en, on, { agent: null }).line)).toEqual([
      "They answer only you, on your Claude plan.",
      "They answer anyone who can talk to them, on your Claude plan.",
    ]);
    expect([false, true].map((on) => says(pt, on, { agent: null }).line)).toEqual([
      "Só atendem você, pelo seu plano do Claude.",
      "Atendem quem pode falar com eles, pelo seu plano do Claude.",
    ]);
    // ChatGPT's plan, a seat, a coding plan by its name in its maker's words.
    expect(says(en, false, { brain: "codex", plan: null }).line).toBe("Ada answers only you, on your ChatGPT plan.");
    expect(says(en, false, { plan: "Team" })).toMatchObject({
      line: "Ada answers only you, on your Claude seat.",
      text: "Each Claude seat is for one person. Letting other people use yours is a gray area in Claude's terms.",
    });
    expect(says(pt, false, { plan: "team" }).line).toBe("A Ada só atende você, pelo seu assento do Claude.");
    const glm = planOf("zai");
    expect(says(en, true, { coding: glm })).toMatchObject({
      line: "Ada answers anyone who can talk to her, on your GLM Coding plan.",
      text: "Z.ai says the plan is for its subscriber only. Letting other people use yours is a gray area in Z.ai's terms.",
    });
    expect(says(pt, false, { coding: glm }).line).toBe("A Ada só atende você, pelo seu plano GLM Coding.");
    // The phone's header over it.
    expect([en("mobile.ai.audience", { she: "she" }), pt("mobile.ai.audience", { she: "ela" })]).toEqual([
      "Who she answers",
      "Quem ela atende",
    ]);
  });

  test("the agent's AI and a plan's page draw the same switch, line and ⓘ, and nothing asks to accept the terms", async () => {
    // The screens are components the tests can't render: what they wire in, as text.
    const read = (file: string) => Bun.file(new URL(`../../src/features/ai/${file}`, import.meta.url).pathname).text();
    const [screen, connect, parts] = await Promise.all([
      read("AgentAiScreen.tsx"),
      read("ConnectAiSteps.tsx"),
      read("parts.tsx"),
    ]);
    for (const source of [screen, connect]) {
      expect(source).toMatch(/import \{[^}]*\bPlanReplies\b[^}]*\} from "\.\/parts"/);
      expect(source).toContain("<PlanReplies");
      expect(source).not.toMatch(/acceptPlanTerms|share\.title|share\.accept|connectAi\.onlyYou|own\.note/);
    }
    // One switch, its line under it saying what its state does, with the ⓘ, the plan's words behind it.
    expect(parts).toContain('label={t("aiAccounts.share.switch")}');
    expect(parts).toContain("planReplies(t, { on, agent, brain, plan, coding })");
    expect(parts).toMatch(
      /<InfoHint\s+name=\{t\("common\.about", \{ label: t\("aiAccounts\.share\.terms\.about"\) \}\)\}\s+text=\{says\.text\}[^>]*>\s*<Text[^>]*>\s*\{says\.line\}/,
    );
    // The line names the agent.
    expect(screen).toMatch(/<PlanReplies\s+agent=\{name\}/);
    expect(connect).toMatch(/<PlanReplies\s+agent=\{done\?\.agent \?\? agent\?\.name \?\? ""\}/);
    // Someone who isn't the plan's owner: whom it answers and who decides, no switch.
    expect(screen).toMatch(/view\.canUsePlans \? \(\s*<PlanReplies[\s\S]*?\) : \(\s*<PlanRepliesOf/);
    // On a plan's page: under its steps or the account cards, and on the page that says it's done.
    expect(connect).toContain("{steps || ownable ? repliesRow : null}");
    expect(connect).toContain("<View style={styles.doneReplies}>{repliesRow}</View>");
    // Both say the plan of what the agent thinks with, the computer's own sign-in's included (`signInPlan`).
    expect(screen).toContain("plan={signInPlan(view, row, kind)}");
    expect(connect).toContain("signInPlan(view, gates.row, kind)");
    expect(connect).toContain("plan={replies.plan}");
  });

  test("Claude's sign-in asks for no address: Claude's page picks the account, an account already there is offered", async () => {
    // The flow is a component the tests can't render: what it wires in, as text.
    const flow = await Bun.file(new URL("../../src/features/ai/AddAccount.tsx", import.meta.url).pathname).text();
    expect(flow).not.toMatch(/TextInput|emailAddress|aiAccounts\.add\.email/);
    // The hint (the account's own email, signing in again) goes through the shared start the client tests pin.
    expect(flow).toMatch(/beginLogin\(\s*\(input\) => api\.machines\.beginAccountLogin\(/);
    expect(flow).toMatch(/\{\s*again,\s*provider,\s*hint,\s*\}/);
    expect(flow).toContain("freeDuplicate(result)");
    expect(flow).toContain('t("connectAi.useAnyway"');
    // "Usar" only where an agent is in view (`onUse`); signing in again as someone else says both addresses.
    expect(flow).toContain("onPress={() => onUse(reuse)}");
    expect(flow).toContain("const otherEmail = other?.email ?? (hint ? result?.signedInAs : undefined);");
    expect(flow).toMatch(/otherEmail\s*\?\s*t\(`connectAi\.otherAccount\.\$\{kind\}`/);
    // A new login that comes back as another account than its hint never thinks by itself: Usar or Tentar de novo.
    expect(flow).toMatch(/if \(otherThanHint\(hint, result\.account\)\) setOther\(result\.account\);\s+else onAdded/);
    expect(flow).toContain("onPress={() => onAdded(other)}");
    expect(flow).toMatch(/if \(other && !again\) void api\.machines\.removeAccount\(orgId, machineId, other\.id\)/);
    const t = await translator("pt-BR");
    expect(t("agentPage.work.brain.add.duplicate.claude_code", { account: "ana@acme.com" })).toBe(
      "O Claude entrou como ana@acme.com, uma conta que você já conectou. Para usar outra, saia na página do Claude e tente de novo.",
    );
    expect(t("connectAi.otherAccount.claude_code", { email: "walt@gmail.com", account: "walt@acme.com" })).toBe(
      "O Claude entrou como walt@gmail.com, não como walt@acme.com. Saia na página do Claude e tente de novo.",
    );
    expect(t("connectAi.own.one", { for: "para a", name: "Ada" })).toBe("Uma conta só para a Ada");
    expect(t("connectAi.own.shared")).toBe("A conta que os seus agentes dividem");
  });

  test("signing in again sends the account's own email as the hint, from Settings and from Connect an AI", async () => {
    const read = (file: string) => Bun.file(new URL(`../../src/features/ai/${file}`, import.meta.url).pathname).text();
    const settings = await read("AiAccountsScreen.tsx");
    const connect = await read("ConnectAiSteps.tsx");
    expect(settings).toMatch(/again=\{again\.id\}\s+email=\{again\.email\}/);
    expect(connect).toMatch(/again=\{signedOut\?\.id\}\s+email=\{email \?\? signedOut\?\.email\}/);
    // One more login of another agent's account (`email`) is never the agent's own signed-out login again.
    expect(connect).toContain('const signedOut = !email && current?.status === "signed_out" ? current : undefined;');
    // An account already connected thinks for an agent only where one is in view: Connect an AI, never Settings.
    expect(connect).toContain("onUse={(a) => void assign(a)}");
    expect(settings).not.toContain("onUse=");
  });

  test("Claude's code goes by itself however it lands in the field; anything else waits for Enviar, with a line", async () => {
    // The flow and its field are components the tests can't render: what they wire in, as text.
    const read = (file: string) => Bun.file(new URL(`../../src/features/ai/${file}`, import.meta.url).pathname).text();
    const [flow, parts] = await Promise.all([read("AddAccount.tsx"), read("parts.tsx")]);
    // Typed, pasted with the keyboard or by Colar: one path, and only this sign-in's code sends with no tap.
    expect(flow).toMatch(
      /const take = \(text: string\) => \{[^}]*if \(!plan && login && isSignInCode\(text, login\.url\)\) void send\(text\);/,
    );
    expect(flow).toContain("onChangeText={take}");
    expect(flow).toContain("onPasted={take}");
    expect(flow).toMatch(
      /key && !isSignInCode\(key, login\.url\) \? \(\s*<Note icon="x">\{t\("agentPage\.work\.brain\.add\.notCode"\)\}<\/Note>/,
    );
    // Colar only while the field is empty, the text's edge then the same on both sides.
    expect(parts).toMatch(/const empty = !value\.trim\(\);/);
    expect(parts).toMatch(/\{empty \? \(\s*<View style=\{styles\.insetAction\}>/);
    expect(parts).toContain("!empty && styles.insetFull");
    const t = await translator("pt-BR");
    expect(t("agentPage.work.brain.add.notCode")).toBe("Isso não parece o código do Claude.");
  });

  test("an account other agents think with, where it may have a login per agent: one row, signed in again for this one", async () => {
    const read = (file: string) => Bun.file(new URL(`../../src/features/ai/${file}`, import.meta.url).pathname).text();
    const [screen, sheet, connect] = await Promise.all([
      read("AgentAiScreen.tsx"),
      read("ConnectAi.tsx"),
      read("ConnectAiSteps.tsx"),
    ]);
    // One row per account (the web's choice), and "Também usada por" signs this agent in on Connect an AI.
    expect(screen).toContain("accountChoices(accounts, [view.account]).map(({ login: a, usedBy, also })");
    expect(screen).toMatch(
      /also\s*\?\s*t\("agentPage\.work\.brain\.accountAlso", \{ agents: joinNames\(usedBy, t\("newAgent\.and"\)\) \}\)/,
    );
    expect(screen).toContain("onPress={() => (also ? connect(a, true) : choose(a))}");
    // That account's email goes along as Claude's hint, on Claude's page only, whatever the agent's own login is.
    expect(screen).toContain("...(also && a?.email ? { email: a.email } : {}),");
    expect(sheet).toContain("{...(params.email ? { email: params.email } : {})}");
    expect(connect).toContain('{...(choice === "claude" && props.email ? { email: props.email } : {})}');
    const t = await translator("pt-BR");
    expect(t("agentPage.work.brain.accountAlso", { agents: "Theo e Lia" })).toBe("Também usada por Theo e Lia");
  });

  test("a card whose plan's sign-in ended: the agent says so, and Entrar de novo opens on its own plan", async () => {
    const read = (file: string) => Bun.file(new URL(`../../src/features/ai/${file}`, import.meta.url).pathname).text();
    const [card, sheet] = await Promise.all([read("NoAiCard.tsx"), read("ConnectAi.tsx")]);
    expect(card).toContain('t(card.signedOut ? "noAi.signedOut" : "noAi.agent", agentGrammar(t, name))');
    // The plan the client tests pin (`signInAgainPlan`): ChatGPT for a Codex agent, never Claude's page.
    expect(card).toContain("const again = signInAgainPlan(card, agent);");
    expect(card).toContain('t(again ? "agentPage.work.brain.signInAgain" : "noAi.action")');
    expect(card).toContain("...(again ? { plan: again } : {}),");
    expect(sheet).toContain("PLAN_CHOICES.find((c) => c === params.plan) ?? choiceOfIntent(");
    const t = await translator("pt-BR");
    expect(t("noAi.signedOut", { name: "Ada", hers: "dela" })).toBe(
      "Ada não vai responder porque a IA dela saiu da\u00a0conta.",
    );
  });

  test("on the Cloud the account's sign-in says the computer, never its name; its being ready is a card of its own", async () => {
    const connect = await Bun.file(
      new URL("../../src/features/ai/ConnectAiSteps.tsx", import.meta.url).pathname,
    ).text();
    expect(connect).toMatch(/computer=\{edition === "cloud" \? t\("connectAi\.theComputer"\) : computer\}/);
    // Where the wait's card was: never read as the head of the account choice under it.
    expect(connect).toMatch(/<InfoCard icon="check" live>\s*\{t\("connectAi\.wait\.ready"\)\}/);
    const said = {
      "pt-BR": [
        "Enviar ao computador",
        "Pedindo ao computador…",
        "Código enviado. O computador está terminando de entrar.",
        "O computador não respondeu. Tente de novo em instantes.",
      ],
      en: [
        "Send to the computer",
        "Asking the computer…",
        "Code sent. Finishing the sign-in on the computer.",
        "No answer from the computer. Try again in a moment.",
      ],
    };
    for (const lang of ["pt-BR", "en"] as const) {
      const t = await translator(lang);
      const computer = t("connectAi.theComputer");
      expect(
        ["send", "starting", "sent", "startFailed"].map((k) => t(`agentPage.work.brain.add.${k}`, { computer })),
      ).toEqual(said[lang]);
    }
  });
});
