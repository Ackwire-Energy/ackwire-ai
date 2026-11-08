import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComputerSetup, Machine, StorageConfig } from "@agenteschat/client";
import { type SetupView, setupView } from "@agenteschat/client/lib/computer";
import { changedByText, changesSinceLink, skillPendingViews, skillUpdateWords } from "@agenteschat/client/lib/skills";
import { storageUsageLine } from "@agenteschat/client/lib/storage";
import {
  agentComputerPick,
  exportFileName,
  grantCommand,
  isGithubSkillLink,
  machineFacts,
  missingIdeas,
  NO_COMPUTER,
  nameOnLeave,
  noComputerKey,
  pauseText,
  peoplesMachines,
  platformText,
  reduceTexts,
  type S3Form,
  SETTINGS_SECTIONS,
  s3FormOf,
  s3Missing,
  searchSkills,
  seenText,
  skillLine,
  skillSourceKey,
  stepAt,
  storageKey,
  tileStates,
  toS3Input,
  visibleSections,
  withIdea,
} from "../../src/features/settings/logic";
import { translator } from "./fixtures";

const APP = join(import.meta.dir, "..", "..", "app", "(app)");
const NOW = new Date(2026, 9, 28, 15, 0);

const machine = (over: Partial<Machine> & { id: string }): Machine => ({
  name: "Mac mini",
  kind: "connected",
  online: true,
  lastSeenAt: null,
  hostname: "mini",
  os: "darwin",
  arch: "arm64",
  runnerVersion: "1.4.0",
  execAllowed: true,
  pairedBy: { id: "u1", name: "Dev" },
  agents: [],
  workspace: null,
  canManage: true,
  createdAt: "2026-10-01T10:00:00.000Z",
  ...over,
});

const preparing = (): SetupView =>
  setupView(
    {
      mode: "external",
      state: "preparing",
      step: "installing",
      reason: null,
      since: null,
      requestedAt: null,
      expectedReadyAt: null,
      secondsLeft: null,
      secondsWaited: null,
      notifyByEmail: false,
      specs: null,
      machineId: null,
    } satisfies ComputerSetup,
    NOW.getTime(),
  ) as SetupView;

describe("the workspace's settings on the phone: who opens what (the web's sub-nav)", () => {
  test("in the web's order and groups", () => {
    expect(SETTINGS_SECTIONS.map((s) => `${s.group}:${s.id}`)).toEqual([
      "you:apps",
      "org:general",
      "org:right_hand",
      "org:members",
      "org:roles",
      "org:vault",
      "org:audit",
      "org:media",
      "agents:access",
      "agents:connectors",
      "agents:skills",
      "agents:computers",
      "costs:usage",
      "costs:keys",
      "costs:storage",
      "costs:import",
    ]);
  });

  test("each section opens with its permission (ADR 0085); a member keeps only their own and what they use", () => {
    const as = (role: "owner" | "member", permissions: string[]) => ({ id: "o", name: "Acme", role, permissions });
    const ids = (permissions: string[]) => visibleSections(as("member", permissions)).map((s) => s.id);
    const all = [
      "read",
      "invite_people",
      "view_audit",
      "view_usage",
      "manage_agents",
      "configure",
      "create_agents",
      "manage_roles",
    ];
    expect(visibleSections(as("owner", all)).length).toBe(SETTINGS_SECTIONS.length);
    // No Geral (what the agents know of the workspace) or GIFs: those are the workspace's, for admins. Uso stays:
    // their own plans' meters, in percentages (ADR 0063).
    // The Vault is every member's (ADR 0144): their own items, and the team's shared with them.
    expect(ids(["read", "post"])).toEqual(["apps", "members", "vault", "connectors", "computers", "usage", "keys"]);
    expect(ids(["read", "manage_agents"])).toEqual([
      "apps",
      "right_hand",
      "members",
      "vault",
      "access",
      "connectors",
      "skills",
      "computers",
      "usage",
      "keys",
    ]);
    expect(ids(["read", "configure"])).toEqual(expect.arrayContaining(["general", "media", "storage"]));
    expect(ids(["read", "view_audit"])).toContain("audit");
    expect(ids(["read", "create_agents"])).toContain("import");
    expect(visibleSections(undefined).map((s) => s.id)).toEqual(["apps", "connectors", "usage"]);
  });

  test("each section opens a screen the app has", () => {
    for (const s of SETTINGS_SECTIONS) {
      const path = s.href.slice(1);
      expect(existsSync(join(APP, `${path}.tsx`)) || existsSync(join(APP, path, "index.tsx"))).toBe(true);
    }
  });

  test("every settings screen is in the stack, pushed", () => {
    const layout = readFileSync(join(APP, "_layout.tsx"), "utf8");
    const routes = readdirSync(join(APP, "settings"), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => `settings/${f.replace(/\\/g, "/").replace(/\.tsx$/, "")}`);
    expect(routes.length).toBeGreaterThan(10);
    // The workspace's settings page wears the cover bar, like Você's; the screens it opens scroll under the bar.
    expect(layout).toContain(`name="settings/index" options={{ ...pushed, ...coverBarOptions }}`);
    for (const route of routes.filter((r) => r !== "settings/index"))
      expect(layout).toContain(`name="${route}" options={{ ...pushed, ...scrollUnder }}`);
  });
});

