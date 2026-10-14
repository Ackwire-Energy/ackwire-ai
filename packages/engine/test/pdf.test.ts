import { afterEach, expect, test } from "bun:test";
import { artifactFile, createArtifact, markdownToPdf, parseMarkdown } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  // Some tests don't set up a database: close each one once.
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");

/** Every xref entry must point at its `N 0 obj`. */
function checkXref(pdf: string) {
  const start = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
  const table = pdf.slice(start).split("\n");
  const count = Number(table[1]?.split(" ")[1]);
  for (let n = 1; n < count; n++) {
    const offset = Number(table[2 + n]?.slice(0, 10));
    expect(pdf.slice(offset, offset + `${n} 0 obj`.length)).toBe(`${n} 0 obj`);
  }
  return count - 1;
}

test("markdown blocks: headings, lists, code, tables, quotes, rules", () => {
  const blocks = parseMarkdown(
    "# Título\n\nUm parágrafo\ncontinua aqui.\n\n- um\n- dois\n\n1. primeiro\n2. segundo\n\n```\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> citação\n\n---",
  );
  expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "list", "code", "table", "quote", "rule"]);
  expect(blocks[1]).toEqual({ type: "paragraph", text: "Um parágrafo continua aqui." });
  expect(blocks[3]).toEqual({ type: "list", ordered: true, items: ["primeiro", "segundo"] });
  expect(blocks[5]).toEqual({
    type: "table",
    rows: [
      ["a", "b"],
      ["1", "2"],
    ],
  });
});

test("a valid PDF with Portuguese text, standard fonts, and pages as needed", () => {
  const pdf = latin1(
    markdownToPdf("# Relatório de março\n\nVendas **subiram** 20% — ação `deploy`.", { title: "Março" }),
  );
  expect(pdf.startsWith("%PDF-1.4")).toBe(true);
  expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  expect(pdf).toContain("(Relatório de março)");
  expect(pdf).toContain("/BaseFont /Helvetica-Bold");
  expect(pdf).toContain("/BaseFont /Courier");
  expect(pdf).toContain("(20% \u0097 ação )"); // em dash and accents in WinAnsi
  expect(pdf).toContain("/Count 1");
  checkXref(pdf);

  const long = Array.from({ length: 120 }, (_, i) => `Parágrafo ${i} com algum texto para ocupar espaço.`).join("\n\n");
  const many = latin1(markdownToPdf(long));
  const pages = Number(/\/Count (\d+)/.exec(many)?.[1]);
  expect(pages).toBeGreaterThan(2);
  checkXref(many);
});

test("a document artifact downloads as PDF; tables too; other kinds can't", async () => {
  f = await setup();
  const person = { type: "person" as const, userId: f.owner.id };
  const doc = await createArtifact(f.artifactDeps, person, f.org.id, {
    title: "Plano",
    content: { kind: "document", markdown: "# Plano\n\n- item" },
  });
  const file = await artifactFile(f.artifactDeps, f.owner.id, f.org.id, doc.id, { format: "pdf" });
  expect(file.contentType).toBe("application/pdf");
  expect(file.filename).toBe("Plano-v1.pdf");
  expect(latin1(file.body).startsWith("%PDF-")).toBe(true);
  const table = await createArtifact(f.artifactDeps, person, f.org.id, {
    title: "Metas",
    content: { kind: "table", columns: ["mês"], rows: [["jan"]] },
  });
  expect(
    latin1((await artifactFile(f.artifactDeps, f.owner.id, f.org.id, table.id, { format: "pdf" })).body),
  ).toContain("(jan)");
  const diagram = await createArtifact(f.artifactDeps, person, f.org.id, {
    title: "Fluxo",
    content: { kind: "diagram", mermaid: "graph TD; A-->B" },
  });
  await expect(artifactFile(f.artifactDeps, f.owner.id, f.org.id, diagram.id, { format: "pdf" })).rejects.toThrow(
    "PDF",
  );
});
