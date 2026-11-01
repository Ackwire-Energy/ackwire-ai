import { describe, expect, test } from "bun:test";
import type { Me } from "@agenteschat/client";
import {
  dayLabel,
  formatInt,
  formatPercent,
  formatTokensShort,
  formatUsd,
  joinNames,
  relativeTime,
  shortModel,
  timeLeft,
  whenAt,
} from "@agenteschat/client/lib/format";
import { agentGrammar, isFeminineName, providerGrammar, runErrorGrammar } from "@agenteschat/client/lib/grammar";
import {
  earlyAccessHeaders,
  earlyAccessState,
  INVITATION_MAIL_HEADER,
  INVITATION_TOKEN_HEADER,
  landingFor,
  membershipIn,
  safeRedirect,
  settingUp,
  webUrl,
} from "@agenteschat/client/lib/guards";
import {
  addInvites,
  aheadOf,
  crewOf,
  firstAskOrder,
  ONBOARDING_STEPS,
  stepIndex,
  validInvites,
} from "@agenteschat/client/lib/onboarding";
import { can } from "@agenteschat/client/lib/permissions";
import {
  addressesIn,
  emailsFrom,
  handleFrom,
  isEmail,
  parseAmount,
  passwordState,
  slugify,
} from "@agenteschat/client/lib/text";
import { en, ptBR } from "@agenteschat/i18n";
import type { TFunction } from "i18next";
import { createBetterAuthClient } from "@/auth/better-auth";
import { createI18n } from "@/i18n";
import { announceConfirmation, emailConfirmedToast } from "@/lib/email-confirmation";
import type { ToastAction } from "@/lib/toast";
import { createFakeAuth } from "./fake-auth";

const i18n = createI18n("pt-BR");
const t = i18n.t.bind(i18n) as TFunction;
const now = new Date(2026, 9, 14, 10, 44);
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

describe("format (pt-BR, machine numbers precise)", () => {
  test("money", () => {
    expect(formatUsd(t, "pt-BR", 12.3)).toBe("US$ 12,30");
    expect(formatUsd(t, "pt-BR", 0.004)).toBe("US$ 0,004");
    expect(formatUsd(t, "pt-BR", 0.0003)).toBe("US$ 0,0003");
    // A real spend too small for 4 decimals (a few thousand tokens of a cheap model) never reads as zero.
    expect(formatUsd(t, "pt-BR", 0.00003)).toBe("<US$ 0,0001");
    expect(formatUsd(t, "pt-BR", 0.00005)).toBe("US$ 0,0001");
    expect(formatUsd(t, "pt-BR", 0)).toBe("US$ 0,00");
    expect(formatUsd(t, "pt-BR", 1234.5)).toBe("US$ 1.234,50");
    // Budget use: whole percents from 10%, one decimal below, "<1%" for a tiny share.
    expect(formatPercent("pt-BR", 30.8)).toBe("31%");
    expect(formatPercent("pt-BR", 2.5)).toBe("2,5%");
    expect(formatPercent("pt-BR", 0)).toBe("0%");
    expect(formatPercent("pt-BR", 0.006)).toBe("<1%");
    expect(formatPercent("en", 120)).toBe("120%");
  });
  test("tokens", () => {
    expect(formatInt("pt-BR", 1240)).toBe("1.240");
    expect(formatTokensShort(t, "pt-BR", 3_100_000)).toBe("3,1 mi");
    expect(formatTokensShort(t, "pt-BR", 940)).toBe("940");
  });
  test("relative times", () => {
    expect(relativeTime(t, "pt-BR", at(0.2), now)).toBe("agora");
    expect(relativeTime(t, "pt-BR", at(2), now)).toBe("há 2 min");
    expect(relativeTime(t, "pt-BR", at(180), now)).toBe("há 3 h");
    expect(relativeTime(t, "pt-BR", at(24 * 60), now)).toBe("ontem");
    expect(dayLabel(t, "pt-BR", at(5), now)).toBe("Hoje");
    expect(dayLabel(t, "pt-BR", at(24 * 60), now)).toBe("Ontem");
    expect(whenAt(t, "pt-BR", at(1), now)).toBe("hoje 10:43");
  });
  test("time left", () => {
    expect(timeLeft(t, new Date(now.getTime() + 23 * 3_600_000).toISOString(), now)).toBe("23 h");
    expect(timeLeft(t, new Date(now.getTime() + 5 * 86_400_000).toISOString(), now)).toBe("5 dias");
    expect(timeLeft(t, at(1), now)).toBeNull();
  });
  test("names and models", () => {
    expect(joinNames(["Ada"], " e ")).toBe("Ada");
    expect(joinNames(["Ada", "Atlas"], " e ")).toBe("Ada e Atlas");
    expect(joinNames(["Ada", "Atlas", "Theo"], " e ")).toBe("Ada, Atlas e Theo");
    expect(shortModel("Claude Sonnet 5.5")).toBe("sonnet 5.5");
  });
});

