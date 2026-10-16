import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { createI18n } from "@/i18n";
import { en } from "@/i18n/locales/en";
import { ptBR } from "@/i18n/locales/pt-BR";
import {
  dayLabel,
  formatInt,
  formatTokensShort,
  formatUsd,
  joinNames,
  relativeTime,
  shortModel,
  timeLeft,
  whenAt,
} from "@/lib/format";
import { agentGrammar, isFeminineName } from "@/lib/grammar";
import { landingFor, membershipIn, safeRedirect } from "@/lib/guards";
import { addInvites, ONBOARDING_STEPS, splitEmails, validInvites } from "@/lib/onboarding";
import { can } from "@/lib/permissions";
import { handleFrom, isEmail, parseAmount, parseEmails, passwordState, slugify } from "@/lib/text";

const i18n = createI18n("pt-BR");
const t = i18n.t.bind(i18n) as TFunction;
const now = new Date(2026, 9, 14, 10, 44);
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

describe("format (pt-BR, machine numbers precise)", () => {
  test("money", () => {
    expect(formatUsd(t, "pt-BR", 12.3)).toBe("US$ 12,30");
    expect(formatUsd(t, "pt-BR", 0.004)).toBe("US$ 0,004");
    expect(formatUsd(t, "pt-BR", 0)).toBe("US$ 0,00");
    expect(formatUsd(t, "pt-BR", 1234.5)).toBe("US$ 1.234,50");
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
    expect(parseEmails("A@x.com, b@x.com ,bad, a@x.com")).toEqual(["a@x.com", "b@x.com"]);
  });
  test("onboarding: typed or pasted e-mails become chips (commas, spaces, new lines); invalid ones stay marked", () => {
    expect(splitEmails(" A@x.com,b@x.com\n\nc@x.com;  bad  a@x.com ")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "bad",
    ]);
    const first = addInvites([], "Marina@acme.com.br, joao@acme.com.br\nnão-é-email");
    expect(first).toEqual([
      { email: "marina@acme.com.br", role: "member", valid: true },
      { email: "joao@acme.com.br", role: "member", valid: true },
      { email: "não-é-email", role: "member", valid: false },
    ]);
    // Already there: kept as is (its role too); nothing new returns the same list.
    const admin = first.map((i) => (i.email === "joao@acme.com.br" ? { ...i, role: "admin" as const } : i));
    expect(addInvites(admin, "joao@acme.com.br")).toBe(admin);
    expect(addInvites(admin, "  ,\n ")).toBe(admin);
    expect(addInvites(admin, "ana@acme.com.br", "admin").at(-1)).toEqual({
      email: "ana@acme.com.br",
      role: "admin",
      valid: true,
    });
    expect(validInvites(first).map((i) => i.email)).toEqual(["marina@acme.com.br", "joao@acme.com.br"]);
  });
  test("onboarding steps: ordered, the optional ones marked", () => {
    expect(ONBOARDING_STEPS.map((s) => s.id)).toEqual(["workspace", "context", "agents", "computer", "team", "done"]);
    expect(ONBOARDING_STEPS.filter((s) => s.optional).map((s) => s.id)).toEqual(["computer", "team"]);
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
    expect(t("agent.permissionsTitle", agentGrammar(t, "Atlas"))).toBe("O que o Atlas pode fazer");
    expect(t("memory.subtitle", agentGrammar(t, "Ada"))).toContain("entra no contexto dela");
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
  test("safe redirects only", () => {
    expect(safeRedirect("/org/a")).toBe("/org/a");
    expect(safeRedirect("//evil.com")).toBeUndefined();
    expect(safeRedirect("https://evil.com")).toBeUndefined();
    expect(safeRedirect("/\\evil.com")).toBeUndefined();
  });
  test("landing: last org, first org, onboarding", () => {
    expect(landingFor(me, "b")).toEqual({ orgId: "b" });
    expect(landingFor(me, "zzz")).toEqual({ orgId: "a" });
    expect(landingFor({ ...me, organizations: [] }, null)).toEqual({ to: "/onboarding" });
    expect(membershipIn(me, "b")?.role).toBe("member");
    expect(membershipIn(me, "c")).toBeNull();
  });
  test("role table mirrors the backend", () => {
    expect(can("member", "post")).toBe(true);
    expect(can("member", "manage_agents")).toBe(false);
    expect(can("admin", "manage_members")).toBe(true);
    expect(can("admin", "manage_owners")).toBe(false);
    expect(can("owner", "manage_owners")).toBe(true);
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
    expect(t("auth.signInSubtitle")).toBe("Bom te ver de novo.");
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
