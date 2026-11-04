import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { ApiError } from "../src/api/http";
import type { AppNotification, GitHubRepositories } from "../src/api/types";
import { openTarget, workspaceHeadline } from "../src/lib/notifications";
import {
  githubRepoLink,
  hiddenRepoOf,
  hiddenRepoText,
  searchRepos,
  skillPickOf,
  skillRefusalText,
  skillSourceViaText,
  skillViaText,
} from "../src/lib/skills";

/** The key and its values, so a test sees which words were picked (the words themselves: packages/i18n). */
const t = ((key: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length > 0 ? `${key} ${JSON.stringify(o)}` : key) as unknown as TFunction;

describe("skills from a private repository (web and phone)", () => {
  test("a pick says which of the workspace's GitHub connections read it; none when no connection was needed", () => {
    const choices = [{ path: "skills/deploy", name: "deploy", description: "x" }];
    expect(skillPickOf({ choices, via: "github_app" })).toEqual({ choices, skipped: [], via: "github_app" });
    expect(skillPickOf({ choices, via: "token" })).toEqual({ choices, skipped: [], via: null });
    expect(skillPickOf({ id: "s1", name: "deploy" })).toBeNull();
  });

  test("the lines name the connection, the app with the repository's owner", () => {
    expect(skillViaText(t, "github_app", "https://github.com/contoso/skills/tree/main/x")).toBe(
      'skills.via.github_app {"owner":"contoso"}',
    );
    expect(skillViaText(t, "github", "https://github.com/contoso/skills")).toBe(
      'skills.via.github {"owner":"contoso"}',
    );
    const fromLink = { source: "url", sourceVia: "github", sourceUrl: "https://github.com/contoso/skills" } as const;
    expect(skillSourceViaText(t, fromLink)).toBe('skills.sourceVia.github {"owner":"contoso"}');
    expect(skillSourceViaText(t, { ...fromLink, sourceVia: null })).toBeNull();
    expect(skillSourceViaText(t, { source: "url", sourceUrl: null })).toBeNull();
    // Edited by hand or replaced by an upload: no longer from the link, whatever updating would read through.
    expect(skillSourceViaText(t, { ...fromLink, source: "manual" })).toBeNull();
    expect(skillSourceViaText(t, { ...fromLink, source: "upload" })).toBeNull();
  });

  test("a repository no connection reads: how the connection fared and whether the app is installed; other refusals aren't one", () => {
    const missing = (params?: Record<string, unknown>) => new ApiError(400, "github.repo_missing", "x", params);
    expect(hiddenRepoOf(missing({ repo: "contoso/skills", connection: "refused", app: true }))).toEqual({
      repo: "contoso/skills",
      connection: "refused",
      app: true,
    });
    expect(hiddenRepoOf(missing({ repo: "contoso/skills", connection: "ok", app: false }))?.connection).toBe("ok");
    // An older server says neither: no connection, no app.
    expect(hiddenRepoOf(missing({ repo: "contoso/skills" }))).toEqual({
      repo: "contoso/skills",
      connection: "none",
      app: false,
    });
    expect(hiddenRepoOf(new ApiError(400, "github.ref_missing", "x"))).toBeNull();
    expect(hiddenRepoOf(new Error("x"))).toBeNull();
  });

  test("what the dialog says of it, and Conectar o GitHub whenever no connection works and the person may connect", () => {
    const said = (connection: "none" | "refused" | "ok", app: boolean, mayConnect: boolean) => {
      const { text, connect } = hiddenRepoText(t, { repo: "contoso/skills", connection, app }, mayConnect);
      return [text.replace('skills.hidden.lead {"repo":"contoso/skills"} ', ""), connect];
    };
    expect(said("none", false, true)).toEqual(["skills.hidden.connect", true]);
    expect(said("none", true, true)).toEqual(['skills.hidden.app {"owner":"contoso"}', true]);
    expect(said("refused", true, true)).toEqual(["skills.hidden.refused", true]);
    // A connection that works and can't see it is given access on GitHub, never replaced from a skills dialog.
    expect(said("ok", true, true)).toEqual(["skills.hidden.unreached", false]);
    // Someone who can't manage connectors is told whom to ask.
    expect(said("none", true, false)).toEqual(["skills.hidden.ask", false]);
    expect(said("refused", false, false)).toEqual(["skills.hidden.ask", false]);
    expect(said("ok", false, false)).toEqual(["skills.hidden.askAccess", false]);
  });

  test("updating from the link: a hidden repository said as the dialog says it, other refusals as errors are", () => {
    const hidden = new ApiError(400, "github.repo_missing", "x", { repo: "contoso/skills", connection: "refused" });
    expect(skillRefusalText(t, hidden, false)).toBe('skills.hidden.lead {"repo":"contoso/skills"} skills.hidden.ask');
    const gone = new ApiError(400, "skill.connection_gone", "x", { repo: "contoso/skills" });
    expect(skillRefusalText(t, gone, true)).toStartWith("errors.skill.connectionGone");
  });

  test("the connected GitHub's repositories by name, accounts left with none out; a repository's link", () => {
    const repo = (owner: string, name: string) => ({
      fullName: `${owner}/${name}`,
      owner,
      name,
      private: true,
      updatedAt: null,
    });
    const listing: GitHubRepositories = {
      connected: true,
      accounts: [
        { login: "contoso", type: "Organization", repositories: [repo("contoso", "skills"), repo("contoso", "site")] },
        { login: "walt", type: "User", repositories: [repo("walt", "notes")] },
      ],
      truncated: false,
    };
    expect(searchRepos(listing, " SK ").map((a) => [a.login, a.repositories.map((r) => r.name)])).toEqual([
      ["contoso", ["skills"]],
    ]);
    expect(searchRepos(listing, "").map((a) => a.repositories.length)).toEqual([2, 1]);
    expect(searchRepos(undefined, "x")).toEqual([]);
    expect(githubRepoLink("contoso/skills")).toBe("https://github.com/contoso/skills");
  });
});

describe("skill notices", () => {
  test("each state of a skill's notice has its headline, and every one opens the skill", () => {
    const notice = (statusTo: string) =>
      ({ kind: "skill_update", source: { skillId: "s1", label: "deploy" }, latest: { statusTo } }) as AppNotification;
    expect(["updated", "waiting", "failed", "edited"].map((s) => workspaceHeadline(notice(s)))).toEqual([
      "skills.notice.updated",
      "skills.notice.waiting",
      "skills.notice.failed",
      "skills.notice.edited",
    ]);
    // Waiting only because it would replace the agents' change (no script in it).
    const replaces = { ...notice("waiting"), latest: { statusTo: "waiting", reason: "edited" } } as AppNotification;
    expect(workspaceHeadline(replaces)).toBe("skills.notice.waitingEdited");
    expect(openTarget(notice("edited"))).toEqual({
      to: "/org/$orgId/settings/$section",
      params: { section: "skills" },
      search: { skill: "s1" },
    });
  });
});
