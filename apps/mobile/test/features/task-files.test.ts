import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { receiptFiles } from "@agenteschat/client/lib/actions";
import { joinNames } from "@agenteschat/client/lib/format";
import { parseInline } from "../../src/features/chat/logic";
import { translator } from "./fixtures";

/** A file of the app, as text: what a pill does lives in components the tests can't render. */
const source = (path: string) => readFileSync(join(import.meta.dir, "../../src/features/chat", path), "utf8");

const FILE = "019a1b74-5b85-74a8-9ffa-f9a6ace806d8";

describe("an internal id in a text on the phone", () => {
  test("is a part of its own with the word that names its kind, so the pill takes its place", () => {
    expect(parseInline(`Na referência (artifact ${FILE}) e id=${FILE.toUpperCase()}.`)).toEqual([
      { kind: "text", text: "Na referência (" },
      { kind: "id", text: `artifact ${FILE}`, id: FILE },
      { kind: "text", text: ") e " },
      { kind: "id", text: `id=${FILE.toUpperCase()}`, id: FILE },
      { kind: "text", text: "." },
    ]);
  });

  test("inside a path, in code or in an address it stays as written", () => {
    expect(parseInline(`exemplo.com/pedidos/${FILE}`)).toEqual([{ kind: "text", text: `exemplo.com/pedidos/${FILE}` }]);
    expect(parseInline(`\`${FILE}\``)).toEqual([{ kind: "code", text: FILE }]);
    expect(parseInline(`https://exemplo.com/${FILE}`)[0]?.kind).toBe("link");
  });

  test("its pill opens the file or the task, a message's is the message pill, and the id never shows while it loads", () => {
    const pill = source("IdRefText.tsx");
    expect(pill).toContain('router.push({ pathname: "/file/[id]", params: { id: ref.id } })');
    expect(pill).toMatch(/router\.push\(`\/issues\/\$\{ref\.number\}`\)/);
    expect(pill).toContain("<MessageRefText");
    expect(pill).toContain("if (query.isPending) {");
    expect(pill).toContain("if (!ref) return <RNText>{text}</RNText>;");
    expect(source("MessageSpans.tsx")).toContain('case "id":');
  });
});

describe("the receipt of a task an agent made with a file, on the phone", () => {
  test("says which files went with it", async () => {
    const t = await translator("pt-BR");
    const files = receiptFiles({ kind: "issue.created", params: { number: 13, files: ["print.png", "log.txt"] } });
    expect(t("agentActions.issue.files", { names: joinNames(files, t) })).toBe("Anexei print.png e log.txt");
    expect(receiptFiles({ kind: "routine.created", params: { files: ["x"] } })).toEqual([]);
    expect(source("Receipts.tsx")).toContain("<FilesLine action={action} />");
  });
});