describe("text", () => {
  test("slug and handle", () => {
    expect(slugify("Acme Saúde")).toBe("acme-saude");
    expect(handleFrom("Íris")).toBe("iris");
    expect(handleFrom("A")).toBe("a0");
  });
  test("emails", () => {
    expect(isEmail("nome@empresa.com.br")).toBe(true);
    expect(isEmail("nome@empresa")).toBe(false);
    expect(emailsFrom("A@x.com, b@x.com ,bad, a@x.com")).toEqual({ valid: ["a@x.com", "b@x.com"], invalid: ["bad"] });
    expect(emailsFrom("a@x.com, c@x.com", ["A@x.com"])).toEqual({ valid: ["c@x.com"], invalid: [] });
  });
  test("emails as mail apps and spreadsheets paste them: the address, never its wrapping", () => {
    // Bracketed, quoted or `mailto:`: none of it ends up in an invitation nobody could accept.
    expect(isEmail("<ana@x.com>")).toBe(false);
    expect(isEmail('"ana@x.com"')).toBe(false);
    expect(emailsFrom('Ana Silva <Ana@x.com>, "Silva, Bia" <bia@x.com>; mailto:caio@x.com')).toEqual({
      valid: ["ana@x.com", "bia@x.com", "caio@x.com"],
      invalid: [],
    });
    // A spreadsheet column: quoted cells, one per line, a sentence's full stop.
    expect(emailsFrom('"dani@x.com"\n"edu@x.com"\nfabi@x.com.')).toEqual({
      valid: ["dani@x.com", "edu@x.com", "fabi@x.com"],
      invalid: [],
    });
    // With no names in brackets, a word is a typo to fix; in order, once each.
    expect(addressesIn("gil@x.com gil gil@x.com <>")).toEqual([
      { email: "gil@x.com", valid: true },
      { email: "gil", valid: false },
    ]);
    expect(addressesIn("Ana <ana@x.com>, ana@x")).toEqual([
      { email: "ana@x.com", valid: true },
      { email: "ana@x", valid: false },
    ]);
  });
  test("onboarding: typed or pasted e-mails become chips (commas, spaces, new lines); invalid ones stay marked", () => {
    expect(addressesIn(" A@x.com,b@x.com\n\nc@x.com;  bad  a@x.com ").map((a) => a.email)).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "bad",
    ]);
    const first = addInvites([], "Marina@acme.com.br, joao@acme.com.br\nnão-é-email");
    expect(first).toEqual([
      { email: "marina@acme.com.br", admin: false, valid: true },
      { email: "joao@acme.com.br", admin: false, valid: true },
      { email: "não-é-email", admin: false, valid: false },
    ]);
    // Already there: kept as is ("Admin" too); nothing new returns the same list.
    const admin = first.map((i) => (i.email === "joao@acme.com.br" ? { ...i, admin: true } : i));
    expect(addInvites(admin, "joao@acme.com.br")).toBe(admin);
    expect(addInvites(admin, "  ,\n ")).toBe(admin);
    expect(addInvites(admin, "ana@acme.com.br", true).at(-1)).toEqual({
      email: "ana@acme.com.br",
      admin: true,
      valid: true,
    });
    expect(validInvites(first).map((i) => i.email)).toEqual(["marina@acme.com.br", "joao@acme.com.br"]);
  });
  test("onboarding steps: ordered, the optional ones marked", () => {
    expect(ONBOARDING_STEPS.map((s) => s.id)).toEqual([
      "workspace",
      "context",
      "import",
      "agents",
      "computer",
      "ai",
      "team",
      "done",
    ]);
    expect(ONBOARDING_STEPS.filter((s) => s.optional).map((s) => s.id)).toEqual(["import", "computer", "team"]);
  });
  test("onboarding's first message: Lia offers it where the agents can browse, Theo where they can't, then Ada", () => {
    expect(firstAskOrder(true)).toEqual(["lia", "theo", "ada"]);
    expect(firstAskOrder(false)).toEqual(["theo", "lia", "ada"]);
  });
  test("password and amounts", () => {
    expect(passwordState("")).toBe("empty");
    expect(passwordState("curta")).toBe("short");
    expect(passwordState("12345678")).toBe("ok");
    expect(passwordState("x".repeat(129))).toBe("long");
    expect(parseAmount("40")).toBe(40);
    expect(parseAmount("40,5")).toBe(40.5);
    expect(Number.isNaN(parseAmount("abc"))).toBe(true);
    expect(Number.isNaN(parseAmount("-3"))).toBe(true);
  });
});

