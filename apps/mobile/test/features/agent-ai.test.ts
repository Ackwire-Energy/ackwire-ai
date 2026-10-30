import { describe, expect, test } from "bun:test";
import type { AgentBrain, MachineAccount, PlanUsage } from "@agenteschat/client";
import { planTerms } from "@agenteschat/client/lib/plans";
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

  test("under Responde a todos: a gray area in the plan's terms, and their words for a plan, a seat or a maker", async () => {
    const t = await translator("en");
    expect(planTerms(t, "claude_code", "max")).toEqual({
      line: "A gray area in Claude's terms",
      text: "Claude's terms say your plan is for your own use. Using it to reply to other people might go against them.",
    });
    expect(planTerms(t, "claude_code", "Team").text).toBe(
      "Claude's terms say each seat is for one person. Using yours to reply to other people might go against them.",
    );
    expect(planTerms(t, "codex", null)).toMatchObject({
      line: "A gray area in ChatGPT's terms",
      text: expect.stringContaining("ChatGPT's terms say your plan is for your own use."),
    });
    expect(planTerms(t, "claude_code", "max", "Z.ai")).toEqual({
      line: "A gray area in the plan's terms",
      text: "Z.ai says the plan is for its subscriber only. Using yours to reply to other people might go against its terms.",
    });
    const pt = await translator("pt-BR");
    expect(planTerms(pt, "claude_code", null).line).toBe("Zona cinzenta nos termos do Claude");
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
    // One switch, its line under it with the ⓘ, the plan's words behind it.
    expect(parts).toContain('label={t("aiAccounts.share.switch")}');
    expect(parts).toContain("planTerms(t, brain, plan, maker)");
    expect(parts).toMatch(/<InfoHint name=\{t\("common\.about", \{ label: terms\.line \}\)\} text=\{terms\.text\}/);
    // Someone who isn't the plan's owner: whom it replies to and who decides, no switch.
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
