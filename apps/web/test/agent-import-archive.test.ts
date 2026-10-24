import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ImportError, parseImport, readImportFiles } from "@/lib/import";
import { ARCHIVE_LIMITS } from "@/lib/import/archive";

/** Archives built here from the fixture folders (fixtures/agent-import/NOTICE.md). */
const DIR = join(import.meta.dir, "fixtures", "agent-import");
const enc = new TextEncoder();
const folderFiles = (name: string): Record<string, string> =>
  Object.fromEntries(
    (readdirSync(join(DIR, name), { recursive: true }) as string[])
      .filter((p) => statSync(join(DIR, name, p)).isFile())
      .sort()
      .map((p) => [p.replace(/\\/g, "/"), readFileSync(join(DIR, name, p), "utf8")]),
  );

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

interface TarEntry {
  name: string;
  data?: string | Uint8Array;
  /** ustar type flag: "0" file, "2" symlink, "5" folder, "x" pax header. */
  type?: string;
  link?: string;
}

/** A ustar archive, as `tar` and Python's `tarfile` write it. */
function tar(entries: TarEntry[], { checksum = true } = {}) {
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    const data = typeof e.data === "string" ? enc.encode(e.data) : (e.data ?? new Uint8Array());
    const h = new Uint8Array(512);
    const put = (at: number, s: string) => h.set(enc.encode(s), at);
    put(0, e.name);
    put(100, "0000644\0");
    put(108, "0000000\0");
    put(116, "0000000\0");
    put(124, `${data.length.toString(8).padStart(11, "0")}\0`);
    put(136, "00000000000\0");
    put(148, "        ");
    put(156, e.type ?? "0");
    if (e.link) put(157, e.link);
    put(257, "ustar\0");
    put(263, "00");
    const sum = h.reduce((a, b) => a + b, 0) + (checksum ? 0 : 1);
    put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return concat(blocks);
}

