import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  groupLeftOut,
  ImportError,
  type ImportFile,
  importedModel,
  interpolateEnv,
  parseImport,
  scrubSecrets,
  uniqueHandle,
} from "@/lib/agent-import";

/**
 * Fixtures are the projects' own files, unchanged:
 * - OpenMausBot (Apache-2.0) shared/package-fixtures/full-team.v2.json, legacy-botmrr.v1.md, legacy-team.v1.json
 * - OpenBot (MIT) examples/fintech/agents.yaml, model.yaml, channels.yaml, catalog/expense-review.yaml
 */
const fixture = (name: string): ImportFile => ({
  name,
  text: readFileSync(join(import.meta.dir, "fixtures", "agent-import", name), "utf8"),
});
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof ImportError ? err.code : String(err);
  }
  return null;
};

describe("OpenMausBot team file", () => {
  test("version 2 (.openmaus.json): bots with instructions, playbooks and the team brief; the rest is listed", () => {
    const r = parseImport("openmausbot", [fixture("sales-desk.openmaus.json")]);
    expect(r.source).toBe("openmausbot");
    expect(r.team).toBe("Sales desk");
    expect(r.files).toEqual(["sales-desk.openmaus.json"]);
    expect(r.agents.map((a) => [a.key, a.name, a.handle, a.role, a.model])).toEqual([
      ["lead", "Morgan", "lead", "Sales lead", null],
      ["scout", "Scout", "scout", "Prospect researcher", null],
      ["writer", "Quill", "writer", "Outreach writer", null],
    ]);
    const morgan = r.agents[0];
    expect(morgan?.description).toBe("Owns the pipeline and the final answer.");
    // The soul, then its playbook, then the team's shared instructions.
    expect(morgan?.instructions).toBe(
      [
        "You coordinate the desk. Keep answers short and cite the price list.",
        "## Qualify a lead\n\nDecide whether a lead is worth a call.\n\nCheck budget, authority, need and timing. Say which are unknown.",
        "## Sales desk\n\nWe sell a team plan at 49 per seat. Always quote from the price list and never promise discounts.",
      ].join("\n\n"),
    );
    expect(morgan?.playbooks).toBe(1);
    // No soul: the description stands in.
    expect(r.agents[1]?.instructions.startsWith("Finds and qualifies prospects.")).toBe(true);
    // Their colors in our palette (purple, cyan, green).
    expect(r.agents.map((a) => a.appearance.color)).toEqual(["violet", "sky", "green"]);

    expect(groupLeftOut(r.leftOut)).toEqual([
      { kind: "skill", labels: ["pricing-policy", "research-brief", "objection-handling"] },
      { kind: "routine", labels: ["Daily digest (Scout)", "Weekly pipeline review (Morgan)"] },
      { kind: "room", labels: ["Deal desk"] },
      { kind: "connection", labels: ["CRM (mcp.example.com)"] },
      { kind: "app", labels: ["HubSpot"] },
      { kind: "notes", labels: ["Morgan"] },
      { kind: "picture", labels: ["Morgan"] },
      { kind: "preset", labels: ["Support agent"] },
    ]);
  });

  test("version 1: the BotMRR Markdown playbook and the JSON read the same", () => {
    const md = parseImport("openmausbot", [fixture("signal-desk.md")]);
    const json = parseImport("openmausbot", [fixture("signal-desk.v1.openmaus.json")]);
    for (const r of [md, json]) {
      expect(r.team).toBe("Signal Desk");
      expect(r.agents.map((a) => [a.name, a.handle, a.role])).toEqual([
        ["Package Scout", "scout", "Researcher"],
        ["Package Editor", "editor", "Editor"],
      ]);
      expect(r.agents[0]?.instructions).toBe(
        "Find evidence.\n\n## Signal Check\n\nVerify a public signal.\n\nKeep the source URL and confidence.",
      );
      expect(groupLeftOut(r.leftOut)).toEqual([
        { kind: "skill", labels: ["source-check"] },
        { kind: "routine", labels: ["Morning signals (Package Scout)"] },
        { kind: "room", labels: ["Signal Room"] },
        { kind: "app", labels: ["Reddit"] },
      ]);
    }
    expect(md.agents).toEqual(json.agents);
  });

  test("not a team file, a newer version, empty or too large", () => {
    expect(code(() => parseImport("openmausbot", [fixture("agents.yaml")]))).toBe("notOpenMausBot");
    expect(code(() => parseImport("openmausbot", [{ name: "x.json", text: '{"format":"other"}' }]))).toBe(
      "notOpenMausBot",
    );
    expect(
      code(() =>
        parseImport("openmausbot", [
          { name: "t.json", text: '{"format":"openmaus.package","version":3,"package":{}}' },
        ]),
      ),
    ).toBe("newerVersion");
    expect(code(() => parseImport("openmausbot", [{ name: "t.md", text: "  \n" }]))).toBe("empty");
    expect(code(() => parseImport("openmausbot", [{ name: "big.json", text: "x".repeat(4 * 1024 * 1024 + 1) }]))).toBe(
      "tooLarge",
    );
    expect(
      code(() =>
        parseImport("openmausbot", [
          { name: "t.json", text: '{"format":"openmaus.package","version":2,"package":{}}' },
        ]),
      ),
    ).toBe("noAgents");
  });
});

