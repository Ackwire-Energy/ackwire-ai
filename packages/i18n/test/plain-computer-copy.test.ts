import { describe, expect, test } from "bun:test";
import { en, ptBR } from "../src/index";
import { leaves } from "./leaves";

/**
 * Screens about the agents' computer (onboarding, preparing, its own page) are read by people who aren't
 * developers: no system names, addresses or tool lists. Sizes ("4 CPUs · 8 GB de memória") and "um usuário
 * para cada agente" are fine. A new screen about computers adds its namespace here.
 */
const NAMESPACES = ["onboarding.computer.", "computer.", "computerSetup.", "machine.", "machines.host."];

/** Case-insensitive, so the Go language is left out: it would match English "Go to…". */
const TECHNICAL =
  /\bLinux\b|\bIP(v[46])?\b|\bvCPU|Chrome|\bgit\b|\bNode\b|Python|\bRust\b|Debian|Ubuntu|Docker|kernel/i;

describe("computer copy", () => {
  for (const [locale, strings] of [
    ["pt-BR", ptBR],
    ["en", en],
  ] as const) {
    test(`${locale} names no system, address or tool`, () => {
      const copy = leaves(strings).filter(([k]) => NAMESPACES.some((n) => k.startsWith(n)));
      expect(copy.length).toBeGreaterThan(0);
      expect(copy.filter(([, v]) => TECHNICAL.test(String(v)))).toEqual([]);
    });
  }

  test("catches the words it bans, whatever the case", () => {
    for (const s of ["Um Linux só do workspace", "com ip próprio", "4 vCPU", "Chrome, git, Node", "IPv4"]) {
      expect(TECHNICAL.test(s)).toBe(true);
    }
    for (const s of ["4 CPUs · 8 GB de memória", "Um usuário para cada agente", "Go to settings", "a equipe"]) {
      expect(TECHNICAL.test(s)).toBe(false);
    }
  });
});