describe("Geral", () => {
  test("each area's line, as the web's tiles", async () => {
    const t = await translator("pt-BR");
    expect(
      tileStates(t, "pt-BR", {
        overview: { people: 3, agents: 2, budgetUsedPercent: 42 },
        usesApi: true,
        invitations: 1,
        connectors: ["GitHub", "Slack", "Linear", "Sentry"],
        skills: 5,
        computers: { count: 2, online: 1 },
        keys: { manages: true, live: 2, platform: false },
        storage: { kind: "agentes", edition: "selfhost" },
      }),
    ).toEqual({
      members: "3 membros · 1 convite esperando",
      access: "2 agentes",
      usage: "42% do orçamento usado este mês",
      connectors: "4 conectados · GitHub, Slack, Linear",
      skills: "5 skills",
      computers: "1 de 2 ligados",
      keys: "2 chaves",
      storage: "Este servidor",
    });
  });

  test("the empty states, a member's plans, and nothing while an area loads", async () => {
    const t = await translator("pt-BR");
    expect(
      tileStates(t, "pt-BR", {
        connectors: [],
        computers: { count: 0, online: 0 },
        keys: { manages: false, plans: 0 },
        storage: { kind: "s3", edition: "cloud" },
      }),
    ).toEqual({
      connectors: "Nenhum app conectado ainda",
      computers: "Nenhum computador ainda",
      keys: "Nenhum plano ainda",
      storage: "Seu próprio bucket",
    });
    expect(tileStates(t, "pt-BR", { keys: { manages: true, live: 0, platform: true } })).toEqual({
      keys: "Usando a chave deste servidor",
    });
    expect(tileStates(t, "pt-BR", {})).toEqual({});
    // A workspace on plans alone (ADR 0063 §5): Uso says no 0% budget.
    expect(
      tileStates(t, "pt-BR", { overview: { people: 3, agents: 2, budgetUsedPercent: 0 }, usesApi: false }),
    ).toEqual({ members: "3 membros", access: "2 agentes" });
    const en = await translator("en");
    expect(tileStates(en, "en", { computers: { count: 3, online: 2 } }).computers).toBe("2 of 3 on");
  });

  test("the context's ideas: the ones still missing, and one started on a paragraph of its own", () => {
    const ideas = ["Para quem", "O que importa agora", "O que nunca fazer"];
    expect(missingIdeas("", ideas)).toEqual(ideas);
    expect(missingIdeas("Somos uma agência.\n\npara quem: famílias", ideas)).toEqual(ideas.slice(1));
    expect(withIdea("", "Para quem")).toBe("Para quem: ");
    expect(withIdea("Somos uma agência.  \n", "Para quem")).toBe("Somos uma agência.\n\nPara quem: ");
  });

  test("leaving the name: saved when it changed, the saved one back when emptied", () => {
    expect(nameOnLeave(" Acme Brasil ", "Acme")).toEqual({ save: "Acme Brasil" });
    expect(nameOnLeave("Acme", "Acme")).toBeNull();
    expect(nameOnLeave("   ", "Acme")).toEqual({ reset: "Acme" });
  });
});