describe("OpenBot package", () => {
  test("agents.yaml: built-in coworkers come; remote ones and skills don't; env placeholders resolve", () => {
    const r = parseImport("openbot", [fixture("agents.yaml")]);
    expect(r.team).toBeNull();
    expect(r.agents.map((a) => [a.key, a.name, a.handle, a.role])).toEqual([
      ["general-assistant", "General Assistant", "general-assistant", "Everyday Work"],
      ["knowledge", "Knowledge", "knowledge", "Company Knowledge"],
    ]);
    expect(r.agents[0]?.instructions).toBe(
      "You are a helpful general assistant. Give clear, concise, and accurate answers.",
    );
    expect(r.agents[0]?.description).toBe("Help with everyday work using clear, concise, and accurate answers.");
    // A folded block scalar (>-) is one paragraph.
    expect(r.agents[1]?.instructions.startsWith("Answer from the sources you can reach with the tools")).toBe(true);
    expect(r.agents[1]?.instructions).not.toContain("\n");
    expect(groupLeftOut(r.leftOut)).toEqual([
      {
        kind: "skill",
        labels: ["bot-creator", "skill-creator", "find-a-document", "check-a-claim", "whats-changed", "who-owns-this"],
      },
      { kind: "remote", labels: ["Risk Analyst (remote-ag-ui)", "Your Bot (remote-ag-ui)"] },
    ]);
  });

  test("agents/ files and model.yaml: one coworker per file; the model comes only when it's in our catalog", () => {
    const files = [
      fixture("agents.yaml"),
      fixture("expense-review.yaml"),
      fixture("model.yaml"),
      fixture("channels.yaml"),
    ];
    const outside = parseImport("openbot", files, { models: ["claude-sonnet-5-5"] });
    expect(outside.agents.map((a) => a.name)).toEqual(["General Assistant", "Knowledge", "Expense Review"]);
    expect(outside.agents.every((a) => a.model === null)).toBe(true);
    expect(outside.files).toEqual(["agents.yaml", "expense-review.yaml", "model.yaml", "channels.yaml"]);
    const left = groupLeftOut(outside.leftOut);
    expect(left.find((g) => g.kind === "model")?.labels).toEqual(["openai · gpt-5.6-terra"]);
    // The name of the secret it uses, never a value.
    expect(left.find((g) => g.kind === "secret")?.labels).toEqual(["openai-api-key"]);
    expect(left.find((g) => g.kind === "file")?.labels).toEqual(["channels.yaml"]);

    const inside = parseImport("openbot", files, { models: ["gpt-5.6-terra"] });
    expect(inside.agents.every((a) => a.model === "gpt-5.6-terra")).toBe(true);
    expect(inside.leftOut.some((l) => l.kind === "model")).toBe(false);
  });

  test("a repeated id keeps the first; key-looking text is removed; not OpenBot files are refused", () => {
    const one = `id: ledger\nname: Ledger\ntitle: Finance\nrole_description: Closes the books.\ntype: built-in\nsystem_prompt: Use the token sk-ant-api03-abcdefghijklmnopqrstuvwx when asked.\n`;
    const again = "id: ledger\nname: Ledger 2\ntitle: x\nrole_description: y\ntype: built-in\nsystem_prompt: z\n";
    const r = parseImport("openbot", [
      { name: "agents/ledger.yaml", text: one },
      { name: "agents/ledger-copy.yml", text: again },
    ]);
    expect(r.agents.map((a) => a.name)).toEqual(["Ledger"]);
    expect(r.agents[0]?.instructions).toBe("Use the token [redacted] when asked.");
    expect(r.leftOut).toEqual([{ kind: "redacted", label: "Ledger" }]);
    expect(code(() => parseImport("openbot", [{ name: "README.md", text: "# Hi" }]))).toBe("notOpenBot");
    expect(code(() => parseImport("openbot", [{ name: "x.yaml", text: "foo: [1, 2" }]))).toBe("notOpenBot");
    expect(code(() => parseImport("openbot", [fixture("channels.yaml")]))).toBe("noAgents");
  });
});

describe("helpers", () => {
  test("handles, env, secrets, the model and a stable look", () => {
    expect(uniqueHandle("scout", new Set(["scout", "scout2"]))).toBe("scout3");
    expect(uniqueHandle("ada", new Set())).toBe("ada");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: OpenBot's own placeholder syntax
    expect(interpolateEnv("a ${X:-Your Bot} b ${Y} c")).toBe("a Your Bot b  c");
    expect(scrubSecrets("key ghp_abcdefghijklmnopqrstuvwxyz0123 ok")).toEqual({
      text: "key [redacted] ok",
      redacted: true,
    });
    expect(scrubSecrets("nothing here")).toEqual({ text: "nothing here", redacted: false });
    const [a] = parseImport("openmausbot", [fixture("sales-desk.openmaus.json")]).agents;
    const [b] = parseImport("openmausbot", [fixture("sales-desk.openmaus.json")]).agents;
    expect(a?.appearance).toEqual(b?.appearance as NonNullable<typeof b>["appearance"]);
    if (!a) throw new Error("no agent");
    expect(importedModel(a, ["claude-sonnet-5-5"], "claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(importedModel({ ...a, model: "gpt-5.6-terra" }, ["gpt-5.6-terra"], "claude-sonnet-5-5")).toBe(
      "gpt-5.6-terra",
    );
  });
});
