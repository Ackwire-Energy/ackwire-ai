import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  createOrganization,
  deleteSkill,
  drainOutbox,
  enabledSkills,
  getSkill,
  getSkillFile,
  importPickedSkills,
  importSkillFromUrl,
  importSkillZip,
  listAgentScopes,
  listSkills,
  NotFoundError,
  parseSkillMarkdown,
  postPersonMessage,
  SKILL_LIMITS,
  saveSkill,
  setAgentAccess,
  setAgentSkills,
  type TooManyError,
  ValidationError,
} from "../src";
import { toolDetail } from "../src/tool-detail";
import { addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const SKILL_MD = `---
name: relatorio-semanal
description: >
  Escreve o relatório semanal do time
  no formato da empresa.
license: MIT
allowed-tools:
  - create_artifact
---
# Relatório semanal

1. Junte as entregas da semana.
2. Use o modelo em templates/relatorio.md.
`;

/**
 * A minimal zip writer (stored entries) for tests. `zip64`: the end record as git archive writes it past 65,535 files,
 * its count at the maximum and the real values in a zip64 record before it.
 */
function zip(files: Record<string, string>, options: { zip64?: boolean } = {}) {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = enc.encode(path);
    const data = enc.encode(text);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const zip64: Uint8Array[] = [];
  if (options.zip64) {
    const record = new Uint8Array(56);
    const rv = new DataView(record.buffer);
    rv.setUint32(0, 0x06064b50, true);
    rv.setBigUint64(4, 44n, true);
    rv.setBigUint64(24, BigInt(centrals.length), true);
    rv.setBigUint64(32, BigInt(centrals.length), true);
    rv.setBigUint64(40, BigInt(centralSize), true);
    rv.setBigUint64(48, BigInt(offset), true);
    const locator = new Uint8Array(20);
    const lv = new DataView(locator.buffer);
    lv.setUint32(0, 0x07064b50, true);
    lv.setBigUint64(8, BigInt(offset + centralSize), true);
    lv.setUint32(16, 1, true);
    zip64.push(record, locator);
  }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, Math.min(centrals.length, 0xffff), true);
  ev.setUint16(10, Math.min(centrals.length, 0xffff), true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, ...zip64, eocd];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const skillDeps = () => ({ db: f.db, blobs: f.artifactDeps.blobs, resolveHost: async () => ["140.82.112.3"] });

/** acme/skills as its archive holds it: under the archive's own folder, a skill with a skill inside, two more. */
const REPOSITORY = {
  "skills-main/README.md": "# Skills",
  "skills-main/docs/guide.md": "# Guia",
  "skills-main/relatorio-semanal/SKILL.md": SKILL_MD,
  "skills-main/relatorio-semanal/templates/relatorio.md": "# Semana {{n}}",
  "skills-main/relatorio-semanal/build.py": "print(1)",
  "skills-main/relatorio-semanal/logo.png": "PNG",
  "skills-main/relatorio-semanal/examples/inner/SKILL.md": "---\nname: inner\ndescription: Um exemplo.\n---\nx",
  "skills-main/team/deploy/SKILL.md": "---\nname: deploy\ndescription: Antes de qualquer deploy.\n---\n# Deploy",
  "skills-main/team/review/SKILL.md": "---\nname: review\ndescription: Revisa um pull request.\n---\n# Review",
};

/**
 * Fake GitHub: github.com redirects acme/skills' archive (`archive`, else REPOSITORY's) to codeload (a branch by name,
 * the default branch by its commit), which sends it; anything else is a 404. `limited`: every answer is GitHub
 * limiting us, with these headers.
 */
function fakeGithub(
  options: { redirect?: string; limited?: Record<string, string>; status?: number; archive?: Uint8Array } = {},
) {
  const fetched: string[] = [];
  const fetch = async (url: string) => {
    fetched.push(url);
    if (options.limited) return new Response("slow down", { status: options.status ?? 429, headers: options.limited });
    const ref = /^https:\/\/github\.com\/acme\/skills\/archive\/(.+)\.zip$/.exec(url)?.[1];
    if (ref) {
      const at = ref === "HEAD" ? "0123abc" : ref === "main" ? "refs/heads/main" : ref;
      const location = options.redirect ?? `https://codeload.github.com/acme/skills/zip/${at}`;
      return new Response(null, { status: 302, headers: { location } });
    }
    if (/^https:\/\/codeload\.github\.com\/acme\/skills\/zip\/(refs\/heads\/main|0123abc)$/.test(url)) {
      return new Response(options.archive ?? zip(REPOSITORY));
    }
    return new Response("404: Not Found", { status: 404 });
  };
  return { fetch, fetched };
}

describe("SKILL.md", () => {
  test("frontmatter and body; other fields kept; name and description validated", () => {
    const s = parseSkillMarkdown(SKILL_MD);
    expect(s).toMatchObject({
      name: "relatorio-semanal",
      description: "Escreve o relatório semanal do time no formato da empresa.",
      metadata: { license: "MIT", "allowed-tools": ["create_artifact"] },
    });
    expect(s.body.startsWith("# Relatório semanal")).toBe(true);
    expect(() => parseSkillMarkdown("# no frontmatter")).toThrow(ValidationError);
    expect(() => parseSkillMarkdown("---\nname: Relatorio Semanal\ndescription: x\n---\nbody")).toThrow("kebab-case");
    expect(() => parseSkillMarkdown(`---\nname: ok\ndescription: ${"x".repeat(1025)}\n---\nbody`)).toThrow("1024");
    expect(() => parseSkillMarkdown(`---\nname: ${"a".repeat(65)}\ndescription: x\n---\nb`)).toThrow("64");
  });

  test("nested YAML survives (OpenClaw and Hermes metadata, multi-line blocks); YAML that isn't is read by line", () => {
    const openclaw = parseSkillMarkdown(`---
name: github-triage
description: |
  Triage new issues.
  Label and assign them.
metadata:
  openclaw:
    emoji: "🦞"
    requires:
      bins: [gh]
      env:
        - GITHUB_TOKEN
    user-invocable: true
  hermes:
    tags: [github, triage]
---
Body.`);
    expect(openclaw.description).toBe("Triage new issues.\nLabel and assign them.");
    expect(openclaw.metadata).toEqual({
      metadata: {
        openclaw: { emoji: "🦞", requires: { bins: ["gh"], env: ["GITHUB_TOKEN"] }, "user-invocable": true },
        hermes: { tags: ["github", "triage"] },
      },
    });
    // Not YAML (a second colon), as many published skills are: the line reading, as before.
    const loose = parseSkillMarkdown("---\nname: pdf\ndescription: Use when: the user sends a PDF\n---\nBody.");
    expect(loose.description).toBe("Use when: the user sends a PDF");
    // YAML would make these a boolean and a number: the text as written.
    expect(parseSkillMarkdown("---\nname: yes-no\ndescription: Yes\n---\nb").description).toBe("Yes");
    // Aliases that expand past the budget are refused as YAML (then read by line: no nested fields).
    const bomb = ["a: &a [x, x, x, x, x, x, x, x, x, x]", "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]"];
    bomb.push("c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]", "d: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]");
    const expanded = parseSkillMarkdown(`---\nname: bomb\ndescription: x\n${bomb.join("\n")}\n---\nb`);
    expect(Array.isArray(expanded.metadata.d)).toBe(false);
  });
});

describe("import", () => {
  test("a zip of the folder: SKILL.md + text files stored, scripts kept as scripts, binaries ignored", async () => {
    f = await setup();
    const skill = await importSkillZip(
      skillDeps(),
      f.owner.id,
      f.org.id,
      zip({
        "relatorio-semanal/SKILL.md": SKILL_MD,
        "relatorio-semanal/templates/relatorio.md": "# Semana {{n}}",
        "relatorio-semanal/scripts/build.py": "print('no')",
        "relatorio-semanal/run.sh": "rm -rf /",
        "relatorio-semanal/logo.png": "PNG",
      }),
    );
    expect(skill).toMatchObject({ name: "relatorio-semanal", version: 1, source: "upload" });
    expect(skill.files.map((x) => [x.path, x.status])).toEqual([
      ["logo.png", "ignored"],
      ["run.sh", "script"],
      ["scripts/build.py", "script"],
      ["templates/relatorio.md", "stored"],
    ]);
    const audit = await f.db.select().from(schema.auditLog);
    expect(audit.some((a) => a.action === "skill.installed")).toBe(true);
    // The same name again is a new version.
    const again = await saveSkill(skillDeps(), f.owner.id, f.org.id, {
      ...parseSkillMarkdown(SKILL_MD),
      source: "manual",
    });
    expect(again.version).toBe(2);
  });

  test("two files that collapse to one path are refused (no shared blob key, no undercounted size)", async () => {
    f = await setup();
    // `a.md` and `./a.md` both normalize to `a.md`: without the guard the big one overwrites the small one
    // on disk while its row is dropped, so the metered size (1 byte) no longer matches 100 KB on disk.
    await expect(
      importSkillZip(
        skillDeps(),
        f.owner.id,
        f.org.id,
        zip({ "SKILL.md": SKILL_MD, "a.md": "x", "./a.md": "y".repeat(100_000) }),
      ),
    ).rejects.toThrow(/share the path/);
  });

  test("a skill's folder link: the repository's archive, through codeload's redirect, never the REST API", async () => {
    f = await setup();
    const github = fakeGithub();
    const deps = { ...skillDeps(), fetch: github.fetch };
    const url = "https://github.com/acme/skills/tree/main/relatorio-semanal";
    const skill = await importSkillFromUrl(deps, f.owner.id, f.org.id, url);
    expect(skill).toMatchObject({ name: "relatorio-semanal", source: "url", sourceUrl: url });
    expect("files" in skill && skill.files.map((x) => [x.path, x.status])).toEqual([
      ["build.py", "script"],
      ["examples/inner/SKILL.md", "stored"],
      ["logo.png", "ignored"],
      ["templates/relatorio.md", "stored"],
    ]);
    expect(github.fetched).toEqual([
      "https://github.com/acme/skills/archive/main.zip",
      "https://codeload.github.com/acme/skills/zip/refs/heads/main",
    ]);

    // A file in the folder, its SKILL.md included, is the folder: the same skill again, with its files.
    const again = await importSkillFromUrl(
      deps,
      f.owner.id,
      f.org.id,
      "https://github.com/acme/skills/blob/main/relatorio-semanal/SKILL.md",
    );
    expect(again).toMatchObject({ name: "relatorio-semanal", version: 2 });
    expect("files" in again && again.files.map((x) => x.path)).toContain("templates/relatorio.md");
    expect(github.fetched.filter((u) => /api\.github\.com|raw\.githubusercontent\.com/.test(u))).toEqual([]);

    await expect(importSkillFromUrl(deps, f.owner.id, f.org.id, "https://example.com/SKILL.md")).rejects.toThrow(
      "GitHub",
    );
    const privateDns = { ...deps, resolveHost: async () => ["10.0.0.7"] };
    await expect(importSkillFromUrl(privateDns, f.owner.id, f.org.id, url)).rejects.toBeInstanceOf(ValidationError);
    // A redirect off GitHub is refused like a link off GitHub.
    const away = fakeGithub({ redirect: "https://example.com/acme.zip" });
    await expect(importSkillFromUrl({ ...skillDeps(), fetch: away.fetch }, f.owner.id, f.org.id, url)).rejects.toThrow(
      "Only GitHub URLs",
    );
    expect(away.fetched.some((u) => u.includes("example.com"))).toBe(false);
  });

  test("a repository holding several skills lists them by name and description; the picked ones install", async () => {
    f = await setup();
    const github = fakeGithub();
    const deps = { ...skillDeps(), fetch: github.fetch };
    const url = "https://github.com/acme/skills";
    const listed = await importSkillFromUrl(deps, f.owner.id, f.org.id, url);
    // The SKILL.md inside relatorio-semanal is one of its files, not a skill; nothing is installed yet.
    expect(listed).toEqual({
      choices: [
        { path: "relatorio-semanal", name: "relatorio-semanal", description: expect.stringContaining("semanal") },
        { path: "team/deploy", name: "deploy", description: "Antes de qualquer deploy." },
        { path: "team/review", name: "review", description: "Revisa um pull request." },
      ],
    });
    expect(await listSkills(f.db, f.owner.id, f.org.id)).toEqual([]);
    expect(github.fetched).toEqual([
      "https://github.com/acme/skills/archive/HEAD.zip",
      "https://codeload.github.com/acme/skills/zip/0123abc",
    ]);

    const installed = await importPickedSkills(deps, f.owner.id, f.org.id, url, ["team/deploy", "relatorio-semanal"]);
    expect(installed.map((s) => [s.name, s.sourceUrl])).toEqual([
      ["deploy", "https://github.com/acme/skills/tree/HEAD/team/deploy"],
      ["relatorio-semanal", "https://github.com/acme/skills/tree/HEAD/relatorio-semanal"],
    ]);
    expect(installed[1]?.files.map((x) => x.path)).toContain("examples/inner/SKILL.md");
    expect((await listSkills(f.db, f.owner.id, f.org.id)).map((s) => s.name)).toEqual(["deploy", "relatorio-semanal"]);
    await expect(importPickedSkills(deps, f.owner.id, f.org.id, url, ["docs"])).rejects.toThrow("no skill at docs");
    // A folder holding skills lists only its own.
    const team = await importSkillFromUrl(deps, f.owner.id, f.org.id, "https://github.com/acme/skills/tree/main/team");
    expect("choices" in team && team.choices.map((c) => c.path)).toEqual(["team/deploy", "team/review"]);
    expect(github.fetched.filter((u) => /api\.github\.com|raw\.githubusercontent\.com/.test(u))).toEqual([]);
  });

  test("the skills a link holds that can't be installed are listed apart with why, never offered", async () => {
    f = await setup();
    const md = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}`;
    const archive = zip({
      "skills-main/fonts/SKILL.md": md("fonts", "Desenha com as fontes da marca."),
      "skills-main/fonts/brand.svg": "x".repeat(SKILL_LIMITS.maxBytes),
      "skills-main/good/SKILL.md": md("good", "Funciona."),
      "skills-main/long/SKILL.md": md("long", "x".repeat(1100)),
    });
    const deps = { ...skillDeps(), fetch: fakeGithub({ archive }).fetch };
    const url = "https://github.com/acme/skills";
    expect(await importSkillFromUrl(deps, f.owner.id, f.org.id, url)).toEqual({
      choices: [{ path: "good", name: "good", description: "Funciona." }],
      skipped: [
        { path: "fonts", code: "skill.too_large", message: "The skill is too large (max 2 MB)", params: { max: 2 } },
        {
          path: "long",
          code: "skill.invalid_description",
          message: "description: 1 to 1024 characters",
          params: { max: 1024 },
        },
      ],
    });
    await expect(importPickedSkills(deps, f.owner.id, f.org.id, url, ["good", "long"])).rejects.toThrow(
      "long: description",
    );
    expect(await listSkills(f.db, f.owner.id, f.org.id)).toEqual([]);
  });

  test("a repository of 40,000 one-file skill folders is refused for holding too many in a moment", async () => {
    f = await setup();
    const files: Record<string, string> = {};
    for (let i = 0; i < 40_000; i++) files[`skills-main/s${i}/SKILL.md`] = `---\nname: s${i}\ndescription: x\n---\n`;
    const deps = { ...skillDeps(), fetch: fakeGithub({ archive: zip(files) }).fetch };
    const started = Date.now();
    const refusal = await importSkillFromUrl(deps, f.owner.id, f.org.id, "https://github.com/acme/skills").catch(
      (e: ValidationError) => e,
    );
    expect(refusal).toMatchObject({ code: "skill.too_many_skills" });
    // Every folder found looked up among those above it, never compared with each skill found before it.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a repository archive past 65,535 files is refused, never read in part", async () => {
    f = await setup();
    const files: Record<string, string> = {};
    for (let i = 0; i < 65_500; i++) files[`skills-main/aaa/f${i}.txt`] = "x";
    files["skills-main/big/SKILL.md"] = "---\nname: big\ndescription: Muitos arquivos.\n---\n# Big";
    for (let i = 0; i < 100; i++) files[`skills-main/big/f${i}.md`] = "y";
    const deps = { ...skillDeps(), fetch: fakeGithub({ archive: zip(files, { zip64: true }) }).fetch };
    const url = "https://github.com/acme/skills/tree/main/big";
    await expect(importSkillFromUrl(deps, f.owner.id, f.org.id, url)).rejects.toThrow("Too many files to read");
    expect(await listSkills(f.db, f.owner.id, f.org.id)).toEqual([]);
  });

  test("errors say what happened: a hidden repository, a missing ref, GitHub limiting us, no SKILL.md", async () => {
    f = await setup();
    const refusal = async (url: string, github = fakeGithub()) => {
      const err = await importSkillFromUrl({ ...skillDeps(), fetch: github.fetch }, f.owner.id, f.org.id, url).then(
        () => null,
        (e: ValidationError | TooManyError) => e,
      );
      return { kind: err?.constructor.name, code: err?.code, params: err?.params };
    };
    expect(await refusal("https://github.com/acme/secret/tree/main/x")).toEqual({
      kind: "ValidationError",
      code: "github.repo_missing",
      params: { repo: "acme/secret" },
    });
    expect(await refusal("https://github.com/acme/skills/tree/v9/relatorio-semanal")).toEqual({
      kind: "ValidationError",
      code: "github.ref_missing",
      params: { repo: "acme/skills", ref: "v9" },
    });
    expect(await refusal("https://github.com/acme/skills/tree/main/docs")).toEqual({
      kind: "ValidationError",
      code: "skill.no_skill_md",
      params: { path: "acme/skills/docs" },
    });
    expect(await refusal("https://github.com/acme/skills", fakeGithub({ limited: { "retry-after": "120" } }))).toEqual({
      kind: "TooManyError",
      code: "github.limited",
      params: { count: 2 },
    });
    // The REST API's way: a 403 with none remaining until the reset.
    const reset = String(Math.floor(Date.now() / 1000) + 290);
    const spent = fakeGithub({ limited: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, status: 403 });
    expect(await refusal("https://github.com/acme/skills", spent)).toMatchObject({ params: { count: 5 } });
  });

  test("images and videos are only listed, so they don't count toward 2 MB; text past 2 MB is still refused", async () => {
    f = await setup();
    // A repository shaped like a real one: a video and screenshots past 2 MB next to a little Markdown.
    const url = "https://github.com/acme/skills";
    const media = zip({
      "skills-main/SKILL.md": SKILL_MD,
      "skills-main/assets/demo.mp4": "x".repeat(2_200_000),
      "skills-main/assets/shot.jpg": "x".repeat(670_000),
      "skills-main/references/pricing.md": "# Pricing",
    });
    const skill = await importSkillFromUrl(
      { ...skillDeps(), fetch: fakeGithub({ archive: media }).fetch },
      f.owner.id,
      f.org.id,
      url,
    );
    expect("files" in skill && skill.files.map((x) => [x.path, x.status])).toEqual([
      ["assets/demo.mp4", "ignored"],
      ["assets/shot.jpg", "ignored"],
      ["references/pricing.md", "stored"],
    ]);

    const book = zip({ "skills-main/SKILL.md": SKILL_MD, "skills-main/book.md": "x".repeat(2_200_000) });
    await expect(
      importSkillFromUrl({ ...skillDeps(), fetch: fakeGithub({ archive: book }).fetch }, f.owner.id, f.org.id, url),
    ).rejects.toThrow("too large");

    // The same in a zip: a big image is listed and never inflated, a big text file is refused.
    const zipped = await importSkillZip(
      skillDeps(),
      f.owner.id,
      f.org.id,
      zip({ "SKILL.md": SKILL_MD, "assets/shot.png": "x".repeat(2_200_000) }),
    );
    expect(zipped.files.map((x) => [x.path, x.status])).toEqual([["assets/shot.png", "ignored"]]);
    await expect(
      importSkillZip(
        skillDeps(),
        f.owner.id,
        f.org.id,
        zip({ "SKILL.md": SKILL_MD, "book.md": "x".repeat(2_200_000) }),
      ),
    ).rejects.toThrow("too large");
  });
});

describe("runtime", () => {
  test("the prompt lists only the agent's enabled skills; load_skill returns the body; read_skill_file a file", async () => {
    let step = 0;
    f = await setup({
      skillTools: true,
      reply: (req: ModelRequest) => {
        step++;
        if (step === 1) return { chunks: [], toolUses: [{ name: "load_skill", input: { name: "relatorio-semanal" } }] };
        if (step === 2)
          return {
            chunks: [],
            toolUses: [
              { name: "read_skill_file", input: { name: "relatorio-semanal", path: "templates/relatorio.md" } },
            ],
          };
        if (step === 3)
          return {
            chunks: [],
            toolUses: [{ name: "read_skill_file", input: { name: "relatorio-semanal", path: "run.sh" } }],
          };
        return { chunks: [JSON.stringify(req.messages.length)] };
      },
    });
    expect((await listAgentScopes(f.db, f.org.id, f.agent.id)).map((g) => g.scope)).toContain("skills:read");
    const mine = await importSkillZip(
      skillDeps(),
      f.owner.id,
      f.org.id,
      zip({ "SKILL.md": SKILL_MD, "templates/relatorio.md": "# Semana {{n}}", "run.sh": "echo" }),
    );
    await saveSkill(skillDeps(), f.owner.id, f.org.id, {
      name: "outra-skill",
      description: "Não é deste agente.",
      body: "x",
      metadata: {},
      source: "manual",
    });
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: mine.id, enabled: true }]);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev faz o relatório semanal",
    });
    await drainOutbox(f.db, f.handlers);

    const prompt = systemText(f.provider.calls[0]?.request.system ?? "");
    expect(prompt).toContain("# Available skills");
    expect(prompt).toContain("- relatorio-semanal: Escreve o relatório semanal");
    expect(prompt).not.toContain("outra-skill");
    const results = (await f.db.select().from(schema.agentRunSteps))
      .filter((s) => s.kind === "tool_result")
      .map((s) => s.data as { name: string; content: string; isError: boolean });
    expect(results[0]).toMatchObject({ name: "load_skill", isError: false });
    expect(results[0]?.content).toContain('Skill "relatorio-semanal" (v1) loaded.');
    expect(results[0]?.content).toContain("1. Junte as entregas da semana.");
    expect(results[0]?.content).toContain("run.sh (script: runs with run_skill_script");
    expect(results[0]?.content).not.toContain("echo");
    expect(results[1]).toMatchObject({ name: "read_skill_file", isError: false });
    expect(results[1]?.content).toContain("# Semana {{n}}");
    expect(results[2]).toMatchObject({ name: "read_skill_file", isError: true });
  });

  test("denying the tools hides them; other orgs never see the skill", async () => {
    f = await setup({ skillTools: true, reply: () => ({ chunks: ["ok"] }) });
    const skill = await importSkillZip(skillDeps(), f.owner.id, f.org.id, zip({ "SKILL.md": SKILL_MD }));
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: skill.id, enabled: true }]);
    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, {
      all: true,
      connectors: {},
      scopes: [],
      tools: {
        allow: [],
        deny: [
          { connectionId: null, name: "load_skill" },
          { connectionId: null, name: "read_skill_file" },
        ],
      },
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, f.handlers);
    const request = f.provider.calls[0]?.request;
    expect(request?.tools?.map((t) => t.name) ?? []).not.toContain("load_skill");
    expect(systemText(request?.system ?? "")).not.toContain("# Available skills");

    const other = await addUser(f.db, "zed");
    const { organization } = await createOrganization(f.db, other.id, { name: "Outra" });
    await expect(getSkill(f.db, other.id, organization.id, skill.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: crypto.randomUUID(), enabled: true }]),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("files, counts and delete", () => {
  const folder = {
    "relatorio-semanal/SKILL.md": SKILL_MD,
    "relatorio-semanal/templates/relatorio.md": "# Semana {{n}}",
    "relatorio-semanal/run.sh": "echo no",
  };

  test("a stored file by version; ignored files are 404", async () => {
    f = await setup();
    const v1 = await importSkillZip(skillDeps(), f.owner.id, f.org.id, zip(folder));
    await importSkillZip(
      skillDeps(),
      f.owner.id,
      f.org.id,
      zip({ ...folder, "relatorio-semanal/templates/relatorio.md": "# Semana v2" }),
    );
    const current = await getSkillFile(skillDeps(), f.owner.id, f.org.id, v1.id, "templates/relatorio.md");
    expect(current).toMatchObject({ version: 2, mime: "text/markdown", content: "# Semana v2" });
    const old = await getSkillFile(skillDeps(), f.owner.id, f.org.id, v1.id, "templates/relatorio.md", 1);
    expect(old.content).toBe("# Semana {{n}}");
    await expect(getSkillFile(skillDeps(), f.owner.id, f.org.id, v1.id, "run.sh")).rejects.toThrow(/script/);
    await expect(getSkillFile(skillDeps(), f.owner.id, f.org.id, v1.id, "run.sh")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(getSkillFile(skillDeps(), f.owner.id, f.org.id, v1.id, "nope.md")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  test("agentsCount; deleting keeps assignments and the same name again brings them back", async () => {
    f = await setup();
    const skill = await importSkillZip(skillDeps(), f.owner.id, f.org.id, zip(folder));
    expect((await listSkills(f.db, f.owner.id, f.org.id))[0]).toMatchObject({ id: skill.id, agentsCount: 0 });
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: skill.id, enabled: true }]);
    expect((await listSkills(f.db, f.owner.id, f.org.id))[0]?.agentsCount).toBe(1);

    await deleteSkill(f.db, f.owner.id, f.org.id, skill.id);
    expect(await listSkills(f.db, f.owner.id, f.org.id)).toEqual([]);
    expect(await enabledSkills(f.db, f.org.id, f.agent.id)).toEqual([]);
    await expect(getSkill(f.db, f.owner.id, f.org.id, skill.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await f.db.select().from(schema.agentSkills)).toHaveLength(1);

    const back = await saveSkill(skillDeps(), f.owner.id, f.org.id, {
      ...parseSkillMarkdown(SKILL_MD),
      source: "manual",
    });
    expect(back).toMatchObject({ id: skill.id, version: 2 });
    expect((await enabledSkills(f.db, f.org.id, f.agent.id)).map((s) => s.id)).toEqual([skill.id]);
    expect((await listSkills(f.db, f.owner.id, f.org.id))[0]?.agentsCount).toBe(1);
    const audit = await f.db.select().from(schema.auditLog);
    expect(audit.some((a) => a.action === "skill.restored")).toBe(true);
  });
});

describe("agent.tool detail", () => {
  test("only the safe field of built-in tools, ≤ 80 chars", () => {
    expect(toolDetail("load_skill", { name: "relatorio-semanal" })).toBe("relatorio-semanal");
    expect(toolDetail("read_skill_file", { name: "relatorio-semanal", path: "templates/a.md" })).toBe(
      "relatorio-semanal/templates/a.md",
    );
    expect(toolDetail("create_issue", { title: "Corrigir login", body: "segredo" })).toBe("Corrigir login");
    expect(toolDetail("update_issue", { issue: "131", status: "done" })).toBe("#131");
    expect(toolDetail("comment_issue", { issue: "#7", text: "x" })).toBe("#7");
    expect(toolDetail("create_artifact", { title: "Relatório Q3", content: "..." })).toBe("Relatório Q3");
    expect(toolDetail("create_issue", { title: "a".repeat(200) })?.length).toBe(80);
    expect(toolDetail("search_context", { query: "salários" })).toBeUndefined();
    expect(toolDetail("load_skill", { name: 42 })).toBeUndefined();
  });
});