describe("Skills", () => {
  const skills = [
    { name: "Relatório", description: "Quando pedirem um resumo da semana" },
    { name: "Deploy", description: "Publicar a versão nova" },
  ];

  test("search by name or what it's for, accents aside", () => {
    expect(searchSkills(skills, "relatorio")).toEqual([skills[0]]);
    expect(searchSkills(skills, "versão")).toEqual([skills[1]]);
    expect(searchSkills(skills, "  ")).toEqual(skills);
  });

  test("where a skill came from, and only GitHub links install", () => {
    expect(skillSourceKey({ source: "url", sourceUrl: "https://github.com/acme/skills/tree/main/deploy" })).toBe(
      "github",
    );
    expect(skillSourceKey({ source: "url", sourceUrl: "https://example.com/skill.zip" })).toBe("url");
    expect(skillSourceKey({ source: "manual", sourceUrl: null })).toBe("manual");
    expect(isGithubSkillLink(" https://github.com/acme/skills ")).toBe(true);
    expect(isGithubSkillLink("https://github.com/acme")).toBe(false);
    expect(isGithubSkillLink("https://gitlab.com/acme/skills")).toBe(false);
  });

  test("its facts in the list", async () => {
    const t = await translator("pt-BR");
    const s = { source: "url" as const, sourceUrl: "https://github.com/acme/s", version: 3, defaultForNewAgents: true };
    expect(skillLine(t, s, 2)).toBe("GitHub · Em agentes novos · v3 · 2 agentes usam");
    expect(skillLine(t, { ...s, source: "manual", defaultForNewAgents: false }, null)).toBe("Criada aqui · v3");
    expect(skillLine(t, { ...s, autoUpdate: true }, null)).toBe("GitHub · Em agentes novos · Atualiza sozinha · v3");
    const waiting = { scripts: ["run.sh"], at: "2026-11-03T10:00:00Z", dismissed: false };
    expect(skillLine(t, { ...s, autoUpdate: true, pendingUpdate: waiting }, null)).toBe(
      "GitHub · Em agentes novos · Atualização esperando · v3",
    );
    expect(skillLine(t, { ...s, pendingUpdate: { ...waiting, edited: true } }, null)).toBe(
      "GitHub · Em agentes novos · Link e agentes mudaram · v3",
    );
  });

  test("its page while an update waits on both sides: the choice, who changed it, and Desfazer after either", async () => {
    const t = await translator("pt-BR");
    // Minutes, not hours: "há 2 h" turns into "ontem" for a run in the two hours after midnight.
    const at = new Date(Date.now() - 2 * 60_000).toISOString();
    const base = { body: "# v1", description: "Antes do deploy.", at: new Date(Date.now() - 86_400_000).toISOString() };
    const change = { id: "c1", agentId: "ada", at, before: "# v1", after: "# v1\nCache.", undone: false };
    const skill = {
      id: "s1",
      name: "deploy",
      description: "Antes do deploy.",
      version: 3,
      source: "url" as const,
      sourceUrl: "https://github.com/acme/s",
      defaultForNewAgents: false,
      metadata: {},
      createdAt: at,
      updatedAt: at,
      body: "# v1\nCache.",
      files: [],
      pendingUpdate: { scripts: [], at, dismissed: false, edited: true },
      pending: { body: "# v2", description: "Antes do deploy.", base, files: [] },
      changes: [change],
    };
    const words = skillUpdateWords(t, "pt-BR", skill);
    expect(words.waiting).toMatchObject({
      title: "O link tem uma versão nova, e os agentes também mudaram esta skill",
      since: "Versão nova no link há 2 min",
      apply: "Usar a versão do link",
      keep: "Manter a dos agentes",
    });
    expect(changedByText(t, "pt-BR", changesSinceLink(skill), () => "Ada")).toBe(
      "Ada mudou esta skill, a última vez há 2 min",
    );
    expect(skillPendingViews(skill).map((v) => t(`skills.diff.${v.id}`))).toEqual([
      "O que os agentes mudaram",
      "O que mudou no link",
      "Atual × link",
    ]);
    const kept = skillUpdateWords(t, "pt-BR", {
      ...skill,
      pendingUpdate: { ...skill.pendingUpdate, dismissed: true, dismissedAt: at },
    });
    expect([kept.waiting, kept.kept]).toEqual([null, "Ficou a versão dos agentes há 2 min"]);
    const chosen = skillUpdateWords(t, "pt-BR", {
      ...skill,
      pendingUpdate: null,
      lastUpdate: { fromVersion: 3, at, agentId: null, waited: true },
    });
    expect(chosen.last).toEqual({ line: "Ficou a versão do link há 2 min", undo: "Desfazer" });
  });

  test("a long install's line moves on and stays on the last step", () => {
    expect(stepAt(0, 0, 3)).toBe(0);
    expect(stepAt(0, 2600, 3)).toBe(1);
    expect(stepAt(0, 60_000, 3)).toBe(2);
  });
});

