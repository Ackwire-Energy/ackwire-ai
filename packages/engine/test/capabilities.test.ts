import { afterEach, expect, test } from "bun:test";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  COMPUTER_TOOLS_NOTE,
  describeCapabilities,
  drainOutbox,
  forComputerBrain,
  grantScopes,
  postPersonMessage,
  setAgentScopes,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { ALL_GITHUB_SCOPES, fakeGithub } from "./tool-fixtures";

let f: Fixture;
afterEach(async () => {
  // Some tests don't set up a database: close each one once.
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

test("capabilities come from the granted tools, grouped, with what needs approval", () => {
  const text = describeCapabilities([
    { name: "create_artifact", description: "Save a file people can open. More text.", scope: "drive:write" },
    { name: "read_artifact", description: "Read an artifact.", scope: "drive:read" },
    { name: "github_merge_pr", description: "Merge a pull request.", scope: "github:pr.merge" },
    { name: "ask_user", description: "Ask the person.", scope: "" },
  ]);
  expect(text).toContain("You can:");
  expect(text).toContain("- Files (Drive): `create_artifact` (Save a file people can open.); `read_artifact`");
  expect(text).toContain("- GitHub: `github_merge_pr`");
  expect(text).toContain("Download PDF");
  expect(text).toContain("Need a person's approval (you ask, someone approves in the chat): `github_merge_pr`.");
  expect(text).toContain("suggest who can");
  const none = describeCapabilities([]);
  expect(none).toContain("You only write messages in this chat");
  expect(none).not.toContain("Download PDF");
});

test("a computer brain's prompt: its own tools are allowed and the limit line counts them", () => {
  const text = describeCapabilities([{ name: "read_artifact", description: "Read an artifact.", scope: "drive:read" }]);
  expect(text).toContain("Beyond this, you can't.");
  expect(text).not.toContain(COMPUTER_TOOLS_NOTE);
  const computer = forComputerBrain(`# Org\n\n${text}`);
  expect(computer).not.toContain("Beyond this, you can't.");
  expect(computer).toContain("Beyond this list and your computer's own tools, you can't.");
  expect(computer).toContain("Use them freely to read and investigate; that needs no approval.");
  expect(computer.startsWith("# Org")).toBe(true);
});

const promptOf = (req: ModelRequest | undefined) => systemText(req?.system ?? "");

test("the run's prompt lists exactly what the agent was granted", async () => {
  const gh = fakeGithub();
  f = await setup({ artifactTools: true, toolSources: [gh.source], reply: () => ({ chunks: ["ok"] }) });
  const ask = () =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev o que você faz?",
    });

  await ask();
  await drainOutbox(f.db, f.handlers);
  let prompt = promptOf(f.provider.calls.at(-1)?.request);
  expect(prompt).toContain("`create_artifact`"); // a default scope
  expect(prompt).not.toContain("github_");

  await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
  await ask();
  await drainOutbox(f.db, f.handlers);
  prompt = promptOf(f.provider.calls.at(-1)?.request);
  expect(prompt).toContain("`github_merge_pr`");
  expect(prompt).toMatch(/Need a person's approval[^\n]*`github_merge_pr`/);

  await setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, []);
  await ask();
  await drainOutbox(f.db, f.handlers);
  prompt = promptOf(f.provider.calls.at(-1)?.request);
  expect(prompt).toContain("You only write messages in this chat");
  expect(prompt).not.toContain("`create_artifact`");
});
