import { expect, test } from "bun:test";
import { CHAT_RHYTHM } from "@agenteschat/client/lib/chat-look";
import { builtCss, declarations, rules } from "./built-css";

const SHEETS = [
  "src/styles.css",
  "src/components/agent-actions.css",
  "src/components/blocks/blocks.css",
  "src/components/browser/browser.css",
  "src/components/chat-notices.css",
  "src/components/computer-queue.css",
  "src/components/issue-work.css",
  "src/components/missions/missions.css",
  "src/components/request-card.css",
  "src/components/threads/threads.css",
];
const css = await builtCss(...SHEETS);
const last = (selector: string, property: string) =>
  declarations(css, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];
const VERTICAL = new Set(["margin", "margin-top", "margin-bottom", "margin-block", "margin-block-start"]);
const setsVertical = ([p]: readonly [string, string]) => VERTICAL.has(p);

/** Everything that stacks in a message's body or in the list, as its own rule names it. */
const PARTS = [
  "ac-msg__text",
  "ac-msg__error",
  "ac-msg__error-row",
  "ac-msg__activity",
  "ac-msg__own-time",
  "ac-receipt",
  "ac-reacts",
  "ac-tools",
  "artifact-cards",
  "thread-line",
  "thread-stub",
  "thread-closed",
  "choice-reply",
  "cn-line",
  "cn-report",
  "correction-ask",
  "cq__acts",
  "iw-card",
  "iw-line",
  "mi-created",
  "mi-evt",
  "mi-linkrow",
  "mi-suggest",
  "mi-tag",
  "rq-done",
  "brw-rq",
  "consult-pair",
  "channel__unread",
];
/** These also stand outside a message, so they keep their own top there: in a message the body's rule outranks it. */
const OUTSIDE_TOO = ["rq", "brw-ac", "mi-card", "ag-rcs"];
const subject = (selector: string) =>
  selector
    .trim()
    .split(/[\s>+~]+/)
    .at(-1) ?? "";
const named = (selector: string, cls: string) => new RegExp(`\\.${cls}(?![\\w-])`).test(subject(selector));

test("one token pair per look, the same numbers the phone reads", () => {
  const { comfortable, bubbles, compact } = CHAT_RHYTHM;
  expect(CHAT_RHYTHM.left).toEqual(comfortable);
  for (const [selector, r] of [
    [":root", comfortable],
    ['[data-look="bubbles"]', bubbles],
    ['[data-look="compact"]', compact],
  ] as const) {
    expect(last(selector, "--msg-part-gap")).toBe(`${r.part}px`);
    expect(last(selector, "--msg-turn-gap")).toBe(`${r.turn}px`);
    expect(last(selector, "--msg-block")).toBe(`${r.block}px`);
  }
});

test("the list spends the two gaps: no flex gap, and a row gives its plate's room back", () => {
  expect(last(".channel__messages", "gap")).toBeUndefined();
  expect(last(".channel__messages > *", "margin-top")).toBe("var(--row-gap)");
  expect(last(".channel__messages > *", "--row-gap")).toBe("var(--msg-turn-gap)");
  expect(last(".channel__messages > .ac-msg + .ac-msg--grouped", "--row-gap")).toBe("var(--msg-part-gap)");
  expect(last(".channel__messages > .ac-msg", "margin-block")).toBe(
    "calc(var(--row-gap) - var(--msg-block)) calc(-1 * var(--msg-block))",
  );
  expect(last(".ac-msg", "padding")).toBe("var(--msg-block) var(--msg-inline)");
  // Nothing else sets a row's room: not a look, a run of my rows, or what a row holds.
  const rowRoom = rules(css)
    .filter((r) =>
      r.declarations.some(([p]) =>
        /^(padding-block|padding-top|padding-bottom|margin|margin-top|margin-bottom)$/.test(p),
      ),
    )
    .flatMap((r) =>
      r.selectors.filter((s) => /^\.ac-msg(?![\w-])[^ >+~]*$/.test(s) || /^\.ac-msg--(own|grouped)[^ >+~]*$/.test(s)),
    );
  expect(rowRoom.filter((s) => s !== ".ac-msg")).toEqual([]);
});

test("a message's body sets what stands between its parts, and no part sets it for itself", () => {
  expect(last(".ac-msg .ac-msg__body>*", "margin-block")).toBe("0");
  const gap = rules(css).find((r) => r.selectors.some((s) => s.includes(".ac-msg__body>:not(") && s.includes("~")));
  expect(gap?.declarations).toContainEqual(["margin-top", "var(--msg-part-gap)"]);
  const own = rules(css)
    .filter((r) => r.declarations.some(setsVertical))
    .flatMap((r) => r.selectors.filter((s) => PARTS.some((cls) => named(s, cls))))
    // A part's insides and its place in a card or a page are its own business.
    .filter(
      (s) =>
        !/^\.(ac-msg__error-row\s*>|issue|mi-delivery|ac-msg\s\.ac-msg__body|ac-msg\.ac-msg\s\.ac-msg__body)/.test(s),
    );
  expect(own).toEqual([]);
  // Nor by what stands above it.
  const byNeighbour = rules(css)
    .filter((r) => r.declarations.some(setsVertical))
    .flatMap((r) => r.selectors.filter((s) => /^\.ac-msg(__text|-media|__head)[^ ]*[+~]/.test(s)));
  expect(byNeighbour).toEqual([]);
});

test("a card that also stands alone is outranked in a message", () => {
  // `.ac-msg .ac-msg__body>*` is two classes: a part's own rule has one.
  for (const cls of OUTSIDE_TOO) {
    const own = rules(css)
      .filter((r) => r.declarations.some(setsVertical))
      .flatMap((r) => r.selectors.filter((s) => s === `.${cls}`));
    expect(own.length).toBeGreaterThan(0);
  }
});

test("the agents' line is the conversation's width, the pair on its middle, and takes the list's gap", () => {
  expect(last(".consult-pair", "display")).toBe("grid");
  expect(last(".consult-pair", "grid-template-columns")).toBe("minmax(16px,1fr) minmax(0,auto) minmax(16px,1fr)");
  expect(last(".consult-pair", "margin")).toBeUndefined();
  // The hidden chevron keeps no room on one side only.
  expect(last(".consult-pair__chev", "position")).toBe("absolute");
  expect(last(".consult-pair__row", "padding")).toBe("0 20px");
  // Inside a message it leaves the row's body for the same width.
  expect(last(".ag-rc--talk", "margin-left")).toBe("calc(-1 * var(--msg-lead))");
});
