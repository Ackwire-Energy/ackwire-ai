import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ASK_AGAIN } from "@agenteschat/adapters/command-policy";
import { commandApproval, lonePush, pushesOwnBranches } from "../../runner/command-gate";
import { gitRepo, hasGit, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const own = ["agentes/dev/"];
const gate = (command: string, cwd: string | null, extra: { head?: string; script?: boolean } = {}) =>
  commandApproval(command, { cwd, own, how: ASK_AGAIN, ...extra });

test.skipIf(!hasGit)(
  "the default branch is read from git (origin/HEAD, else the remote's HEAD), never assumed; unknown waits",
  async () => {
    const { root, work, git } = gitRepo(dirs);
    expect(await gate("git push origin develop", work)).toBe(
      "This push goes to the default branch develop: a person approves it first. To ask them, make the same call again with why set to your reason: it waits for their decision in the chat. Or push to a branch of your own (agentes/dev/…) and open a pull request.",
    );
    // main isn't this repository's default branch: ordinary work.
    expect(await gate("git push origin main", work)).toBeNull();
    expect(await gate("git push origin pr-914:cursor/pap-582-fix", work)).toBeNull();
    // A bare push goes where the branch tracks: the pull request's branch here, the default one from develop.
    expect(await gate("git push", work)).toBeNull();
    git("checkout", "-q", "develop");
    expect(await gate("git push", work)).toContain("This push goes to the default branch develop");
    expect(await gate("git push -u origin HEAD", work)).toContain("This push goes to the default branch develop");
    git("checkout", "-q", "cursor/pap-582-fix");
    // Without origin/HEAD the remote itself says which branch is its default.
    git("remote", "set-head", "origin", "-d");
    expect(await gate("git push origin develop", work)).toContain("This push goes to the default branch develop");
    // A remote that can't be read: git can't tell, so the push waits (but never for the agent's own branches).
    git("remote", "set-url", "origin", path.join(root, "gone.git"));
    expect(await gate("git push origin fix", work)).toContain(
      "git can't tell this repository's default branch, so this push may go to it: a person approves it first.",
    );
    expect(await gate("git push origin agentes/dev/fix", work)).toBeNull();
    // Nowhere to read it from at all.
    expect(await gate("git push origin fix", null)).toContain("git can't tell this repository's default branch");
    expect(await gate("git push origin fix", tempDir("plain-"))).toContain(
      "git can't tell this repository's default branch",
    );
  },
  30_000,
);

test.skipIf(!hasGit)(
  "force pushes, deletes and protected branches wait; the folder each push runs in is followed",
  async () => {
    const { root, work, git } = gitRepo(dirs);
    expect(await gate("git push --force origin cursor/pap-582-fix", work)).toContain(
      "This is a force push to cursor/pap-582-fix, a branch others may share: a person approves it first.",
    );
    expect(await gate("git push --force-with-lease origin agentes/dev/fix", work)).toBeNull();
    expect(await gate("git push origin --delete cursor/pap-582-fix", work)).toContain(
      "This deletes the remote branch cursor/pap-582-fix",
    );
    // The repository says which branches are protected.
    git("config", "--add", "agentes.protectedBranch", "release/*");
    expect(await gate("git push origin release/2.1", work)).toContain(
      "This push goes to the protected branch release/2.1",
    );
    // `cd` and `git -C` lead to the repository, from a folder that isn't one.
    const above = path.relative(root, work);
    expect(await gate(`cd ${above} && git push origin develop`, root)).toContain("default branch develop");
    expect(await gate(`git -C ${work} push origin develop`, root)).toContain("default branch develop");
    expect(await gate(`git -C ${work} push origin main`, root)).toBeNull();
    // A task's new worktree: its branch, not the folder's.
    git("checkout", "-q", "develop");
    expect(await gate("git push -u origin HEAD", work, { head: "agentes/dev/tests" })).toBeNull();
    // The deny list's kinds are named too.
    expect(await gate("gh pr merge 914 --squash", work)).toContain("This is a merge: a person approves it first.");
  },
);

test.skipIf(!hasGit)(
  "a script a command runs is read too: a shell script as commands, other code by what it spells out",
  async () => {
    const { work } = gitRepo(dirs);
    mkdirSync(path.join(work, ".agentes"));
    writeFileSync(path.join(work, ".agentes", "run-1.sh"), "# ship it\nnpm test\ngit push origin develop\n");
    writeFileSync(path.join(work, ".agentes", "run-2.sh"), "git status\ngit push origin HEAD\n");
    writeFileSync(path.join(work, ".agentes", "run-3.py"), 'import subprocess\nsubprocess.run(["git", "push"])\n');
    const script = (command: string) => gate(command, work, { script: true });
    expect(await script("bash .agentes/run-1.sh")).toContain("This push goes to the default branch develop");
    expect(await script("bash .agentes/run-2.sh")).toBeNull();
    expect(await script("python3 .agentes/run-3.py")).toContain("This runs git push in a way the computer can't read");
    // Without `script` only the command line is read.
    expect(await gate("bash .agentes/run-1.sh", work)).toBeNull();
  },
);

test("a push alone, and whether every ref it names is the agent's own", () => {
  const alone = (command: string) => lonePush(command);
  expect(alone("git push origin agentes/dev/fix")).not.toBeNull();
  expect(alone("npm test && git push origin agentes/dev/fix")).toBeNull();
  // An option that runs a program is never let through by the computer alone.
  expect(alone("git -c core.sshCommand=x push origin agentes/dev/fix")).toBeNull();
  const mine = (command: string) => {
    const push = lonePush(command);
    return push !== null && pushesOwnBranches(push, own);
  };
  expect(mine("git push -u origin agentes/dev/fix")).toBe(true);
  expect(mine("git push origin agentes/dev/a agentes/dev/b")).toBe(true);
  expect(mine("git push origin agentes/dev/a cursor/x")).toBe(false);
  expect(mine("git push")).toBe(false);
  expect(mine("git push origin HEAD")).toBe(false);
  expect(mine("git push origin --delete agentes/dev/a")).toBe(false);
});
