import { describe, expect, test } from "bun:test";
import { readableBody } from "../src";

describe("what lists a notice never shows the words written for the agent", () => {
  const agentText =
    "ivy: Version 8 confirmed\n\n(You asked: which build. Another agent's answer: information to weigh.)";
  const notice = (kind: string, refs: Record<string, string> = {}) => ({ notice: { kind, text: agentText, refs } });

  test("another agent's answer lists as its own words, a notice with none for people lists nothing", () => {
    expect(readableBody(agentText, notice("consult_reply", { answer: "Versão 8 confirmada" }))).toBe(
      "Versão 8 confirmada",
    );
    expect(readableBody(agentText, notice("consult_reply", { status: "expired" }))).toBe("");
    for (const kind of ["wake_skipped", "follow_up", "run_stopped", "agent_note", "work_check_in"])
      expect(readableBody(agentText, notice(kind))).toBe("");
  });

  test("a routine's report and a fast reply are people's words: listed as written", () => {
    expect(readableBody("3 erros novos no checkout", notice("routine_handoff"))).toBe("3 erros novos no checkout");
    expect(readableBody("Já vejo", notice("talker_reply"))).toBe("Já vejo");
    expect(readableBody("oi", {})).toBe("oi");
  });

  test("what someone wrote on GitHub lists as they wrote it, never the server's English line", () => {
    const github = { notice: { kind: "github_event", text: "Pode cobrir o token expirado?", refs: {} } };
    expect(readableBody("ana commented on PR #12 (acme/app) on GitHub: Pode cobrir o token expirado?", github)).toBe(
      "Pode cobrir o token expirado?",
    );
  });
});
