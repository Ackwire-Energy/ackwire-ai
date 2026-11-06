import { describe, expect, test } from "bun:test";
import { APP_LINK_PATHS, APP_LINK_WEB_QUERIES } from "../../../server/src/app-links";
import { APP_LINK_PATTERNS } from "../../app.config";
import {
  appLinkFromUrl,
  linkWorkspace,
  resolveLink,
  SETTINGS_SCREENS,
  WEB_ONLY_QUERIES,
} from "../../src/features/links/app-links";
import { rememberLink, takeLink } from "../../src/features/links/pending";

const W = "https://app.agentes.chat";
const O = "org-1";
/** The `/link` an address opens, as its parameters. */
const linkOf = (url: string) => {
  const link = appLinkFromUrl(url);
  if (!link || !("href" in link) || !link.href.startsWith("/link?")) return link;
  const { web, ...params } = Object.fromEntries(
    link.href
      .slice("/link?".length)
      .split("&")
      .map((pair) => pair.split("=").map(decodeURIComponent)),
  );
  expect(web).toBe(url.slice(W.length));
  return params;
};

describe("web addresses → the app's screens", () => {
  test("a conversation at a message, a DM, a thread, in their workspace", () => {
    expect(linkOf(`${W}/org/${O}/c/c1?m=m1`)).toEqual({ org: O, to: "/chat/c1?m=m1" });
    expect(linkOf(`${W}/org/${O}/c/c1`)).toEqual({ org: O, to: "/chat/c1" });
    expect(linkOf(`${W}/org/${O}/dm/agent/a1?m=m2`)).toEqual({ org: O, agent: "a1", m: "m2" });
    expect(linkOf(`${W}/org/${O}/dm/person/u1`)).toEqual({ org: O, person: "u1" });
    expect(linkOf(`${W}/org/${O}/threads/t1?m=m3`)).toEqual({ org: O, thread: "t1", m: "m3" });
    expect(linkOf(`${W}/org/${O}/threads?open=t2`)).toEqual({ org: O, thread: "t2" });
  });

  test("the workspace's other pages the app has", () => {
    const to = (path: string) => (linkOf(`${W}/org/${O}${path}`) as { to?: string }).to;
    expect(to("")).toBe("/");
    expect(to("/home")).toBe("/");
    expect(to("/threads")).toBe("/threads");
    expect(to("/agents/a1")).toBe("/agent/a1");
    expect(to("/agents/a1/memory")).toBe("/memory?agent=a1");
    expect(to("/agents/new")).toBe("/new-agent");
    expect(to("/approvals?open=ap1")).toBe("/approval/ap1");
    expect(to("/approvals")).toBe("/activity");
    expect(to("/notifications")).toBe("/activity");
    expect(linkOf(`${W}/org/${O}/notifications?open=n1`)).toEqual({ org: O, notification: "n1" });
    expect(to("/issues")).toBe("/issues");
    expect(to("/issues/131")).toBe("/issues/131");
    expect(to("/issues?open=7")).toBe("/issues/7");
    expect(to("/routines?open=r1")).toBe("/routines/r1");
    expect(to("/routines")).toBe("/routines");
    expect(to("/search")).toBe("/search");
    expect(to("/drive")).toBe("/drive");
    expect(to("/wiki")).toBe("/wiki");
    expect(to("/wiki/onboarding")).toBe("/wiki/onboarding");
    expect(to("/members")).toBe("/me/members");
    expect(to("/settings")).toBe("/settings");
    expect(to("/settings/connectors")).toBe("/connectors");
    expect(to("/settings/members?request=r1&do=approve")).toBe("/join-requests?request=r1");
    expect(to("/settings/members")).toBe("/me/members");
    expect(to("/settings/keys")).toBe("/ai-accounts");
    expect(to("/settings/usage")).toBe("/usage");
    expect(to("/settings/computers")).toBe("/settings/computers");
    expect(to("/settings/computers/k1")).toBe("/settings/computers/k1");
    expect(to("/settings/account")).toBe("/me/account");
  });

  test("invitations, password resets and sign-ups keep their own paths", () => {
    expect(appLinkFromUrl(`${W}/invite/tok-1`)).toEqual({ href: "/invite/tok-1" });
    expect(appLinkFromUrl(`${W}/reset-password?token=abc`)).toEqual({ href: "/reset-password?token=abc" });
    expect(appLinkFromUrl(`${W}/signup?email=a%40b.c&access=x`)).toEqual({ href: "/signup?email=a%40b.c&access=x" });
  });

  test("pages the app lacks, and odd ids, open the website; the app's own links stay as they are", () => {
    expect(appLinkFromUrl(`${W}/org/${O}/calendar`)).toEqual({ web: `/org/${O}/calendar` });
    expect(appLinkFromUrl(`${W}/org/${O}/settings/billing`)).toEqual({ web: `/org/${O}/settings/billing` });
    // A sign-in's result or an action only the website runs stays the website's.
    for (const path of [
      "/settings/connectors?mail=connected&account=x",
      "/settings/connectors?connected=github",
      "/settings/apps?install=1",
      "/settings/connectors?review=1",
      "/settings/general?delete=1",
    ])
      expect(appLinkFromUrl(`${W}/org/${O}${path}`)).toEqual({ web: `/org/${O}${path}` });
    expect(appLinkFromUrl(`${W}/org/${O}/calendar`)).toEqual({ web: `/org/${O}/calendar` });
    expect(appLinkFromUrl(`${W}/org/${O}/c/..%2F..`)).toEqual({ web: `/org/${O}/c/..%2F..` });
    expect(appLinkFromUrl(`${W}/help/start`)).toEqual({ web: "/help/start" });
    expect(appLinkFromUrl("agenteschat://chat/c1")).toBeNull();
    expect(appLinkFromUrl("/chat/c1")).toBeNull();
  });

  test("every path the server and the Android build list opens a screen (no dead ends), and they are the same", () => {
    expect(APP_LINK_PATTERNS).toEqual(APP_LINK_PATHS);
    // A real address for each pattern (`*` as an id, or what the app reads there).
    const real: Record<string, string> = {
      "/org/*/dm/*": "/org/*/dm/agent/x1",
      "/org/*/issues/*": "/org/*/issues/7",
    };
    const sample = (pattern: string) =>
      `${W}${(real[pattern] ?? pattern).replace("/org/*", `/org/${O}`).replace(/\*/g, "x1")}`;
    for (const pattern of APP_LINK_PATHS) {
      const link = appLinkFromUrl(sample(pattern));
      expect([pattern, link && "href" in link]).toEqual([pattern, true]);
    }
    // Settings sections one by one (billing, roles, voice stay the website's, on Android too), all the app has.
    expect(APP_LINK_PATHS.filter((p) => /^\/org\/\*\/settings\/[a-z]+$/.test(p)).map((p) => p.split("/")[4])).toEqual(
      Object.keys(SETTINGS_SCREENS),
    );
    expect(APP_LINK_PATHS.some((p) => /settings\/(\*|billing|roles|voice)/.test(p))).toBe(false);
    expect(WEB_ONLY_QUERIES).toEqual(APP_LINK_WEB_QUERIES);
  });
});

