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
  importSkillFromUrl,
  importSkillZip,
  listAgentScopes,
  listSkills,
  NotFoundError,
  parseSkillMarkdown,
  postPersonMessage,
  saveSkill,
  setAgentAccess,
  setAgentSkills,
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

/** A minimal zip writer (stored entries) for tests. */
function zip(files: Record<string, string>) {
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
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const skillDeps = () => ({ db: f.db, blobs: f.artifactDeps.blobs, resolveHost: async () => ["140.82.112.3"] });

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

  test("a GitHub folder URL, fetched within limits; non-GitHub and private addresses are refused", async () => {
    f = await setup();
    const fetched: string[] = [];
    const fake = async (url: string) => {
      fetched.push(url);
      if (url.startsWith("https://api.github.com/repos/acme/skills/contents/relatorio-semanal/templates")) {
        return Response.json([{ type: "file", path: "relatorio-semanal/templates/relatorio.md", size: 14 }]);
      }
      if (url.startsWith("https://api.github.com/repos/acme/skills/contents/relatorio-semanal")) {
        return Response.json([
          { type: "file", path: "relatorio-semanal/SKILL.md", size: SKILL_MD.length },
          { type: "file", path: "relatorio-semanal/build.py", size: 10 },
          { type: "dir", path: "relatorio-semanal/templates", size: 0 },
        ]);
      }
      if (url.endsWith("/relatorio-semanal/SKILL.md")) return new Response(SKILL_MD);
      if (url.endsWith("/templates/relatorio.md")) return new Response("# Semana {{n}}");
      if (url.endsWith("/relatorio-semanal/build.py")) return new Response("print(1)");
      return new Response("not found", { status: 404 });
    };
    const deps = { ...skillDeps(), fetch: fake };
    const url = "https://github.com/acme/skills/tree/main/relatorio-semanal";
    const skill = await importSkillFromUrl(deps, f.owner.id, f.org.id, url);
    expect(skill).toMatchObject({ name: "relatorio-semanal", source: "url", sourceUrl: url });
    expect(skill.files.map((x) => [x.path, x.status])).toEqual([
      ["build.py", "script"],
      ["templates/relatorio.md", "stored"],
    ]);
    // Scripts are kept for the agent's computer (never shown to the model).
    expect(fetched.some((u) => u.endsWith("build.py"))).toBe(true);

    await expect(importSkillFromUrl(deps, f.owner.id, f.org.id, "https://example.com/SKILL.md")).rejects.toThrow(
      "GitHub",
    );
    const privateDns = { ...deps, resolveHost: async () => ["10.0.0.7"] };
    await expect(importSkillFromUrl(privateDns, f.owner.id, f.org.id, url)).rejects.toBeInstanceOf(ValidationError);
  });

  test("images and videos are only listed, so they don't count toward 2 MB; text past 2 MB is still refused", async () => {
    f = await setup();
    // A repository shaped like a real one: a 31 MB video and screenshots next to 0.2 MB of Markdown.
    const fetched: string[] = [];
    const fake = async (url: string) => {
      fetched.push(url);
      if (url.startsWith("https://api.github.com/repos/acme/rcd/contents/assets")) {
        return Response.json([
          { type: "file", path: "assets/demo.mp4", size: 31_440_000 },
          { type: "file", path: "assets/shot.jpg", size: 670_000 },
        ]);
      }
      if (url.startsWith("https://api.github.com/repos/acme/rcd/contents/references")) {
        return Response.json([{ type: "file", path: "references/pricing.md", size: 9 }]);
      }
      if (url.startsWith("https://api.github.com/repos/acme/rcd/contents/")) {
        return Response.json([
          { type: "file", path: "SKILL.md", size: SKILL_MD.length },
          { type: "dir", path: "assets", size: 0 },
          { type: "dir", path: "references", size: 0 },
        ]);
      }
      if (url.endsWith("/SKILL.md")) return new Response(SKILL_MD);
      if (url.endsWith("/references/pricing.md")) return new Response("# Pricing");
      return new Response("not found", { status: 404 });
    };
    const skill = await importSkillFromUrl(
      { ...skillDeps(), fetch: fake },
      f.owner.id,
      f.org.id,
      "https://github.com/acme/rcd",
    );
    expect(skill.files.map((x) => [x.path, x.status])).toEqual([
      ["assets/demo.mp4", "ignored"],
      ["assets/shot.jpg", "ignored"],
      ["references/pricing.md", "stored"],
    ]);
    expect(fetched.filter((u) => /\.(mp4|jpg)$/.test(u))).toEqual([]);

    const bigText = async (url: string) =>
      url.includes("/contents/")
        ? Response.json([
            { type: "file", path: "SKILL.md", size: SKILL_MD.length },
            { type: "file", path: "book.md", size: 2_200_000 },
          ])
        : new Response(SKILL_MD);
    await expect(
      importSkillFromUrl({ ...skillDeps(), fetch: bigText }, f.owner.id, f.org.id, "https://github.com/acme/book"),
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
