import { describe, expect, test } from "bun:test";
import type { VaultItem } from "../src";
import {
  canMoveVaultItem,
  ENV_MAX_KEYS,
  envImportInput,
  envReview,
  isReservedKeyName,
  parseEnvFile,
  savedKeyNames,
  VAULT_KEY_NAME,
} from "../src/lib/vault";

const pairs = (text: string) => parseEnvFile(text).entries.map((e) => [e.name, e.value]);

describe("parseEnvFile", () => {
  test("NAME=value lines, with comments, blank lines, an export and spaces around the sign", () => {
    const file = parseEnvFile(
      [
        "# database",
        "DATABASE_URL=postgres://ana@db.example.com/app",
        "",
        "export API_TOKEN = abc123",
        "  PORT=8080",
      ].join("\n"),
    );
    expect(file.format).toBe("env");
    expect(file.duplicates).toEqual([]);
    expect(file.entries).toEqual([
      { name: "DATABASE_URL", value: "postgres://ana@db.example.com/app", problem: null },
      { name: "API_TOKEN", value: "abc123", problem: null },
      { name: "PORT", value: "8080", problem: null },
    ]);
  });

  test("a plain value: a comment after a space is cut, a # inside it stays, and so do = signs", () => {
    expect(pairs("A=one # note\nB=two#three\nC=a=b==\nD=  spaced out  \nE= # only a note\nF=#hash")).toEqual([
      ["A", "one"],
      ["B", "two#three"],
      ["C", "a=b=="],
      ["D", "spaced out"],
      ["E", ""],
      ["F", "#hash"],
    ]);
  });

  test("quoted values: double quotes take escapes, single quotes and backticks are as written", () => {
    expect(
      pairs(
        [
          'A="two words # not a comment" # a comment',
          'B="line\\nbreak\\tand \\"quotes\\" and a \\\\ and \\x"',
          "C='as $written\\n'",
          'D=`it\'s "here"`',
          'E=""',
        ].join("\n"),
      ),
    ).toEqual([
      ["A", "two words # not a comment"],
      ["B", 'line\nbreak\tand "quotes" and a \\ and \\x'],
      ["C", "as $written\\n"],
      ["D", 'it\'s "here"'],
      ["E", ""],
    ]);
  });

  test("a quoted value over several lines, then the next key", () => {
    expect(pairs("CERT=\"-----BEGIN-----\nabc\n\ndef\n-----END-----\"\nNEXT=1\nSINGLE='a\nb'\nLAST=2")).toEqual([
      ["CERT", "-----BEGIN-----\nabc\n\ndef\n-----END-----"],
      ["NEXT", "1"],
      ["SINGLE", "a\nb"],
      ["LAST", "2"],
    ]);
  });

  test("a quote that never closes is part of a plain value on its own line", () => {
    expect(pairs('A="open\nB=2')).toEqual([
      ["A", '"open'],
      ["B", "2"],
    ]);
    // Each kind of quote is looked for on its own: a closed one after a stray one of another kind still counts.
    expect(pairs('A=\'x\nB=`y\nC="z"')).toEqual([
      ["A", "'x"],
      ["B", "`y"],
      ["C", "z"],
    ]);
  });

  test("CRLF line ends and a byte order mark", () => {
    expect(pairs('﻿A=1\r\nB="x\r\ny"\r\nC=3\r')).toEqual([
      ["A", "1"],
      ["B", "x\ny"],
      ["C", "3"],
    ]);
  });

  test("a name written twice keeps its last value, and is said", () => {
    const file = parseEnvFile("A=1\nB=2\nA=3\nA=4");
    expect(file.entries.map((e) => [e.name, e.value])).toEqual([
      ["A", "4"],
      ["B", "2"],
    ]);
    expect(file.duplicates).toEqual(["A"]);
  });

  test("lines that are no NAME=value are left out, and a file with none has no entries", () => {
    expect(pairs("just words\n=value\n9LIVES=1\nGOOD=1\n- yaml: no")).toEqual([["GOOD", "1"]]);
    for (const text of ["", "\n\n", "# only a comment", "name,url,username,password\nAcme,https://acme.example,ana,x"])
      expect(parseEnvFile(text).entries).toEqual([]);
  });

  test("what can't become a key says why: the name, a reserved name, no value, a value too large", () => {
    const file = parseEnvFile(
      ["lower_case=1", "next.public=1", "OPENAI_API_KEY=1", "HTTPS_PROXY=1", "EMPTY=", 'BLANK="  "', "FINE=1"].join(
        "\n",
      ),
    );
    expect(file.entries.map((e) => [e.name, e.problem])).toEqual([
      ["lower_case", "name"],
      ["next.public", "name"],
      ["OPENAI_API_KEY", "reserved"],
      ["HTTPS_PROXY", "reserved"],
      ["EMPTY", "empty"],
      ["BLANK", "empty"],
      ["FINE", null],
    ]);
    expect(parseEnvFile(`BIG=${"x".repeat(16 * 1024 + 1)}`).entries[0]?.problem).toBe("tooLarge");
    expect(parseEnvFile(`FITS=${"x".repeat(16 * 1024)}`).entries[0]?.problem).toBeNull();
  });

  test("a JSON object of names and values: text, numbers and booleans, nothing nested", () => {
    const file = parseEnvFile(
      JSON.stringify({ API_TOKEN: "abc", PORT: 8080, DEBUG: false, NESTED: { a: 1 }, LIST: ["a"], NOTHING: null }),
    );
    expect(file.format).toBe("json");
    expect(file.entries.map((e) => [e.name, e.value])).toEqual([
      ["API_TOKEN", "abc"],
      ["PORT", "8080"],
      ["DEBUG", "false"],
    ]);
    // Broken JSON, or JSON that is no object, reads as a .env with nothing in it.
    expect(parseEnvFile('{"A": "1",').entries).toEqual([]);
    expect(parseEnvFile('["A=1"]').entries).toEqual([]);
  });
});

