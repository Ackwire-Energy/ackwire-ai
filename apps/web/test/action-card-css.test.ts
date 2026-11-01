import { expect, test } from "bun:test";
import path from "node:path";
import { declarations } from "./built-css";

const ROOT = path.join(import.meta.dir, "../../..");
const sheet = (file: string) => Bun.file(path.join(ROOT, file)).text();
const last = (pairs: (readonly [string, string])[], property: string) => pairs.findLast(([p]) => p === property)?.[1];

test("a card's chip and button share one centre line and one baseline ('Criado' beside 'Abrir perfil')", async () => {
  const layout = await sheet("apps/web/src/layout.css");
  const kit = await sheet("packages/ui/src/styles/components.css");
  // The row centres them, whatever their heights (a 22px chip sat at the top of a 32px button's row).
  expect(last(declarations(layout, ".waitcard__acts"), "align-items")).toBe("center");
  // Centred boxes in one type size put their text on one baseline: the chip there takes the small button's.
  expect(last(declarations(kit, ".ac-btn--sm"), "font-size")).toBe("var(--control-fs-sm)");
  expect(last(declarations(layout, ".waitcard__acts > .ac-chip"), "font-size")).toBe("var(--control-fs-sm)");
});
