import { describe, expect, test } from "bun:test";
import { outdatedKeys } from "./i18n";

describe("translation tools", () => {
  test("a translated key whose English changed since is outdated, with the English it was translated from", () => {
    const en = { approve: "Approve and run", files_one: "One file", files_other: "{{count}} files", cancel: "Cancel" };
    const es = { approve: "Aprobar", files_one: "Un archivo", files_other: "{{count}} archivos", cancel: "Cancelar" };
    const sources = {
      approve: { value: "Approve" },
      files: { value: { one: "One file", other: "{{count}} files" } },
    };
    expect([...outdatedKeys(en, es, sources)]).toEqual([
      ["approve", { value: "Approve" }],
      // Translated before the English was kept: nobody knows what from.
      ["cancel", undefined],
    ]);
  });
});
