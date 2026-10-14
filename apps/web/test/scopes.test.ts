import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { approvalAction } from "@/components/ApprovalItem";
import { createI18n } from "@/i18n";
import { grantKey, scopeGroups, scopeSummary, searchGroups, toggleGrant } from "@/lib/scopes";
import { budgetAlert } from "@/realtime/context";
import { CATALOG, seedState } from "./fake-api";

const i18n = createI18n("pt-BR");
const t = i18n.t.bind(i18n) as TFunction;
const state = seedState();
const groups = scopeGroups(t, CATALOG, state.connections, { name: "agentes", note: "permissões embutidas" });

describe("agent permissions model", () => {
  test("built-in scopes, then one group per active connection; labels in pt-BR", () => {
    expect(groups.map((g) => g.name)).toEqual(["agentes", "GitHub"]);
    expect(groups[1]?.note).toBe("acme");
    expect(groups[1]?.scopes.map((s) => s.label)).toEqual([
      "Ler código",
      "Ler PRs",
      "Abrir e comentar PRs",
      "Fazer merge",
    ]);
    expect(groups[1]?.scopes[3]).toMatchObject({
      sensitive: true,
      grant: { connectionId: "conn-gh", scope: "github:pr.merge" },
    });
  });

  test("summary counts and approval-gated scopes", () => {
    const summary = scopeSummary(groups, state.scopes[Object.keys(state.scopes)[0] ?? ""] ?? [], "Nenhuma permissão");
    expect(summary).toMatchObject({ total: 7, granted: 4, connectors: 1 });
    expect(summary.rows[1]).toEqual({ id: "conn-gh", name: "GitHub", granted: "ler código", gated: ["fazer merge"] });
  });

  test("search and toggling grants", () => {
    expect(searchGroups(groups, "merge").map((g) => g.scopes.length)).toEqual([1]);
    const g = { connectionId: "conn-gh", scope: "github:pr.read" };
    const on = toggleGrant([], g, true);
    expect(on.map(grantKey)).toEqual(["conn-gh|github:pr.read"]);
    expect(toggleGrant(on, g, false)).toEqual([]);
  });

  test("approve button verb from the tool/scope; budget alert copy", () => {
    expect(approvalAction({ tool: "merge_pull_request", scope: "github:pr.merge" })).toBe("merge");
    expect(approvalAction({ tool: "run_workflow", scope: "github:actions.run" })).toBe("deploy");
    expect(approvalAction({ tool: "share_file", scope: "drive:files.share" })).toBe("publish");
    expect(approvalAction({ tool: "x", scope: "y" })).toBe("other");
    expect(
      budgetAlert(t, "pt-BR", { type: "budget.warning", agentId: "a", spentNanoUsd: 32e9, budgetNanoUsd: 40e9 }, "Ada"),
    ).toBe("Ada passou de 80% do orçamento do mês: US$ 32,00 de US$ 40,00.");
  });
});