describe("key names", () => {
  test("a variable's name, and the names kept for AI tools", () => {
    expect(VAULT_KEY_NAME.test("ACME_API_KEY")).toBe(true);
    expect(VAULT_KEY_NAME.test("_ACME")).toBe(false);
    expect(isReservedKeyName("CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
    expect(isReservedKeyName("ACME_API_KEY")).toBe(false);
  });
});

const item = (patch: Partial<VaultItem>): VaultItem =>
  ({
    id: "i1",
    kind: "key",
    scope: "team",
    keyName: null,
    connectionId: null,
    can: { edit: true, delete: true },
    ...patch,
  }) as VaultItem;

describe("the review list", () => {
  const items = [
    item({ keyName: "TEAM_KEY" }),
    item({ keyName: "MY_KEY", scope: "personal" }),
    item({ keyName: "FROM_MANAGER", connectionId: "c1" }),
    item({ kind: "login", keyName: null }),
  ];

  test("which names are already saved depends on where they go, and a password manager's never count", () => {
    expect([...savedKeyNames(items, "team")]).toEqual(["TEAM_KEY"]);
    expect([...savedKeyNames(items, "personal")]).toEqual(["MY_KEY"]);
  });

  test("new, already saved, or not importable", () => {
    const file = parseEnvFile("TEAM_KEY=1\nMY_KEY=2\nbad-name=3\nFRESH=4");
    expect(envReview(file, savedKeyNames(items, "team")).map((r) => [r.name, r.state])).toEqual([
      ["TEAM_KEY", "exists"],
      ["MY_KEY", "new"],
      ["bad-name", "problem"],
      ["FRESH", "new"],
    ]);
  });

  test("the save sends the new keys and only the saved ones chosen to be replaced", () => {
    const access = { everyone: true, roleIds: [], userIds: [], allAgents: false, agentIds: ["a1"] };
    const rows = envReview(parseEnvFile("TEAM_KEY=1\nOTHER=  2  \nbad-name=3\nEMPTY="), new Set(["TEAM_KEY", "OTHER"]));
    // Nothing chosen: a saved key is skipped, and its value isn't sent at all.
    expect(envImportInput(rows, new Set(), "team", access).keys).toEqual([]);
    expect(envImportInput(rows, new Set(["OTHER", "bad-name", "EMPTY"]), "team", access)).toEqual({
      scope: "team",
      access,
      keys: [{ keyName: "OTHER", secret: "2", replace: true }],
    });
    const fresh = envReview(parseEnvFile("A=1\nB=2"), new Set());
    expect(envImportInput(fresh, new Set(), "personal", access).keys).toEqual([
      { keyName: "A", secret: "1", replace: false },
      { keyName: "B", secret: "2", replace: false },
    ]);
    expect(ENV_MAX_KEYS).toBe(200);
  });
});

describe("canMoveVaultItem", () => {
  test("an item kept here, which the person edits, while they manage the team's", () => {
    expect(canMoveVaultItem(item({}), true)).toBe(true);
    expect(canMoveVaultItem(item({}), false)).toBe(false);
    expect(canMoveVaultItem(item({ connectionId: "c1" }), true)).toBe(false);
    expect(canMoveVaultItem(item({ can: { edit: false, delete: false } }), true)).toBe(false);
  });
});