describe("Computadores", () => {
  test("a computer's line: system, version, seen and who connected it; the server's says what it is", async () => {
    const t = await translator("pt-BR");
    expect(machineFacts(t, "pt-BR", machine({ id: "mini" }), NOW)).toBe(
      "macOS · versão 1.4.0 · conectado agora · Conectado por Dev",
    );
    const offline = machine({
      id: "box",
      os: "linux",
      online: false,
      lastSeenAt: new Date(2026, 9, 28, 13, 0).toISOString(),
      runnerVersion: "",
      pairedBy: null,
    });
    expect(machineFacts(t, "pt-BR", offline, NOW)).toBe("Linux · visto há 2 h");
    expect(seenText(t, "pt-BR", { online: false, lastSeenAt: null }, NOW)).toBe("ainda não conectou");
    expect(machineFacts(t, "pt-BR", machine({ id: "host", kind: "host", os: "linux" }), NOW)).toBe(
      "Onde o agentes.chat está instalado, um usuário por agente.",
    );
  });

  test("paused until a time, until resumed, or not paused", async () => {
    const t = await translator("pt-BR");
    expect(pauseText(t, "pt-BR", { until: new Date(2026, 9, 28, 16, 0).toISOString() }, NOW)).toBe("Pausado até 16:00");
    expect(pauseText(t, "pt-BR", { until: null }, NOW)).toBe("Pausado");
    expect(pauseText(t, "pt-BR", { until: new Date(2026, 9, 28, 14, 0).toISOString() }, NOW)).toBeNull();
    expect(pauseText(t, "pt-BR", null, NOW)).toBeNull();
  });

  test("people's computers apart from the server's and the workspace's own", () => {
    const list = [machine({ id: "a" }), machine({ id: "h", kind: "host" }), machine({ id: "w", kind: "managed" })];
    expect(peoplesMachines(list).map((m) => m.id)).toEqual(["a"]);
  });

  describe("which computer each agent uses", () => {
    const mini = machine({ id: "mini", agents: [{ id: "infra", name: "Infra", handle: "infra" }] });
    const box = machine({ id: "box", os: "linux", pairedBy: { id: "u2", name: "Infra" } });
    const own = machine({ id: "own", kind: "managed", os: "", pairedBy: null });
    const machines = [mini, box, own];

    test("admins pick any computer", () => {
      const pick = agentComputerPick({
        agent: { id: "infra", ownerUserId: "u9" },
        meId: "u9",
        admin: true,
        machines,
        setup: null,
      });
      expect(pick).toMatchObject({ value: "mini", noComputer: null, canPick: true });
      expect(pick.choices.map((m) => m.id)).toEqual(["mini", "box", "own"]);
    });

    test("an agent's owner, the ones they connected (and the one it uses); anyone else only reads", () => {
      const owner = agentComputerPick({
        agent: { id: "infra", ownerUserId: "u2" },
        meId: "u2",
        admin: false,
        machines,
        setup: null,
      });
      expect(owner.choices.map((m) => m.id)).toEqual(["mini", "box"]);
      expect(owner.canPick).toBe(true);
      const member = agentComputerPick({
        agent: { id: "infra", ownerUserId: "u2" },
        meId: "u3",
        admin: false,
        machines,
        setup: null,
      });
      expect(member.canPick).toBe(false);
    });

    test("no computer: offered only for an agent that has none", () => {
      const pick = agentComputerPick({
        agent: { id: "dev", ownerUserId: null },
        meId: "u1",
        admin: true,
        machines,
        setup: null,
      });
      expect(pick).toMatchObject({ value: NO_COMPUTER, noComputer: "none" });
      expect(noComputerKey("none")).toBe("computer.target.none");
    });

    test("while the workspace's own computer is on its way, no computer stands for it", () => {
      const pick = agentComputerPick({
        agent: { id: "dev", ownerUserId: null },
        meId: "u1",
        admin: true,
        machines,
        setup: preparing(),
      });
      expect(pick.noComputer).toBe("workspace");
      expect(pick.choices.map((m) => m.id)).toEqual(["mini", "box"]);
      expect(noComputerKey("workspace")).toBe("computerSetup.title");
    });
  });

  test("taking things away: the confirmation's words, its button, the toast and the request", async () => {
    const t = await translator("pt-BR");
    expect(reduceTexts(t, { kind: "folder", path: "/Users/dev/Projects/loja/" })).toEqual({
      title: "Remover loja?",
      text: "Nenhum agente usa mais esta pasta neste computador. Para liberar de novo, só no próprio computador.",
      action: "Remover",
      done: "loja foi removida.",
      input: { removeFolder: { path: "/Users/dev/Projects/loja/" } },
    });
    expect(reduceTexts(t, { kind: "folder", path: "/srv/loja", agent: { id: "infra", name: "Infra" } }).input).toEqual({
      removeFolder: { path: "/srv/loja", agentId: "infra" },
    });
    expect(reduceTexts(t, { kind: "tool", tool: "browser" })).toMatchObject({
      title: "Desligar Navegador?",
      action: "Desligar",
      input: { disableTool: "browser" },
    });
  });

  test("allowing more happens on the computer, as its administrator in system mode", () => {
    expect(grantCommand({ mode: "single" }, "<pasta>", "<agente>")).toBe(
      "agentes-runner folders allow <pasta> --agent <agente>",
    );
    expect(grantCommand({ mode: "system" }, "<pasta>", "<agente>")).toBe(
      "sudo agentes-runner folders allow <pasta> --agent <agente>",
    );
  });
});

