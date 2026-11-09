import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup, render } from "@testing-library/react";
import { RequestCard } from "../src/components/RequestCard";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

afterEach(() => cleanup());

const shipped = await builtCss("src/styles.css", "src/components/request-card.css");
const top = topLevel(shipped);
const last = (sheet: string, selector: string, property: string) =>
  declarations(sheet, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

describe("a request card on the compact rhythm", () => {
  test("its parts 12 apart, a 48px foot whose buttons stand 32 tall and 8 apart, their targets 44 on touch", () => {
    expect(last(top, ".rq", "padding")).toBe("12px 16px 0");
    expect(last(top, ".rq__lead", "margin")).toBe("6px 0 0");
    expect(last(top, ".rq__foot", "margin")).toBe("12px -16px 0");
    expect(last(top, ".rq__foot", "padding")).toBe("8px 16px");
    expect(last(top, ".rq__foot", "min-height")).toBe("48px");
    expect(last(top, ".rq__foot > .ac-btn", "height")).toBe("32px");
    expect(last(top, ".rq__foot,.rq__item-acts", "column-gap")).toBe("var(--space-2)");
    // A ghost keeps its own padding: no reach into the gap, so its plate never meets the button before it.
    expect(declarations(top, ".rq__foot > .ac-btn--ghost")).toEqual([]);
    const touch = atRule(shipped, "@media (pointer: coarse)");
    const target = last(touch, ":is(.rq__foot,.rq__item-acts) > .ac-btn::after", "inset")?.replace(/\s+/g, "");
    expect(target).toBe("calc((var(--control-h-sm)-var(--touch-target))/2)0");
  });

  test("the well: Ver … under the words on their edge; in a narrow card the words take the well's width under the mark's line", () => {
    expect(last(top, ".rq__wt > .rq__more", "align-self")).toBe("flex-start");
    expect(last(top, ".rq__wt > .rq__more", "margin")).toBe("2px 0 0 -6px");
    expect(last(top, ".rq__well", "padding")).toBe("var(--row-py) 16px");
    const narrow = atRule(shipped, "@container (max-width: 479px)");
    expect(last(narrow, ".rq__well", "display")).toBe("grid");
    expect(last(narrow, ".rq__well > .rq__wt", "display")).toBe("contents");
    expect(last(narrow, ".rq__wt > :not(b)", "grid-column")).toBe("1/-1");
    // The old column beside the words, and the grouped card's own narrow rule, are gone.
    expect(shipped).not.toContain("@container (max-width:520px)");
    expect(shipped).not.toContain(".rq__well>.rq__more");
  });

  test("a grouped request is an action line: its decision beside its words while they fit on one line, else under them", () => {
    expect(declarations(top, ".rq__item").map(([p]) => p)).not.toContain("display");
    expect(last(top, ".rq__item > :not(.rq__well,.rq__item-acts)", "flex")).toBe("1 1 100%");
  });

  test("Ver … sits in the words' column, and the agent's words show code between backticks as code", () => {
    const { container } = render(
      <RequestCard
        id="r1"
        kind="approval"
        agent={undefined}
        label="Pedido de aprovação"
        mine
        lead="Posso rodar `bun test` no `main` agora?"
        object={{ logo: null, title: "Rodar comando", detail: "em `apps/web`", more: "Ver detalhes" }}
        details={<p>Tudo</p>}
        actions={<button type="button">Aprovar</button>}
        what="Rodar comando"
      />,
    );
    const well = container.querySelector(".rq__well") as HTMLElement;
    expect(well.classList.contains("ac-actrow")).toBe(false);
    expect(well.querySelector(".rq__wt > .rq__more")?.textContent).toContain("Ver detalhes");
    expect(well.querySelector(":scope > .rq__more")).toBeNull();
    expect([...container.querySelectorAll(".rq__lead > code.ac-inlinecode")].map((c) => c.textContent)).toEqual([
      "bun test",
      "main",
    ]);
    expect(well.querySelector(".rq__wt small > code.ac-inlinecode")?.textContent).toBe("apps/web");
  });
});
