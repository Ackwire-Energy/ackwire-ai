import { afterEach, expect, test } from "bun:test";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import { describeCapabilities, drainOutbox, grantScopes, postPersonMessage, setAgentScopes } from "../src";
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
  expect(text).toContain("Você pode:");
  expect(text).toContain("- Arquivos (Drive): `create_artifact` (Save a file people can open.); `read_artifact`");
  expect(text).toContain("- GitHub: `github_merge_pr`");
  expect(text).toContain("Baixar PDF");
  expect(text).toContain("Precisam da aprovação de uma pessoa (você pede, alguém aprova no chat): `github_merge_pr`.");
  expect(text).toContain("sugira quem pode");
  const none = describeCapabilities([]);
  expect(none).toContain("Você só escreve mensagens neste chat");
  expect(none).not.toContain("Baixar PDF");
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
  expect(prompt).toMatch(/Precisam da aprovação[^\n]*`github_merge_pr`/);

  await setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, []);
  await ask();
  await drainOutbox(f.db, f.handlers);
  prompt = promptOf(f.provider.calls.at(-1)?.request);
  expect(prompt).toContain("Você só escreve mensagens neste chat");
  expect(prompt).not.toContain("`create_artifact`");
});