describe("Armazenamento", () => {
  const config: StorageConfig = {
    kind: "s3",
    s3: {
      endpoint: "https://s3.amazonaws.com",
      region: "us-east-1",
      bucket: "acme",
      prefix: null,
      pathStyle: false,
      accessKeyIdHint: "AKIA",
      secretHint: "x9z0",
    },
    migration: null,
    platform: { kind: "disk", folder: null },
  };

  test("the option's name by where the server runs", () => {
    expect(storageKey("s3", "cloud")).toBe("storage.s3");
    expect(storageKey("agentes", "cloud")).toBe("storage.agentes");
    expect(storageKey("agentes", "selfhost")).toBe("storage.server");
  });

  test("where this server keeps the files, by its folder when it says", async () => {
    const t = await translator("pt-BR");
    expect(platformText(t, { kind: "disk", folder: "/var/lib/agentes" })).toBe(
      "Os arquivos ficam em /var/lib/agentes.",
    );
    expect(platformText(t, { kind: "database", folder: null })).toBe("Os arquivos ficam no banco de dados dele.");
  });

  test("the option in use says what its files take, and on this server's disk what is free", async () => {
    const GB = 1024 ** 3;
    const [pt, en] = [await translator("pt-BR"), await translator("en")];
    const line = (t: typeof pt, lng: string, over: Partial<StorageConfig>) =>
      storageUsageLine(t, lng, { ...config, kind: "agentes", s3: null, ...over })?.replaceAll("\u00a0", " ");
    const usage = {
      platformBytes: 2.4 * GB,
      ownBucketBytes: 1.2 * GB,
      disk: { sizeBytes: 256 * GB, freeBytes: 38 * GB },
    };
    expect(line(pt, "pt-BR", { usage })).toBe("2,4 GB de arquivos · 38 GB livres no disco");
    expect(line(en, "en", { usage })).toBe("2.4 GB of files · 38 GB free on disk");
    // On its own bucket: what the bucket holds, and no disk.
    expect(line(pt, "pt-BR", { kind: "s3", usage })).toBe("1,2 GB de arquivos");
    // In this server's database or bucket, or on the Cloud: what the workspace keeps there.
    const held = (platformBytes: number) => ({ platformBytes, ownBucketBytes: 0, disk: null });
    expect(line(en, "en", { usage: held(300 * 1024 ** 2) })).toBe("300 MB of files");
    expect(line(pt, "pt-BR", { usage: held(0) })).toBe("Nenhum arquivo");
    expect(line(en, "en", { usage: { ...held(0), disk: { sizeBytes: 4096 * GB, freeBytes: 1536 * GB } } })).toBe(
      "No files · 1.5 TB free on disk",
    );
    // The Cloud keeps files on its own disk too, which every workspace there shares: its server sends no disk.
    const cloud = { platform: { kind: "disk" as const, folder: null } };
    expect(line(pt, "pt-BR", { ...cloud, usage: held(3.2 * GB) })).toBe("3,2 GB de arquivos");
    expect(line(en, "en", { ...cloud, usage: held(0) })).toBe("No files");
    // A first short document: bytes, plural in both languages.
    expect(line(en, "en", { usage: held(7) })).toBe("7 bytes of files");
    expect(line(pt, "pt-BR", { usage: held(820) })).toBe("820 bytes de arquivos");
    // A server from before it says nothing, and no line shows.
    expect(line(pt, "pt-BR", {})).toBeUndefined();
  });

  test("VoiceOver reads the line with its option: it is part of the row's label", () => {
    const src = (path: string) => readFileSync(join(import.meta.dir, "..", "..", "src", path), "utf8");
    expect(src("ui/Grouped.tsx")).toContain(
      'accessibilityLabel={[label, belowText, said, value].filter(Boolean).join(", ")}',
    );
    expect(src("features/settings/StorageScreen.tsx")).toContain("belowText: usage ?? undefined");
  });

  test("the form from the saved bucket, keys blank (kept), and what the server gets", () => {
    const form = s3FormOf(config);
    expect(form).toMatchObject({ bucket: "acme", prefix: "", accessKeyId: "", secretAccessKey: "" });
    expect(toS3Input(form)).toEqual({
      endpoint: "https://s3.amazonaws.com",
      region: "us-east-1",
      bucket: "acme",
      prefix: null,
      pathStyle: false,
    });
    const typed: S3Form = { ...form, prefix: " agentes/ ", accessKeyId: " AKIA2 ", secretAccessKey: "s3cr3t" };
    expect(toS3Input(typed)).toMatchObject({ prefix: "agentes/", accessKeyId: "AKIA2", secretAccessKey: "s3cr3t" });
  });

  test("a test needs the fields, and the keys unless saved ones stay", () => {
    expect(s3Missing(s3FormOf(undefined), false)).toEqual({ fields: true, keys: true, complete: false });
    expect(s3Missing(s3FormOf(config), true)).toEqual({ fields: false, keys: false, complete: true });
    expect(s3Missing({ ...s3FormOf(config), accessKeyId: "AKIA2" }, false).keys).toBe(true);
  });
});

test("the export's file name, as the web saves it", () => {
  expect(exportFileName(new Date("2026-10-28T12:00:00.000Z"))).toBe("agentes-chat-2026-10-28.json");
});

test("Auditoria's row screen: the call's title in words, and what the tool said only in the technical group", () => {
  const src = readFileSync(join(import.meta.dir, "..", "..", "src", "features", "settings", "AuditScreen.tsx"), "utf8");
  expect(src).toContain("title={auditHint(t, row) ?? auditPhrase(t, row)}");
  const tech = src.slice(src.indexOf('t("audit.panel.tech")'));
  expect(tech).toContain('label={t("audit.panel.techSaid")} sub={said}');
});