describe("grammar", () => {
  test("gender of agent names drives Portuguese articles", () => {
    expect(isFeminineName("Ada")).toBe(true);
    expect(isFeminineName("Theo")).toBe(false);
    expect(t("agent.howWorks", agentGrammar(t, "Ada"))).toBe("Como a Ada trabalha");
    expect(t("agentPage.overview.does", agentGrammar(t, "Atlas"))).toBe("O que o Atlas faz");
    expect(t("memory.subtitle", agentGrammar(t, "Ada"))).toBe(
      "O que a Ada aprendeu com as conversas e as correções do time.",
    );
    expect(t("agent.instructionsHelp", { ...agentGrammar(t, "Atlas"), org: "Acme" })).toEndWith(
      "escreva aqui só o que é do Atlas.",
    );
  });

  test("one agent, one pronoun: she or he in English as in Portuguese, never it", () => {
    const english = createI18n("en");
    const te = english.t.bind(english) as TFunction;
    const ada = agentGrammar(te, "Ada");
    const theo = agentGrammar(te, "Theo");
    // Her page says "her" in both lines it has for her.
    expect(te("noAi.agent", ada)).toBe("Ada won't reply because she has no AI\u00a0connected.");
    expect(te("dm.emptyAgent", ada)).toBe("Ask her to remember, forget or work differently.");
    expect(te("agentPage.work.cell.label", ada)).toBe("How she works");
    expect(te("agentPage.overview.proposes", ada)).toBe("Ada proposes changing her instructions");
    expect(te("chat.work.block", theo)).toBe("What he did");
    expect(te("chat.joined.tip", theo)).toBe("Nobody called Theo. He joined to help.");
    expect(te("channelMembers.removeAgentBody", ada)).toBe(
      "She stops reading and answering in this channel. You can add her back later.",
    );
    // Where Portuguese needs no pronoun, English has none either.
    expect(te("agent.budgetHelp", { ...ada, ownerNote: "" }).trim()).toBe(
      "At the limit, Ada stops and says so in the channel.",
    );
    expect(te("newAgent.budgetHelp", ada)).toBe("At the limit, Ada stops and says so.");
    expect(te("look.onHead")).toBe("On the head");
    expect(te("database.agent.levelText")).toBe("Queries the tables the rules allow, read-only.");
    expect(te("agentPage.memory.counts")).toBe("What's in memory");
    // Her Access tab says what each level gives her in her own words.
    expect(te("access.areaText.context.read", ada)).toBe("Searches messages, summaries and facts in the channels.");
    expect(te("access.areaText.context.write", ada)).toBe("Searches the context and keeps her own notes.");
    expect(te("access.areaText.browser.write", theo)).toBe(
      "Browses websites in his own browser, on his computer. Logins are kept per agent.",
    );
    // Settings › Computers names each agent's own folder as her page does.
    expect(te("agentPage.computer.foldersOwn", ada)).toBe("Only uses her own folder.");
    expect(te("machines.page.agentOwnFolder", ada)).toBe("Only her own folder");
    expect(te("machines.page.agentFolders", { ...theo, folders: "Desktop" })).toBe("Uses Desktop and his own folder");
    // Portuguese says each one's own words, articles and forms too.
    expect(t("chat.joined.tip", agentGrammar(t, "Ada"))).toBe("Ninguém chamou a Ada. Ela entrou para ajudar.");
    expect(t("missions.settings.defaults.title", agentGrammar(t, "Ada"))).toBe("Próximas missões da Ada");
    expect(t("access.areaText.desktop.write", agentGrammar(t, "Ada"))).toStartWith(
      "Usa qualquer app na própria tela, no computador dela,",
    );
    expect(t("browser.agent.signedIn", agentGrammar(t, "Ada"))).toBe(
      "A Ada fica com o login feito nos sites em que entrar, neste computador.",
    );
  });

  test("the app's starter agents get their names' own pronoun and article", () => {
    const english = createI18n("en");
    const te = english.t.bind(english) as TFunction;
    const feminine = ["Ada", "Iris", "Nina", "Mila", "Dora", "Clara", "Eva"];
    const masculine = ["Atlas", "Theo", "Leo", "Bento", "Otto", "Hugo"];
    for (const dict of [ptBR, en]) {
      const roles = Object.values(dict.newAgent.roles as Record<string, { agent?: string }>);
      expect(roles.flatMap((r) => (r.agent ? [r.agent] : [])).toSorted()).toEqual(
        [...feminine, ...masculine].toSorted(),
      );
    }
    for (const name of feminine)
      expect([name, agentGrammar(te, name).she, agentGrammar(t, name).article]).toEqual([name, "she", "a"]);
    for (const name of masculine)
      expect([name, agentGrammar(te, name).she, agentGrammar(t, name).article]).toEqual([name, "he", "o"]);
    expect(te("noAi.agent", agentGrammar(te, "Iris"))).toBe("Iris won't reply because she has no AI\u00a0connected.");
    expect(t("chat.joined.tip", agentGrammar(t, "Iris"))).toBe("Ninguém chamou a Iris. Ela entrou para ajudar.");
  });

  test("providers in Portuguese: do Claude, da OpenAI; by id or by the label a run error carries", () => {
    expect(t("newAgent.noKeyFor", providerGrammar(t, "anthropic"))).toBe("Sem chave do Claude");
    expect(t("newAgent.modelNeedsKey", providerGrammar(t, "openai"))).toBe("Precisa de uma chave da OpenAI");
    expect(providerGrammar(t, "Claude")).toEqual({ provider: "Claude", of: "do" });
    // One this app doesn't know keeps its name, with the usual "da".
    expect(providerGrammar(t, "mistral")).toEqual({ provider: "mistral", of: "da" });
    expect(t("agentPage.activity.errors.missing_credential", runErrorGrammar(t, { provider: "Claude" }))).toBe(
      "Falta uma chave do Claude no workspace.",
    );
    expect(
      t(
        "agentPage.activity.errors.credential_wrong_provider",
        runErrorGrammar(t, { modelProvider: "Claude", keyProvider: "DeepSeek" }),
      ),
    ).toBe("O modelo é do Claude, mas a chave é da DeepSeek.");
  });
});

