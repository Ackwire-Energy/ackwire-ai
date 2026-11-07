import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");

describe("Tarefas in Você", () => {
  test("goes bold for a reply not read in a task's conversation, as an unread conversation's name", () => {
    const me = source("me/MeScreen.tsx");
    expect(me).toContain("unread: tasksUnread.unread > 0");
    expect(me).toContain("unread={r.unread}");
    const row = source("shared/CoverPage.tsx");
    expect(row).toContain("style={unread && styles.unread}");
    expect(row).toContain("unread: { fontWeight: weights.bold }");
  });
});