describe("the link screen", () => {
  const api = {
    threads: { get: async (_o: string, id: string) => ({ id, channelId: "c9" }) as never },
    dms: { open: async (_o: string, to: object) => ({ channelId: "agentId" in to ? "d-agent" : "d-person" }) },
    notifications: {
      read: async (_o: string, id: string) =>
        ({ id, kind: "mention", source: { channelId: "c2", messageId: "m9" }, actors: [], latest: {} }) as never,
    },
  };

  test("opens the screen a path, a thread, a DM or a notification names", async () => {
    expect(await resolveLink(api, O, { to: "/chat/c1?m=m1" })).toBe("/chat/c1?m=m1");
    expect(await resolveLink(api, O, { to: "//evil.example" })).toBe("/");
    expect(await resolveLink(api, O, { thread: "t1", m: "m1" })).toBe("/chat/c9?thread=t1&m=m1");
    expect(await resolveLink(api, O, { agent: "a1" })).toBe("/chat/d-agent");
    expect(await resolveLink(api, O, { person: "u1", m: "m2" })).toBe("/chat/d-person?m=m2");
    expect(await resolveLink(api, O, { notification: "n1" })).toBe("/chat/c2?m=m9");
    expect(await resolveLink(api, O, {})).toBe("/");
  });

  test("a workspace the person isn't in opens the address on the website, never its ids in the current one", () => {
    expect(linkWorkspace({ org: "o2", web: "/org/o2/c/c1" }, ["o1", "o2"], "o1")).toEqual({ org: "o2" });
    expect(linkWorkspace({}, ["o1"], "o1")).toEqual({ org: "o1" });
    expect(linkWorkspace({ org: "o3", web: "/org/o3/c/c1?m=m1" }, ["o1"], "o1")).toEqual({ web: "/org/o3/c/c1?m=m1" });
    expect(linkWorkspace({ org: "o3", web: "//evil.example" }, ["o1"], "o1")).toEqual({ web: "/" });
  });

  test("a link opened while signed out is taken once", () => {
    rememberLink("/link?org=o&to=%2F");
    expect(takeLink()).toBe("/link?org=o&to=%2F");
    expect(takeLink()).toBeNull();
  });
});