describe("guards and permissions", () => {
  const me = {
    user: { id: "u", name: "W", email: "w@x.com", image: null },
    organizations: [
      { id: "a", name: "A", role: "owner" as const },
      { id: "b", name: "B", role: "member" as const },
    ],
  };
  test("an early-access token as every app sends it: a header signing up in place, the state through a provider", () => {
    const token = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v";
    // What apps/server auth.ts `accessOf` reads.
    expect(earlyAccessHeaders(token)).toEqual({ "x-early-access": token });
    expect(earlyAccessState(token)).toEqual({ additionalData: { earlyAccess: token } });
    expect([earlyAccessHeaders(), earlyAccessState()]).toEqual([{}, {}]);
  });
  test("safe redirects only", () => {
    expect(safeRedirect("/org/a")).toBe("/org/a");
    expect(safeRedirect("//evil.com")).toBeUndefined();
    expect(safeRedirect("https://evil.com")).toBeUndefined();
    expect(safeRedirect("/\\evil.com")).toBeUndefined();
    expect(safeRedirect("/org/a/issues?view=board#top")).toBe("/org/a/issues?view=board#top");
    // Browsers drop tabs and newlines and read a backslash as a slash: each would leave the site.
    for (const bypass of [
      "/\t/evil.com",
      "/\n/evil.com",
      "/\r/evil.com",
      "/%09/evil.com",
      "/%0a/evil.com",
      "/%2F/evil.com",
      "/%2f%2fevil.com",
      "/%5Cevil.com",
      "\\\\evil.com",
      "/.//evil.com",
      "///evil.com",
      "javascript:alert(1)",
    ])
      expect(safeRedirect(bypass)).toBeUndefined();
  });
  test("web links: only http(s)", () => {
    expect(webUrl("https://github.com/acme/app/pull/3")).toBe("https://github.com/acme/app/pull/3");
    expect(webUrl("http://example.com")).toBe("http://example.com");
    expect(webUrl("javascript:alert(1)")).toBeUndefined();
    expect(webUrl("data:text/html,x")).toBeUndefined();
    expect(webUrl("/relative")).toBeUndefined();
  });
  test("landing: last org, first org, onboarding", () => {
    expect(landingFor(me, "b")).toEqual({ orgId: "b" });
    expect(landingFor(me, "zzz")).toEqual({ orgId: "a" });
    expect(landingFor({ ...me, organizations: [] }, null)).toEqual({ to: "/onboarding" });
    expect(membershipIn(me, "b")?.role).toBe("member");
    expect(membershipIn(me, "c")).toBeNull();
  });
  test("landing: a workspace its owner hasn't finished setting up is the onboarding, never a place to land", () => {
    const onboarding = { step: "agents" as const, generalChannelId: "g" };
    const mine = { id: "n", name: "N", role: "owner" as const, onboarding };
    expect(settingUp(mine)).toBe(true);
    expect(landingFor({ ...me, organizations: [mine] }, "n")).toEqual({ to: "/onboarding" });
    // Another of theirs is set up: that one opens, last visited or not.
    expect(landingFor({ ...me, organizations: [mine, ...me.organizations] }, "n")).toEqual({ orgId: "a" });
    // Invited into one being set up, or finished: no onboarding of theirs.
    expect(settingUp({ ...mine, role: "member" })).toBe(false);
    expect(landingFor({ ...me, organizations: [{ ...mine, role: "member" }] }, null)).toEqual({ orgId: "n" });
    expect(settingUp({ id: "n", name: "N", role: "owner" })).toBe(false);
  });
  test("a resumed onboarding knows its ready-made agents by name and look; the rest are imported", () => {
    const look = { color: "indigo", eyes: "round", accessory: "cap" };
    const mark = (p: "theo" | "lia") =>
      p === "theo"
        ? { name: "Theo", handle: "theo", ...look }
        : { name: "Lia", handle: "lia", color: "rose", eyes: "dots", accessory: "flower" };
    const agents = [
      { id: "1", name: "Theo", handle: "theo", appearance: look },
      { id: "2", name: "Theo", handle: "theo-2", appearance: { ...look, color: "green" } },
      { id: "3", name: "Lia", handle: "lia", appearance: { color: "rose", eyes: "dots", accessory: "flower" } },
      { id: "4", name: "Theo", handle: "theo-3", appearance: look },
      { id: "5", name: "Dev", handle: "dev" },
    ];
    const crew = crewOf(agents, ["theo", "lia"] as const, mark);
    expect(Object.keys(crew.presets)).toEqual(["theo", "lia"]);
    expect([crew.presets.theo?.id, crew.presets.lia?.id]).toEqual(["1", "3"]);
    expect(crew.others.map((a) => a.id)).toEqual(["2", "4", "5"]);
    // A create cut short after the agent but before its look: known by its handle, never made again (a 409).
    const halfMade = crewOf(
      [{ id: "6", name: "Lia", handle: "lia", appearance: null }],
      ["theo", "lia"] as const,
      mark,
    );
    expect(halfMade.presets.lia?.id).toBe("6");
    // Its handle with another look, or another name: someone else's.
    expect(
      crewOf([{ id: "7", name: "Lia", handle: "lia", appearance: look }], ["lia"] as const, mark).others,
    ).toHaveLength(1);
    expect(crewOf([{ id: "8", name: "Lia B", handle: "lia" }], ["lia"] as const, mark).others).toHaveLength(1);
    expect(stepIndex("context")).toBe(1);
    expect(stepIndex("done")).toBe(ONBOARDING_STEPS.length - 1);
  });
  test("the server's answer to a step saved: further on or finished elsewhere is followed, the same step isn't", () => {
    expect(aheadOf({ step: "computer", finished: false }, "computer")).toBe(false);
    expect(aheadOf({ step: "computer", finished: false }, "agents")).toBe(true);
    expect(aheadOf({ step: "ai", finished: false }, "computer")).toBe(true);
    expect(aheadOf({ step: "done", finished: true }, "team")).toBe(true);
  });
  test("what a membership may do is what the server resolved from its roles", () => {
    const member = { id: "b", name: "B", role: "member" as const, permissions: ["read", "post"] };
    expect(can(member, "post")).toBe(true);
    expect(can(member, "manage_agents")).toBe(false);
    const owner = { id: "a", name: "A", role: "owner" as const, permissions: ["read", "manage_owners", "configure"] };
    expect(can(owner, "manage_owners")).toBe(true);
    // No list: nothing (the server checks every request anyway).
    const unresolved: { role: "owner"; permissions?: string[] } = { role: "owner" };
    expect(can(unresolved, "read")).toBe(false);
    expect(can(undefined, "read")).toBe(false);
  });
});