/** A pax header record for a path longer than the 100 bytes of a ustar name. */
function paxPath(path: string): TarEntry {
  const body = ` path=${path}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length++;
  return { name: "PaxHeader/long", type: "x", data: `${length}${body}` };
}

/** A .zip with stored entries; `sizes` can lie about an entry's unpacked size, as a zip bomb does. */
function zip(files: Record<string, string | Uint8Array>, sizes: Record<string, number> = {}) {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number) => [v & 255, (v >> 8) & 255];
  const u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  for (const [name, content] of Object.entries(files)) {
    const n = enc.encode(name);
    const d = typeof content === "string" ? enc.encode(content) : content;
    const size = sizes[name] ?? d.length;
    const local = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0x800),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(d.length),
      ...u32(size),
      ...u16(n.length),
      ...u16(0),
    ]);
    parts.push(local, n, d);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0x800),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(d.length),
        ...u32(size),
        ...u16(n.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
      ]),
      n,
    );
    offset += local.length + n.length + d.length;
  }
  const cd = concat(central);
  const count = Object.keys(files).length;
  const end = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(count),
    ...u16(count),
    ...u32(cd.length),
    ...u32(offset),
    ...u16(0),
  ]);
  return concat([...parts, cd, end]);
}

const archive = (bytes: Uint8Array, name: string) => new File([bytes.slice()], name);
const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (err) {
    return err instanceof ImportError ? err.code : String(err);
  }
  return null;
};
/** Runs with lower limits, then puts them back. */
async function withLimits<T>(limits: Partial<typeof ARCHIVE_LIMITS>, run: () => Promise<T>): Promise<T> {
  const saved = { ...ARCHIVE_LIMITS };
  Object.assign(ARCHIVE_LIMITS, limits);
  try {
    return await run();
  } finally {
    Object.assign(ARCHIVE_LIMITS, saved);
  }
}

describe("archives", () => {
  test("a Hermes profile export (.tar.gz): the root folder names the profile; links are listed, never followed", async () => {
    const profile = folderFiles("hermes-profile");
    const longPath = `skills/${"deep/".repeat(22)}notes.md`;
    const entries: TarEntry[] = [
      { name: "research-bot/", type: "5" },
      ...Object.entries(profile).map(([name, data]) => ({ name: `research-bot/${name}`, data })),
      { name: "research-bot/.env", data: "OPENAI_API_KEY=archive-dotenv-value" },
      { name: "research-bot/state.db", data: new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0, 1, 2, 3]) },
      { name: "research-bot/escape.md", type: "2", link: "../../.ssh/id_rsa" },
      paxPath(`research-bot/${longPath}`),
      { name: "research-bot/placeholder", data: "Read later." },
    ];
    const { files, root } = await readImportFiles([archive(Bun.gzipSync(tar(entries)), "research-bot.tar.gz")]);
    expect(root).toBe("research-bot");
    const text = Object.fromEntries(files.map((f) => [f.name, f.text]));
    expect(text["SOUL.md"]).toBe(profile["SOUL.md"]);
    expect(text[longPath]).toBe("Read later.");
    // Never read: a credential store, a database, a link.
    expect(text[".env"]).toBe("");
    expect(text["state.db"]).toBe("");
    expect(text["escape.md"]).toBe("");

    const bundle = parseImport(files, { root });
    expect(bundle.source.app).toBe("hermes");
    expect(bundle.agents.map((a) => [a.key, a.name])).toEqual([["research-bot", "Research Bot"]]);
    expect(bundle.leftOut).toContainEqual({ kind: "secret", label: ".env" });
    expect(bundle.leftOut).toContainEqual({ kind: "file", label: "escape.md" });
    expect(JSON.stringify(bundle)).not.toContain("archive-dotenv-value");
  });

  test("a .zip with its folder inside: macOS leftovers skipped, binaries and credential files not read", async () => {
    const files = {
      "openbot-export/openbot-import.json": readFileSync(join(DIR, "openbot-run/openbot-import.json"), "utf8"),
      "openbot-export/agents/scout/skills/price-watch/SKILL.md": readFileSync(
        join(DIR, "openbot-run/agents/scout/skills/price-watch/SKILL.md"),
        "utf8",
      ),
      "openbot-export/agents/scout/avatar.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
      "openbot-export/agents/scout/files/auth.json": '{"token":"zip-auth-value"}',
      "openbot-export/.DS_Store": "junk",
      "__MACOSX/openbot-export/._openbot-import.json": "junk",
    };
    const read = await readImportFiles([archive(zip(files), "openbot-export-2026-10-18.zip")]);
    expect(read.root).toBe("openbot-export");
    expect(read.files.map((f) => [f.name, f.text.length > 0])).toEqual([
      ["openbot-import.json", true],
      ["agents/scout/skills/price-watch/SKILL.md", true],
      ["agents/scout/avatar.png", false],
      ["agents/scout/files/auth.json", false],
    ]);
    const bundle = parseImport(read.files, { root: read.root });
    expect(bundle.agents.map((a) => a.key)).toEqual(["scout", "closer"]);
    expect(bundle.leftOut).toContainEqual({ kind: "secret", label: "agents/scout/files/auth.json" });
    expect(JSON.stringify(bundle)).not.toContain("zip-auth-value");
  });

  test("an archive whose top folder is part of the format keeps it", async () => {
    const files = folderFiles("paperclip-company");
    const agentsOnly = Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith("agents/")));
    const read = await readImportFiles([archive(zip(agentsOnly), "agents.zip")]);
    expect(read.root).toBeNull();
    expect(read.files.map((f) => f.name)).toEqual(Object.keys(agentsOnly));
    expect(parseImport(read.files).source.app).toBe("paperclip");
  });

  test("paths that leave the archive, or are absolute, refuse it", async () => {
    const climb = tar([{ name: "profile/../../outside.md", data: "x" }]);
    expect(await failure(() => readImportFiles([archive(Bun.gzipSync(climb), "a.tgz")]))).toBe("unsafe");
    const absolute = tar([{ name: "/etc/hosts.md", data: "x" }]);
    expect(await failure(() => readImportFiles([archive(absolute, "a.tar")]))).toBe("unsafe");
    expect(await failure(() => readImportFiles([archive(zip({ "C:/Users/x/SOUL.md": "x" }), "a.zip")]))).toBe("unsafe");
    expect(await failure(() => readImportFiles([archive(zip({ "ok/../../SOUL.md": "x" }), "a.zip")]))).toBe("unsafe");
  });

  test("size, entry count and unpacking ratio are capped", async () => {
    const small = tar([
      { name: "a/SOUL.md", data: "x" },
      { name: "a/USER.md", data: "y" },
      { name: "a/MEMORY.md", data: "z" },
    ]);
    expect(await withLimits({ entries: 2 }, () => failure(() => readImportFiles([archive(small, "a.tar")])))).toBe(
      "tooLarge",
    );
    expect(await withLimits({ bytes: 100 }, () => failure(() => readImportFiles([archive(small, "a.tar")])))).toBe(
      "tooLarge",
    );
    // A small .tar.gz that unpacks to far more than itself.
    const bomb = Bun.gzipSync(tar([{ name: "a/MEMORY.md", data: "a".repeat(2 * 1024 * 1024) }]));
    expect(
      await withLimits({ ratioFrom: 64 * 1024, ratio: 50 }, () =>
        failure(() => readImportFiles([archive(bomb, "a.tar.gz")])),
      ),
    ).toBe("tooLarge");
    // A zip that says it unpacks to almost 4 GB.
    const lying = zip({ "a/SOUL.md": "x" }, { "a/SOUL.md": 0xfffffff0 });
    expect(await failure(() => readImportFiles([archive(lying, "a.zip")]))).toBe("tooLarge");
  });

  test("an unreadable archive is corrupt", async () => {
    const noise = new Uint8Array(256).map((_, i) => (i * 37) % 256);
    expect(await failure(() => readImportFiles([archive(noise, "export.zip")]))).toBe("corrupt");
    expect(await failure(() => readImportFiles([archive(new Uint8Array([0x1f, 0x8b, 1, 2, 3]), "x.tar.gz")]))).toBe(
      "corrupt",
    );
    const badSum = tar([{ name: "a/SOUL.md", data: "x" }], { checksum: false });
    expect(await failure(() => readImportFiles([archive(badSum, "x.tar")]))).toBe("corrupt");
  });
});

describe("picked files", () => {
  test("a dropped folder's paths are relative to it; its name is the root", async () => {
    const picked = Object.entries(folderFiles("paperclip-company")).map(([name, text]) => ({
      path: `corner-studio/${name}`,
      file: new Blob([text]),
    }));
    const { files, root } = await readImportFiles([
      ...picked,
      { path: "corner-studio/.DS_Store", file: new Blob(["x"]) },
    ]);
    expect(root).toBe("corner-studio");
    expect(files.map((f) => f.name)).toEqual(Object.keys(folderFiles("paperclip-company")));
    expect(parseImport(files, { root }).agents.map((a) => a.key)).toEqual(["ceo", "cto"]);
  });

  test("loose files keep their names; one too large to read is listed, not read", async () => {
    const big = new File(["x".repeat(4 * 1024 * 1024 + 1)], "huge.md");
    const pkg = new File([readFileSync(join(DIR, "sales-desk.openmaus.json"), "utf8")], "sales-desk.openmaus.json");
    const { files, root } = await readImportFiles([pkg, big]);
    expect(root).toBeNull();
    expect(files.map((f) => [f.name, f.text.length > 0])).toEqual([
      ["sales-desk.openmaus.json", true],
      ["huge.md", false],
    ]);
    expect(parseImport(files).leftOut).toContainEqual({ kind: "file", label: "huge.md" });
  });
});
