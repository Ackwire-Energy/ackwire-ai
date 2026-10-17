import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { GitHubRepositories, Run } from "@/api/types";
import {
  ALL_REPOS,
  applyPick,
  covers,
  repoChoiceOf,
  repoExists,
  repoListOf,
  sameRepoChoice,
  toggleRepo,
} from "@/lib/repos";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const repo = (fullName: string, priv = true) => {
  const [owner = "", name = ""] = fullName.split("/");
  return { fullName, owner, name, private: priv, updatedAt: null };
};
const LISTING: GitHubRepositories = {
  connected: true,
  truncated: false,
  accounts: [
    {
      login: "acme",
      type: "Organization",
      repositories: [repo("acme/app"), repo("acme/api"), repo("acme/infra", false)],
    },
    { login: "walt", type: "User", repositories: [repo("walt/notes")] },
  ],
};

describe("the repositories rules", () => {
  test("all or some, in order; the order counts as a change", () => {
    expect(repoChoiceOf([])).toEqual(ALL_REPOS);
    expect(repoChoiceOf(["a/b"])).toEqual({ mode: "some", list: ["a/b"] });
    expect(repoListOf({ mode: "all", list: ["a/b"] })).toEqual([]);
    expect(sameRepoChoice({ mode: "some", list: ["a/b", "c/d"] }, { mode: "some", list: ["c/d", "a/b"] })).toBe(false);
    expect(sameRepoChoice({ mode: "all", list: ["x/y"] }, ALL_REPOS)).toBe(true);
  });

  test("a whole account takes its repositories' place; covers is case-insensitive", () => {
    expect(toggleRepo(["acme/app", "walt/notes"], "acme/*", true)).toEqual(["walt/notes", "acme/*"]);
    expect(toggleRepo(["acme/app"], "acme/app", false)).toEqual([]);
    expect(covers(["Acme/*"], "acme/infra")).toBe(true);
    expect(covers(["acme/app"], "acme/infra")).toBe(false);
  });

  test("Usar estes keeps the first first, keeps what no longer exists, adds at the end", () => {
    const exists = (e: string) => repoExists(LISTING, e);
    expect(exists("acme/legacy")).toBe(false);
    expect(exists("walt/*")).toBe(true);
    expect(repoExists(undefined, "x/y")).toBe(true);
    expect(applyPick(["acme/api", "acme/legacy"], { mode: "some", list: ["walt/notes", "acme/api"] }, exists)).toEqual({
      mode: "some",
      list: ["acme/api", "acme/legacy", "walt/notes"],
    });
    expect(applyPick(["acme/api", "walt/notes"], { mode: "some", list: ["walt/notes", "acme/*"] }, exists)).toEqual({
      mode: "some",
      list: ["walt/notes", "acme/*"],
    });
    expect(applyPick(["acme/api"], { mode: "all", list: ["acme/api"] }, exists)).toEqual(ALL_REPOS);
  });
});

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
const go = async (query: string, state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}${query}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const withRepos = (list: string[]) => {
  const state = seedState();
  state.githubRepos = structuredClone(LISTING);
  state.agentRepos = { [ADA_ID]: list };
  return state;
};
const saveBar = () => screen().queryByRole("region", { name: "Alterações não salvas" });

describe("agent page: GitHub repositories", () => {
  test("under GitHub: the chips, Mudar opens the picker, Usar estes goes to the save bar, Salvar sends the list", async () => {
    const { state } = await go("?tab=access", withRepos(["acme/app"]));
    const github = screen().getByRole("radiogroup", { name: "Nível em GitHub" });
    await click(within(github).getByRole("radio", { name: "Ler e escrever" }));
    const row = github.closest("li") as HTMLElement;
    expect(row.textContent).toContain("Em quais repositórios");
    expect(row.textContent).toContain("acme/app");

    await click(within(row).getByRole("button", { name: "Mudar" }));
    const dialog = screen().getByRole("dialog", { name: "Repositórios da Ada" });
    expect(
      within(dialog)
        .getByRole("checkbox", { name: /acme\/app/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await click(within(dialog).getByRole("checkbox", { name: /acme\/api/ }));
    await click(within(dialog).getByRole("button", { name: "Usar estes" }));
    expect(screen().queryByRole("dialog", { name: "Repositórios da Ada" })).toBeNull();
    expect(row.textContent).toContain("Começa por acme/app quando ninguém diz qual.");
    expect(saveBar()?.textContent).toContain("Repositórios do GitHub");

    await click(within(saveBar() as HTMLElement).getByRole("button", { name: /^Salvar/ }));
    await settle(8);
    expect(state.calls.find((c) => c.method === "repositories.set")?.args[2]).toEqual(["acme/app", "acme/api"]);
    expect(saveBar()).toBeNull();
  });

  test("Só alguns with nothing chosen can't be saved; a repository that no longer exists says so", async () => {
    await go("?tab=access", withRepos(["acme/app", "acme/legacy"]));
    const github = screen().getByRole("radiogroup", { name: "Nível em GitHub" });
    await click(within(github).getByRole("radio", { name: "Ler" }));
    const row = github.closest("li") as HTMLElement;
    expect(row.textContent).toContain("acme/legacy não existe mais");
    await click(within(row).getByRole("button", { name: "Mudar" }));
    const dialog = screen().getByRole("dialog", { name: "Repositórios da Ada" });
    await click(within(dialog).getByRole("checkbox", { name: /acme\/app/ }));
    await click(within(dialog).getByRole("button", { name: "Usar estes" }));
    // The one that no longer exists stays until someone removes it.
    expect(row.textContent).toContain("acme/legacy não existe mais");
    expect(row.textContent).not.toContain("acme/app");
  });

  test("a refused repository in Atividade: Liberar opens the picker with it checked", async () => {
    const state = withRepos(["acme/app"]);
    const run: Run = {
      id: "run-d",
      agentId: ADA_ID,
      channelId: ENG_ID,
      threadId: "m-1",
      trigger: "mention",
      status: "done",
      error: null,
      what: "atualiza as dependências do infra",
      turns: 1,
      inputTokens: 10,
      outputTokens: 1,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      repo: "acme/app",
      deniedRepo: "acme/infra",
    };
    state.runs.push(run);
    await go("?tab=activity", state);
    const runs = screen().getByRole("region", { name: "Execuções" });
    expect(runs.textContent).toContain("acme/infra não está entre os repositórios da Ada.");
    await click(within(runs).getByRole("button", { name: "Liberar acme/infra" }));
    const dialog = screen().getByRole("dialog", { name: "Repositórios da Ada" });
    expect(
      within(dialog)
        .getByRole("checkbox", { name: /acme\/infra/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});