describe("i18n", () => {
  const shape = (o: object): unknown =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "object" ? shape(v) : typeof v]));
  test("en has exactly the keys of pt-BR (the source)", () => {
    expect(shape(en)).toEqual(shape(ptBR));
  });
  test("pt-BR is the default; copy follows the screens", () => {
    expect(i18n.language).toBe("pt-BR");
    expect(t("auth.flow.password")).toBe("Bom te ver de novo.");
    expect(t("approval.approve.merge")).toBe("Aprovar merge");
    expect(t("auth.passwordMissing", { count: 3 })).toBe("Faltam 3 caracteres (mínimo de 8).");
  });
  test("no exclamation marks in the interface copy (voice rules)", () => {
    const strings: string[] = [];
    const walk = (o: object) => {
      for (const v of Object.values(o)) typeof v === "string" ? strings.push(v) : walk(v);
    };
    walk(ptBR);
    expect(strings.filter((s) => s.includes("!"))).toEqual([]);
  });
});

describe("the confirmation email", () => {
  test("its link lands back here: confirmed, or a link that no longer works; anything else is no toast", () => {
    expect(emailConfirmedToast("?email_confirmed=1")).toEqual({ key: "auth.emailConfirmed", tone: "info" });
    expect(emailConfirmedToast("?email_confirmed=1&error=TOKEN_EXPIRED")).toEqual({
      key: "auth.emailLinkExpired",
      tone: "error",
    });
    expect(emailConfirmedToast("?connector_error=x")).toBeNull();
    expect(emailConfirmedToast("")).toBeNull();
  });

  test("a link that no longer works offers a new one to whoever is signed in here with the address unconfirmed", async () => {
    const shown: { text: string; tone?: string; action?: ToastAction | ToastAction[] }[] = [];
    const show = (text: string, tone?: "info" | "error", action?: ToastAction | ToastAction[]) => {
      shown.push({ text, tone, action });
    };
    const { auth, calls } = createFakeAuth();
    const signedIn = (emailVerified: boolean | null) => async () =>
      emailVerified === null ? null : ({ user: { email: "bia@example.com", emailVerified } } as Me);
    const expired = { key: "auth.emailLinkExpired", tone: "error" } as const;

    await announceConfirmation(expired, { auth, t, show, me: signedIn(false) });
    expect(shown).toMatchObject([
      { text: "Este link de confirmação não vale mais. Sua conta funciona normalmente.", tone: "error" },
    ]);
    const action = shown[0]?.action as ToastAction;
    expect(action.label).toBe("Mandar outro link");
    action.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([{ method: "sendVerificationEmail", args: ["bia@example.com"] }]);
    expect(shown[1]).toMatchObject({ text: "Mandamos outro link para bia@example.com." });

    // Signed out, or confirmed meanwhile: nothing to send. A link that worked only says so.
    shown.length = 0;
    await announceConfirmation(expired, { auth, t, show, me: signedIn(null) });
    await announceConfirmation(expired, { auth, t, show, me: signedIn(true) });
    await announceConfirmation({ key: "auth.emailConfirmed", tone: "info" }, { auth, t, show, me: signedIn(false) });
    expect(shown).toEqual([
      {
        text: "Este link de confirmação não vale mais. Sua conta funciona normalmente.",
        tone: "error",
        action: undefined,
      },
      {
        text: "Este link de confirmação não vale mais. Sua conta funciona normalmente.",
        tone: "error",
        action: undefined,
      },
      { text: "E-mail confirmado.", tone: "info", action: undefined },
    ]);
  });

  test("the auth client says the app's language on every request; the server picks where a link lands", async () => {
    const sent: { path: string; language: string | null; body: Record<string, unknown> | null }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({
        path: new URL(String(url)).pathname,
        language: new Headers(init?.headers).get("accept-language"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({ token: null, user: { id: "u", name: "Bia", email: "bia@example.com" } });
    }) as typeof fetch;
    try {
      let language = "en";
      const auth = createBetterAuthClient("http://localhost:3000", () => language);
      await auth.signUp({ name: "Bia", email: "bia@example.com", password: "senha-longa" });
      language = "pt-BR";
      await auth.requestPasswordReset({ email: "bia@example.com", redirectTo: "/reset-password" });
      expect(await auth.sendVerificationEmail("bia@example.com")).toEqual({ ok: true });
      const signUp = sent.find((r) => r.path === "/api/auth/sign-up/email");
      expect(signUp?.language).toBe("en");
      expect(signUp?.body).not.toHaveProperty("callbackURL");
      expect(sent.find((r) => r.path === "/api/auth/request-password-reset")?.language).toBe("pt-BR");
      expect(sent.find((r) => r.path === "/api/auth/send-verification-email")).toEqual({
        path: "/api/auth/send-verification-email",
        language: "pt-BR",
        body: { email: "bia@example.com" },
      });
    } finally {
      globalThis.fetch = real;
    }
  });

  test("an email invitation's sign-up carries its token and its email's proof in headers, never in the body (ADR 0090)", async () => {
    type Sent = { path: string; invitation: string | null; mail: string | null; body: Record<string, unknown> | null };
    const sent: Sent[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sent.push({
        path: new URL(String(url)).pathname,
        invitation: headers.get(INVITATION_TOKEN_HEADER),
        mail: headers.get(INVITATION_MAIL_HEADER),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({ token: null, user: { id: "u", name: "Bia", email: "bia@example.com" } });
    }) as typeof fetch;
    try {
      const auth = createBetterAuthClient("http://localhost:3000");
      const bia = { name: "Bia", email: "bia@example.com", password: "senha-longa" };
      await auth.signUp({ ...bia, invitation: { token: "inv-token", mail: "inv-proof" } });
      await auth.signUp({ ...bia, invitation: { token: "copied-token" } });
      await auth.signUp(bia);
      const signUps = sent.filter((r) => r.path === "/api/auth/sign-up/email");
      expect(INVITATION_TOKEN_HEADER).toBe("x-invitation-token");
      expect(INVITATION_MAIL_HEADER).toBe("x-invitation-mail");
      expect(signUps.map((r) => [r.invitation, r.mail])).toEqual([
        ["inv-token", "inv-proof"],
        ["copied-token", null],
        [null, null],
      ]);
      expect(signUps[0]?.body).toMatchObject(bia);
      expect(signUps[0]?.body).not.toHaveProperty("invitation");
    } finally {
      globalThis.fetch = real;
    }
  });
});
