/*
 * The layout rules, run inside Chromium on a laid-out screen. Each finding names its element by its classes, never by
 * its words or size, so a baseline entry survives new copy and only a new offender is new.
 */
(() => {
  const EDGE_MIN = 8;
  /** A quiet line (the agents' pair, a date, "Novas") and a bubble: closer than this reads as touching. */
  const QUIET_MIN = 4;
  /** The kit's smallest gap (`--space-1`): two things side by side in a row closer than this touch. */
  const GAP_MIN = 4;
  /** Taller than this is a layout's column or a card, not an inline item. */
  const INLINE_MAX = 120;
  const PAD_DIFF = 2;
  const PLATE_DIFF = 1;
  const GAP_DIFF = 1.5;
  /** The narrowest window a side pane floats in instead of covering the screen (`.thread-panel` in threads.css). */
  const DESKTOP_MIN = 861;
  /** What `cascadeorder` compares between two CSS orders: the box, its room, its type and its paint. */
  const ORDER_PROPS = [
    "display",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "row-gap",
    "column-gap",
    "width",
    "height",
    "min-height",
    "font-size",
    "line-height",
    "font-weight",
    "border-top-width",
    "border-top-left-radius",
    "background-color",
    "color",
    "align-items",
    "justify-content",
    "flex-grow",
    "flex-direction",
    "grid-template-columns",
    "position",
    "box-shadow",
    "translate",
    "overflow-x",
  ];

  const sig = (el) => {
    const classes = (typeof el.className === "string" ? el.className : (el.className?.baseVal ?? ""))
      .split(/\s+/)
      .filter((c) => c && !/^(ac-captop|ac-iconline|is-|has-)/.test(c))
      .slice(0, 3);
    return el.tagName.toLowerCase() + classes.map((c) => `.${c}`).join("");
  };
  /**
   * A finding named only by the kit's classes (`button.ac-btn.ac-btn--sm in section.ac-card`) would, in the baseline,
   * excuse that pair on every screen: it also carries the nearest box around it with a class of the app's own.
   */
  const UTILITY = /^(ac-|row$|stack|small$|muted$|grow$|is-|has-)/;
  const kitOnly = (signature) => !(signature?.match(/\.[\w-]+/g) ?? []).some((c) => !UTILITY.test(c.slice(1)));
  const placeOf = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const classes = typeof p.className === "string" ? p.className.split(/\s+/) : [];
      if (classes.some((c) => c && !UTILITY.test(c))) return sig(p);
    }
    return undefined;
  };
  const words = (el) => (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  const style = (el) => getComputedStyle(el);
  const painted = (color) => color !== "transparent" && !/rgba\(.*,\s*0\)$/.test(color);
  const hasSurface = (s) =>
    painted(s.backgroundColor) ||
    s.boxShadow !== "none" ||
    ["Top", "Right", "Bottom", "Left"].some(
      (d) => parseFloat(s[`border${d}Width`]) > 0 && s[`border${d}Style`] !== "none",
    );
  let seenOf = new Map();
  const seen = (el) => {
    let on = seenOf.get(el);
    if (on === undefined) {
      const s = style(el);
      const r = el.getBoundingClientRect();
      on =
        s.display !== "none" &&
        s.visibility !== "hidden" &&
        +s.opacity !== 0 &&
        r.width > 1 &&
        r.height > 1 &&
        !el.closest(".sr-only,.ac-sr-only,.visually-hidden,[hidden],[inert]");
      seenOf.set(el, on);
    }
    return on;
  };
  /** Children as laid out: a `display: contents` box hands its own to its parent. */
  const flow = (el) =>
    [...el.children]
      .flatMap((c) => (style(c).display === "contents" ? flow(c) : [c]))
      .filter((c) => {
        const s = style(c);
        return seen(c) && !["absolute", "fixed", "sticky"].includes(s.position);
      });
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const PAGE_BOX =
    "main,.shell__main,.shell__pages,.shell__work,.ac-dialog,.ac-dialog__body,.ac-details,.ac-details__body";
  /** Inside a box of its own that scrolls or clips within the viewport: it can't run past the screen, only past that box. */
  const contained = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (style(p).overflowX !== "visible" && !p.matches(PAGE_BOX) && p.getBoundingClientRect().right <= innerWidth + 1)
        return true;
    }
    return false;
  };
  const inFloat = (el) => el.closest("[data-radix-popper-content-wrapper],[data-radix-portal]");
  const textRange = (node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range;
  };
  /**
   * What the eye reads as the content of a box: its words, its icons, and anything with a surface of its own (a key cap,
   * a count). An icon stands in the kit's square, so it counts as that, except a ✕ whose plate shows only on hover: that
   * one counts as what it draws.
   */
  const contentRect = (box) => {
    const rects = [];
    const walk = (node) => {
      if (node.nodeType === 3) {
        if (!node.textContent.trim()) return;
        // Words cut by an ellipsis end where their box does, not where the hidden rest would.
        const clip =
          style(node.parentElement).overflowX === "visible" ? null : node.parentElement.getBoundingClientRect();
        for (const r of textRange(node).getClientRects()) {
          if (r.width > 0)
            rects.push(clip ? { left: Math.max(r.left, clip.left), right: Math.min(r.right, clip.right) } : r);
        }
        return;
      }
      if (node.nodeType !== 1 || !seen(node)) return;
      const tag = node.tagName.toLowerCase();
      if (tag === "svg" && node.closest("[class*='remove']")) {
        const shapes = node.querySelectorAll("path,circle,rect,line,polyline,polygon,ellipse");
        rects.push(...[...shapes].map((s) => s.getBoundingClientRect()).filter((r) => r.width + r.height > 0));
        return;
      }
      if (
        tag === "svg" ||
        tag === "img" ||
        tag === "canvas" ||
        !node.childNodes.length ||
        (hasSurface(style(node)) && !node.matches("[class*='remove']"))
      ) {
        rects.push(node.getBoundingClientRect());
        return;
      }
      for (const c of node.childNodes) walk(c);
    };
    for (const c of box.childNodes) walk(c);
    if (!rects.length) return null;
    return { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)) };
  };

  /** A text node in `box` laid out on more than one line. */
  const wraps = (box) => {
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const tops = new Set([...textRange(n).getClientRects()].map((r) => Math.round(r.top)));
      if (tops.size > 1) return true;
    }
    return false;
  };

  /** The kit's gaps between an icon and the words it leads, by the control's size (`--icon-gap`, `-sm`, `-lg`). */
  const iconGaps = () =>
    ["--icon-gap", "--icon-gap-sm", "--icon-gap-lg"]
      .map((t) => parseFloat(style(document.documentElement).getPropertyValue(t)))
      .filter((v) => v > 0);
  /** Words the eye reads: a text node laid out wider than a pixel (a visually hidden label is one pixel wide). */
  const visibleText = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || !seen(n.parentElement)) continue;
      if ([...textRange(n).getClientRects()].some((r) => r.width > 1 && r.height > 1)) return true;
    }
    return false;
  };
  /** Words a button has, shown or hidden at this width, but not a label only a screen reader reads (one pixel, clipped). */
  const hasWords = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const box = n.parentElement;
      const r = box.getBoundingClientRect();
      const clipped = r.width <= 1 && r.height <= 1 && style(box).position === "absolute";
      if (!clipped && !box.closest(".sr-only,.ac-sr-only,.visually-hidden")) return true;
    }
    return false;
  };
  /**
   * The glyph a flow child is, if it is only one: an `svg`, or a box around one and nothing else that shows. A control
   * (a button, a link) is its own thing, and an icon on a tile of its own (a surface: a connector's tile, a face) is
   * that tile.
   */
  const glyphOf = (el) => {
    if (el.tagName.toLowerCase() === "svg") return el;
    if (el.matches("button,a,[role=button]") || visibleText(el) || hasSurface(style(el))) return null;
    const svgs = [...el.querySelectorAll("svg")].filter(seen);
    if (svgs.length !== 1) return null;
    for (let p = svgs[0].parentElement; p && p !== el; p = p.parentElement) if (hasSurface(style(p))) return null;
    return svgs[0];
  };
  /** Where what shows of a flow child starts and ends: its glyph, its plate, or its words. */
  const inkOf = (el) => {
    const glyph = glyphOf(el);
    if (glyph) return glyph.getBoundingClientRect();
    if (hasSurface(style(el))) return el.getBoundingClientRect();
    return contentRect(el);
  };
  /** Pills, chips, tokens and buttons with words: the `pad` rule's family. */
  const PILLS =
    ".ac-btn:not(.ac-btn--icon,.ac-btn--glyph,.ac-btn--loading),.ac-token,.ac-chip,.ac-countchip,[class*='pill'],[class*='chip'],[class*='__tag'],[class*='-tag']";
  /**
   * A card: a row with a surface of its own that starts with an icon and ends with what can be done about it (a button,
   * a link) or another icon. Pills are the `pad` rule's.
   */
  const cards = () =>
    [...document.querySelectorAll("div,li,section,article,aside")].filter((el) => {
      // A list's row or an option has no corners of its own, a field is a field.
      if (!seen(el) || el.matches(`${PILLS},[role=option]`) || el.querySelector("input,textarea,[contenteditable]"))
        return false;
      const s = style(el);
      if (!s.display.includes("flex") || s.flexDirection.startsWith("column") || !hasSurface(s)) return false;
      if (!(parseFloat(s.borderTopLeftRadius) > 0 && parseFloat(s.borderBottomRightRadius) > 0)) return false;
      const kids = flow(el);
      if (kids.length < 3) return false;
      const last = kids[kids.length - 1];
      return Boolean(glyphOf(kids[0])) && (last.matches("button,a,[role=button]") || Boolean(glyphOf(last)));
    });

  const SIDES = ["Top", "Bottom", "Left", "Right"];
  const ROW_NAME = /(^|\s|[_-])(row|card|item)(\s|$|--)/;
  /**
   * The row or card an action sits in: the first box around it with a surface, or a list row: one named so, with padding
   * of its own. A layout wrapper around buttons (`.row`, a head's actions) has neither, and no edge to be close to.
   */
  const rowOf = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (
        p.matches(
          "main,[role=dialog],[role=alertdialog],.ac-dialog__foot,.ac-dialog__head,.ac-details,.ac-input-affix,.ac-seg,.ac-composer,.ac-token",
        )
      )
        return null;
      const s = style(p);
      if (painted(s.backgroundColor) || s.boxShadow !== "none") return { box: p, sides: SIDES };
      const lines = SIDES.filter((d) => parseFloat(s[`border${d}Width`]) > 0 && s[`border${d}Style`] !== "none");
      if (
        typeof p.className === "string" &&
        ROW_NAME.test(p.className) &&
        parseFloat(s.paddingTop) + parseFloat(s.paddingBottom) > 0
      )
        return { box: p, sides: [...new Set(["Top", "Bottom", ...lines])] };
      if (lines.length) return { box: p, sides: lines };
    }
    return null;
  };

  /** Laid out as a row: a flex row, or a grid of two or more columns. */
  const isRow = (s) =>
    (s.display.includes("flex") && !s.flexDirection.startsWith("column")) ||
    (s.display.includes("grid") && s.gridTemplateColumns.split(" ").length > 1);
  /** What a row can lead with besides a glyph: a face, a tile, a picture. */
  const FACE = ".ac-avatar,.ac-rolemark,img,canvas,video,picture";
  /** The box that lays `node` out: its parent, or past a `display: contents` one. */
  const layoutParent = (node) => {
    let p = node.parentElement;
    while (p && style(p).display === "contents") p = p.parentElement;
    return p;
  };
  /** The first words `el` shows: a text node laid out wider than a pixel. */
  const firstWords = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || !seen(n.parentElement) || n.parentElement.closest("textarea,select,svg")) continue;
      if ([...textRange(n).getClientRects()].some((r) => r.width > 1 && r.height > 1)) return n;
    }
    return null;
  };
  /**
   * A probe of no width as tall as the capitals of the font it sits in (`1cap` follows `font-size-adjust`). A tag and
   * `all: unset` of its own, so no page rule reaches it (`.newag__tip span { display: none }` hid a span).
   */
  const capProbe = () => {
    const p = document.createElement("geo-probe");
    p.style.cssText = "all:unset;display:inline-block;width:0;height:1cap;vertical-align:baseline";
    return p;
  };
  /** Its bottom is the line's baseline: where the capitals sit and their middle. */
  const capsOf = (probe) => {
    const r = probe.getBoundingClientRect();
    probe.remove();
    return { base: r.bottom, mid: r.bottom - r.height / 2 };
  };
  /**
   * The baseline and the capitals' middle of the line a text node starts on, by a probe right after its first letter: a
   * box of no width never moves to another line. A text node laid out straight in a flex or grid box is wrapped for
   * the moment, so the probe joins its line instead of becoming an item of its own.
   */
  const capsAt = (text, also) => {
    const at = text.data.search(/\S/);
    if (at < 0) return null;
    const host = layoutParent(text);
    const wrap = host && /flex|grid/.test(style(host).display) ? document.createElement("geo-probe") : null;
    if (wrap) {
      wrap.style.cssText = "all:unset";
      text.before(wrap);
      wrap.append(text);
    }
    const rest = text.splitText(at + 1);
    const probe = capProbe();
    rest.before(probe);
    // What is compared with the capitals, read while the probe is in: a probe in a line that fits exactly can push
    // the line's last item onto the next one, and a caller can tell by it.
    const beside = also?.();
    const caps = { ...capsOf(probe), beside };
    text.appendData(rest.data);
    rest.remove();
    if (wrap) {
      wrap.before(text);
      wrap.remove();
    }
    return caps;
  };
  /** The capitals' middle of the line an inline box sits on, by a probe right after it, in its parent's type. */
  const capsAfter = (el) => {
    const probe = capProbe();
    el.after(probe);
    return capsOf(probe);
  };
  const lineHeightOf = (el) => {
    const s = style(el);
    const lh = parseFloat(s.lineHeight);
    return Number.isFinite(lh) ? lh : parseFloat(s.fontSize) * 1.2;
  };
  /** The children of `el` as laid out, words in text nodes too: a `display: contents` box hands its own to its parent. */
  const flowNodes = (el) =>
    [...el.childNodes].flatMap((n) => {
      if (n.nodeType === 3) return n.textContent.trim() ? [n] : [];
      if (n.nodeType !== 1) return [];
      if (style(n).display === "contents") return flowNodes(n);
      return seen(n) && !["absolute", "fixed", "sticky"].includes(style(n).position) ? [n] : [];
    });
  const wordsOf = (node) => (node.nodeType === 3 ? node : firstWords(node));
  /** Two boxes on one line: they share more than half the shorter one's height. */
  const sameLine = (a, b) =>
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > Math.min(a.bottom - a.top, b.bottom - b.top) / 2;
  const textRects = (node) => [...textRange(node).getClientRects()].filter((r) => r.width > 1 && r.height > 1);
  /** The distinct lines a set of boxes covers, however their type sizes differ on each line. */
  const lineCount = (rects) => {
    const lines = [];
    for (const r of [...rects].sort((a, b) => a.top - b.top)) {
      const line = lines.find((l) => sameLine(l, r));
      if (line) {
        line.top = Math.min(line.top, r.top);
        line.bottom = Math.max(line.bottom, r.bottom);
      } else lines.push({ top: r.top, bottom: r.bottom });
    }
    return lines.length;
  };
  /** A list's row or item by its class: `.issue-list__row`, `.nt-item`, `.roles-row--base`, not `.home-row__face`. */
  const ROW_ITEM = /(^|\s|[_-])(row|item)(\s|$|--)/;
  /** Selected, current, picked or checked: a row that shows a plate at rest. */
  const PICKED =
    "[aria-selected=true],[aria-current]:not([aria-current=false]),[data-state=checked],.is-selected,.is-on,.is-cur,.is-picked,.is-active";
  /** The nearest box that clips or scrolls what runs past it. */
  const clipperOf = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = style(p);
      if (s.overflowX !== "visible" || s.overflowY !== "visible") return p;
    }
    return null;
  };
  /** A box shadow's layers drawn outside the box: offsets, blur and spread, each with a color that shows. */
  const outerShadows = (value) =>
    value === "none"
      ? []
      : value
          .split(/,(?![^(]*\))/)
          .filter((l) => !/\binset\b/.test(l))
          .map((l) => {
            const color = l.match(/rgba?\([^)]*\)|#[\da-f]+|[a-z]+(?=\s|$)/i)?.[0] ?? "";
            const [x = 0, y = 0, blur = 0, spread = 0] = (
              l.replace(/rgba?\([^)]*\)/, "").match(/-?[\d.]+px/g) ?? []
            ).map(parseFloat);
            return { x, y, blur, spread, color };
          })
          .filter((l) => painted(l.color));

  const rules = {
    edge(out) {
      // A ghost has no plate at rest: the eye reads its words, which stand inside the button's own padding.
      for (const el of document.querySelectorAll(".ac-btn:not(.ac-btn--ghost,.ac-btn--icon,.ac-btn--glyph)")) {
        if (!seen(el)) continue;
        const row = rowOf(el);
        if (!row || !seen(row.box) || words(row.box) === words(el)) continue;
        const a = el.getBoundingClientRect();
        // A capped card's body cuts what runs past its height under a fade and "See more" (`useCardCut`, which a captured
        // screen can't measure): an action there is cut, not on the card's edge.
        const cut = el.closest("[data-capped] > *");
        if (cut && row.box.contains(cut) && a.bottom > cut.getBoundingClientRect().bottom) continue;
        const b = row.box.getBoundingClientRect();
        const s = style(row.box);
        const inset = {
          Top: a.top - b.top - parseFloat(s.borderTopWidth),
          Bottom: b.bottom - a.bottom - parseFloat(s.borderBottomWidth),
          Left: a.left - b.left - parseFloat(s.borderLeftWidth),
          Right: b.right - a.right - parseFloat(s.borderRightWidth),
        };
        for (const side of row.sides) {
          if (inset[side] < EDGE_MIN - 0.25)
            out.push({
              rule: "edge",
              node: el,
              el: sig(el),
              box: sig(row.box),
              side,
              px: +inset[side].toFixed(1),
              text: words(el),
            });
        }
      }
    },
    pad(out) {
      for (const el of document.querySelectorAll(PILLS)) {
        if (!seen(el)) continue;
        const s = style(el);
        if (!hasSurface(s) || s.display === "inline") continue;
        const b = el.getBoundingClientRect();
        if (b.width > 320 || el.scrollWidth > el.clientWidth + 1) continue;
        // A face at the start of a pill sits concentric with its round end, tighter than the words at the other.
        if (el.firstElementChild?.matches(".ac-avatar,.ac-rolemark,canvas,[class*='face']")) continue;
        // A frame split into segments (an event pill's actions, each after a hairline) pads each one, not the whole.
        if (el.querySelector(":scope > [class*='__actions']")) continue;
        // Words that wrap end where their widest line does, not where the box does: the right side is their rag.
        if (wraps(el)) continue;
        const c = contentRect(el);
        if (!c) continue;
        const left = c.left - b.left;
        const right = b.right - c.right;
        if (left < 0 || right < 0) continue;
        if (Math.abs(left - right) > PAD_DIFF)
          out.push({
            rule: "pad",
            node: el,
            el: sig(el),
            left: +left.toFixed(1),
            right: +right.toFixed(1),
            text: words(el),
          });
      }
    },
    /** A card (`cards`): its first icon's glyph as far from its start as what ends it is from its end. */
    inset(out) {
      for (const el of cards()) {
        const kids = flow(el);
        const first = inkOf(kids[0]);
        const last = inkOf(kids[kids.length - 1]);
        if (!first || !last) continue;
        const b = el.getBoundingClientRect();
        const s = style(el);
        const left = first.left - b.left - parseFloat(s.borderLeftWidth);
        const right = b.right - parseFloat(s.borderRightWidth) - last.right;
        if (left < 0 || right < 0) continue;
        if (Math.abs(left - right) > PAD_DIFF)
          out.push({
            rule: "inset",
            node: el,
            el: sig(el),
            left: +left.toFixed(1),
            right: +right.toFixed(1),
            text: words(el),
          });
      }
    },
    /** In a pill or a card, the words an icon leads stand one of the kit's icon gaps from its glyph. */
    icongap(out) {
      const gaps = iconGaps();
      const want = gaps.join(" or ");
      const boxes = new Set([...document.querySelectorAll(PILLS)].filter(seen));
      for (const card of cards()) boxes.add(card);
      for (const box of boxes) {
        // An inline pill flows with its line's words and spaces, as the `pad` rule leaves it.
        if (style(box).display === "inline") continue;
        // A pill's sentence sits in a part of its frame (`__main`): its row is the one the icon is in.
        const rows = [box, ...box.querySelectorAll(":scope > [class*='__main']")];
        for (const row of rows) {
          // Words can be the row's own text, not a box of their own: its child nodes, not only its laid-out boxes.
          const nodes = [...row.childNodes].filter((n) =>
            n.nodeType === 3 ? n.textContent.trim() : n.nodeType === 1 && flow(row).includes(n),
          );
          const at = nodes.findIndex((n) => n.nodeType === 1 && glyphOf(n));
          const next = at >= 0 ? nodes[at + 1] : undefined;
          // Words, not another glyph or a count on its own plate.
          if (!next || (next.nodeType === 1 && (glyphOf(next) || !visibleText(next) || hasSurface(style(next)))))
            continue;
          const ink = next.nodeType === 3 ? textRange(next).getClientRects()[0] : contentRect(next);
          if (!ink) continue;
          const gap = ink.left - glyphOf(nodes[at]).getBoundingClientRect().right;
          if (!gaps.some((g) => Math.abs(gap - g) <= 1))
            out.push({ rule: "icongap", node: row, el: sig(row), px: +gap.toFixed(1), want, text: words(row) });
        }
      }
    },
    /**
     * A button that is only an icon is a square: its box, or the plate it shows on hover and focus when that is drawn
     * apart from its box (a `::before` set in from its sides, as `.ac-btn--glyph` does).
     */
    square(out) {
      // A select's trigger and a segmented control's part are sized by the control they belong to.
      const parts = "[role=combobox],[aria-haspopup=listbox],.ac-select__trigger,.ac-seg__item,[role=tab],[role=radio]";
      for (const el of document.querySelectorAll("button,a.ac-btn,[role=button]")) {
        if (!seen(el) || el.matches(parts) || hasWords(el)) continue;
        // One glyph: two side by side (a face and a +) are a pill of their own.
        if ([...el.querySelectorAll("svg")].filter(seen).length !== 1) continue;
        const b = el.getBoundingClientRect();
        const before = getComputedStyle(el, "::before");
        const plate =
          before.content !== "none" && before.position === "absolute"
            ? {
                width: b.width - (parseFloat(before.left) || 0) - (parseFloat(before.right) || 0),
                height: b.height - (parseFloat(before.top) || 0) - (parseFloat(before.bottom) || 0),
              }
            : b;
        const r = { width: plate.width, height: plate.height };
        if (Math.abs(r.width - r.height) > 0.5)
          out.push({
            rule: "square",
            node: el,
            el: sig(el),
            box: placeOf(el),
            w: +r.width.toFixed(1),
            h: +r.height.toFixed(1),
          });
      }
    },
    text(out) {
      for (const el of document.body.querySelectorAll("*")) {
        if (!seen(el) || el.closest("svg,canvas,pre,code,table,textarea,input")) continue;
        const s = style(el);
        if (ownText(el)) {
          const wide = el.scrollWidth - el.clientWidth;
          const tall = el.scrollHeight - el.clientHeight;
          const clips = (v) => v === "hidden" || v === "clip";
          if (clips(s.overflowX) && wide > 1 && s.textOverflow !== "ellipsis")
            out.push({ rule: "clipped", node: el, el: sig(el), px: wide, text: words(el) });
          if (clips(s.overflowY) && tall > 2 && s.webkitLineClamp === "none" && s.textOverflow !== "ellipsis")
            out.push({ rule: "clipped", node: el, el: sig(el), px: tall, text: words(el) });
        }
        if (el.children.length > 1 && s.display !== "inline") {
          // An inline box's rectangle spans every line it wraps on, and a float's words flow around it: neither overlaps.
          const kids = flow(el).filter((k) => {
            const ks = style(k);
            return (k.textContent ?? "").trim() && ks.display !== "inline" && ks.float === "none";
          });
          for (let i = 0; i < kids.length; i++) {
            for (let j = i + 1; j < kids.length; j++) {
              const a = kids[i].getBoundingClientRect();
              const b = kids[j].getBoundingClientRect();
              const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              const pulled = [kids[i], kids[j]].some(
                (k) => parseFloat(style(k).marginTop) < 0 || parseFloat(style(k).marginLeft) < 0,
              );
              if (ox > 2 && oy > 2 && !pulled)
                out.push({
                  rule: "overlap",
                  node: kids[i],
                  el: sig(kids[i]),
                  box: sig(kids[j]),
                  px: Math.round(Math.min(ox, oy)),
                  text: words(kids[i]),
                });
            }
          }
        }
      }
    },
    wordwrap(out) {
      for (const el of document.body.querySelectorAll("*")) {
        if (!ownText(el) || !seen(el) || el.closest("svg,pre,code,table")) continue;
        const parent = el.parentElement;
        const ps = style(parent);
        const row =
          (ps.display.includes("flex") && !ps.flexDirection.startsWith("column")) ||
          (ps.display.includes("grid") && ps.gridTemplateColumns.split(" ").length > 1);
        if (!row || flow(parent).length < 2) continue;
        const count = (el.textContent ?? "").trim().split(/\s+/).length;
        if (count < 3) continue;
        const tops = new Set();
        for (const n of el.childNodes)
          if (n.nodeType === 3) for (const r of textRange(n).getClientRects()) tops.add(Math.round(r.top));
        if (tops.size >= 3 && count / tops.size < 1.6)
          out.push({ rule: "wordwrap", node: el, el: sig(el), box: sig(parent), lines: tops.size, text: words(el) });
      }
    },
    viewport(out) {
      const over = document.documentElement.scrollWidth - innerWidth;
      if (over > 1) {
        // Named by what reaches furthest, or one baseline entry for "html" would let every page overflow.
        let far = innerWidth + 1;
        let culprit = null;
        for (const el of document.body.querySelectorAll("*")) {
          if (!seen(el) || inFloat(el) || contained(el)) continue;
          const right = el.getBoundingClientRect().right;
          if (right >= far) {
            far = right;
            culprit = el;
          }
        }
        out.push({ rule: "viewport", node: culprit, el: "html", box: culprit ? sig(culprit) : undefined, px: over });
      }
      for (const el of document.body.querySelectorAll("*")) {
        if (
          !(ownText(el) || el.matches("button,a,input,select,textarea")) ||
          !seen(el) ||
          inFloat(el) ||
          el.closest("svg")
        )
          continue;
        const r = el.getBoundingClientRect();
        // Entirely outside is a closed drawer.
        if (r.right <= innerWidth + 1 || r.left >= innerWidth || r.right <= 0 || contained(el)) continue;
        out.push({ rule: "viewport", node: el, el: sig(el), px: Math.round(r.right - innerWidth), text: words(el) });
      }
    },
    plate(out) {
      const q = ".ac-btn--icon,[class*='__remove'],[class*='tile'],[class*='plate'],[class*='__close']";
      for (const el of document.querySelectorAll(q)) {
        if (!seen(el) || el.children.length !== 1 || ownText(el)) continue;
        const icon = el.firstElementChild;
        if (icon.tagName.toLowerCase() !== "svg" || !seen(icon)) continue;
        const a = el.getBoundingClientRect();
        const b = icon.getBoundingClientRect();
        const dx = (a.left + a.right - b.left - b.right) / 2;
        const dy = (a.top + a.bottom - b.top - b.bottom) / 2;
        if (Math.abs(dx) > PLATE_DIFF || Math.abs(dy) > PLATE_DIFF)
          out.push({ rule: "plate", node: el, el: sig(el), dx: +dx.toFixed(1), dy: +dy.toFixed(1) });
      }
    },
    stack(out) {
      const q = ".ac-dialog__body,.ac-form,.ac-tabpanel,form";
      for (const el of document.querySelectorAll(q)) {
        if (!seen(el)) continue;
        const s = style(el);
        if (!s.display.includes("flex") || !s.flexDirection.startsWith("column")) continue;
        const want = parseFloat(s.rowGap);
        if (!(want > 0)) continue;
        const kids = flow(el);
        for (let i = 1; i < kids.length; i++) {
          const gap = kids[i].getBoundingClientRect().top - kids[i - 1].getBoundingClientRect().bottom;
          if (Math.abs(gap - want) > GAP_DIFF)
            out.push({
              rule: "stack",
              node: kids[i],
              el: `${sig(kids[i - 1])} + ${sig(kids[i])}`,
              box: sig(el),
              px: +gap.toFixed(1),
              want,
              text: words(kids[i]),
            });
        }
      }
    },
    /**
     * A side pane (`.thread-panel`: a thread, search, an agent's page, a task's conversation, Auditoria's details) on a
     * desktop window floats 10px in from the window's top, right and bottom, never touching its left, over a scrim
     * (the element right before it) that covers the whole window, the sidebar included. Phones take the whole screen.
     */
    floating(out) {
      if (innerWidth < DESKTOP_MIN) return;
      const GAP = 10;
      // An inline position is a test's own stand-in for a narrow window, not the app's layout.
      for (const pane of document.querySelectorAll(".thread-panel:not([style])")) {
        if (!seen(pane)) continue;
        const a = pane.getBoundingClientRect();
        const gaps = { Top: a.top - GAP, Right: innerWidth - a.right - GAP, Bottom: innerHeight - a.bottom - GAP };
        if (a.left < GAP) gaps.Left = a.left - GAP;
        const before = pane.previousElementSibling;
        const scrim = before?.matches(".thread-panel__scrim") ? before : null;
        const s = scrim?.getBoundingClientRect();
        const off = s
          ? Math.abs(s.left) + Math.abs(s.top) + Math.abs(innerWidth - s.right) + Math.abs(innerHeight - s.bottom)
          : Number.POSITIVE_INFINITY;
        if (off > 2)
          out.push({ rule: "floating", node: scrim ?? pane, el: sig(scrim ?? pane), box: sig(pane), side: "Scrim" });
        for (const [side, px] of Object.entries(gaps)) {
          if (Math.abs(px) > 0.5)
            out.push({
              rule: "floating",
              node: pane,
              el: sig(pane),
              box: sig(pane.parentElement),
              side,
              px: +px.toFixed(1),
            });
        }
      }
    },
    /** A message's head that shows its time with no name beside it: a face over a bare time reads as a broken line. */
    nameless(out) {
      for (const head of document.querySelectorAll(".ac-msg__head")) {
        if (!seen(head)) continue;
        const time = head.querySelector(".ac-msg__time");
        const name = head.querySelector(".ac-msg__author");
        if (!time || !seen(time)) continue;
        if (name && seen(name) && contentRect(name)) continue;
        out.push({ rule: "nameless", node: head, el: sig(head), box: placeOf(head), text: words(time) });
      }
    },
    /**
     * Two things side by side in a row, words next to a field, an icon, a pill or a button: at least the kit's smallest
     * gap between them. A box that shows a plate under the pointer (an in-place title, a link button) counts as its
     * whole box, the plate's, even at rest. A field's own affixes and a segmented control are drawn as one.
     */
    touch(out) {
      const control = (el) => {
        if (el.matches("button,input,textarea,select,svg,img,canvas,[role=button],[class*='pill'],[class*='chip']"))
          return true;
        const s = style(el);
        if (hasSurface(s)) return true;
        const parent = el.parentElement;
        return ["pointer", "text"].includes(s.cursor) && (!parent || style(parent).cursor !== s.cursor);
      };
      for (const row of document.body.querySelectorAll("*")) {
        if (!seen(row) || row.closest("svg,.ac-input-affix,.ac-seg")) continue;
        const s = style(row);
        if (!s.display.includes("flex") || s.flexDirection.startsWith("column")) continue;
        const kids = flow(row);
        for (let i = 1; i < kids.length; i++) {
          const [a, b] = [kids[i - 1], kids[i]];
          // Words on one side, a control on the other: two controls side by side (a toolbar's ghost buttons, a pill's
          // actions, faces in a stack) are drawn as one group.
          const ca = control(a);
          if (ca === control(b) || !((ca ? b : a).textContent ?? "").trim()) continue;
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          // Columns of a layout (a list beside a pane) are no inline items.
          if (Math.max(ra.height, rb.height) > INLINE_MAX) continue;
          // On different lines of a wrapping row: not side by side.
          if (Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) <= 0) continue;
          const gap = Math.max(rb.left - ra.right, ra.left - rb.right);
          if (gap < GAP_MIN - 0.25)
            out.push({
              rule: "touch",
              node: b,
              el: `${sig(a)} + ${sig(b)}`,
              box: sig(row),
              px: +gap.toFixed(1),
              text: words(b),
            });
        }
      }
    },
    /** A quiet line across the conversation sitting on a bubble above or under it, with no gap between them. */
    quiet(out) {
      const bubbles = [...document.querySelectorAll(".ac-msg__text")].filter(
        (b) => seen(b) && painted(style(b).backgroundColor),
      );
      for (const line of document.querySelectorAll(".consult-pair,.ac-divider,.channel__unread")) {
        if (!seen(line)) continue;
        const l = line.getBoundingClientRect();
        for (const b of bubbles) {
          const r = b.getBoundingClientRect();
          if (Math.min(l.right, r.right) - Math.max(l.left, r.left) <= 0) continue;
          const gap = Math.max(r.top - l.bottom, l.top - r.bottom);
          if (gap < QUIET_MIN)
            out.push({ rule: "quiet", node: line, el: sig(line), box: sig(b), px: +gap.toFixed(1), text: words(line) });
        }
      }
    },
    /**
     * A box that scrolls for a few px: margins, a border or rounding past its edge show a scrollbar (and let the wheel
     * nudge it) over content that, to the eye, fits.
     */
    sliver(out) {
      const SLIVER_MAX = 4;
      for (const el of document.body.querySelectorAll("*")) {
        const y = style(el).overflowY;
        if ((y !== "auto" && y !== "scroll") || el.matches("textarea,input,select") || !seen(el)) continue;
        const px = el.scrollHeight - el.clientHeight;
        if (px > 0 && px < SLIVER_MAX) out.push({ rule: "sliver", node: el, el: sig(el), px });
      }
    },
    /**
     * A square (a face, a tile, a picture or a box with a surface, 24 to 64px) leading a row, with words on three or more
     * lines beside it and nothing under it: it owns a column while the words are squeezed. Face, name and role go on one
     * line, the rest under them at the row's full width (MediaRow). A channel's or a thread's messages keep their face
     * column. A conversation with no faces (`data-faces="false"`, a DM whose sides say who spoke) shows none at all.
     */
    squarecol(out) {
      for (const face of document.querySelectorAll("[data-faces='false'] .ac-msg__avatar")) {
        if (seen(face)) out.push({ rule: "squarecol", node: face, el: sig(face), box: placeOf(face), lines: 0 });
      }
      for (const row of document.body.querySelectorAll("*")) {
        if (!seen(row) || row.matches(".ac-msg") || row.closest("svg") || !isRow(style(row))) continue;
        const kids = flow(row);
        if (kids.length < 2) continue;
        const square = kids[0];
        const r = square.getBoundingClientRect();
        if (r.width < 23.5 || r.width > 64.5 || Math.abs(r.width - r.height) > 1) continue;
        if (
          !square.matches(FACE) &&
          !square.querySelector(":scope > img, :scope > canvas") &&
          !hasSurface(style(square))
        )
          continue;
        const beside = [];
        for (const kid of kids.slice(1)) {
          const walker = document.createTreeWalker(kid, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent.trim() || !seen(n.parentElement)) continue;
            beside.push(...textRects(n).filter((t) => t.left >= r.right - 1));
          }
        }
        const lines = lineCount(beside);
        if (lines < 3) continue;
        const under = kids.slice(1).some((k) => {
          const b = k.getBoundingClientRect();
          return b.top >= r.bottom - 0.5 && b.left < r.right && b.right > r.left;
        });
        if (!under) out.push({ rule: "squarecol", node: square, el: sig(square), box: sig(row), lines });
      }
    },
    /**
     * A face or a mark in an option keeps the row's room around it while the option is highlighted: 6 above and below
     * (10 on touch) and 6 from its start, so it never touches the highlight's edge (OptionRow). A list row with a plate
     * at rest (a fill: selected, current) keeps 8 around its lead; one between hairlines, 8 above and below.
     */
    rim(out) {
      const touch = matchMedia("(pointer: coarse)").matches;
      const leadOf = (row) => {
        const first = flow(row)[0];
        if (!first) return null;
        const inner = first.matches(".ac-menu__leading") ? flow(first)[0] : first;
        return inner && (inner.matches(FACE) || inner.tagName.toLowerCase() === "svg") && seen(inner) ? inner : null;
      };
      const room = (lead, row) => {
        const a = lead.getBoundingClientRect();
        const b = row.getBoundingClientRect();
        const s = style(row);
        return {
          top: a.top - b.top - parseFloat(s.borderTopWidth),
          bottom: b.bottom - parseFloat(s.borderBottomWidth) - a.bottom,
          start: a.left - b.left - parseFloat(s.borderLeftWidth),
          end: b.right - parseFloat(s.borderRightWidth) - a.right,
        };
      };
      const options = new Set(
        [...document.querySelectorAll("[role=option],[role^=menuitem],.ac-menu__item")].filter(seen),
      );
      for (const opt of options) {
        const lead = leadOf(opt);
        if (!lead) continue;
        const had = opt.hasAttribute("data-highlighted");
        if (!had) opt.setAttribute("data-highlighted", "");
        const px = room(lead, opt);
        if (!had) opt.removeAttribute("data-highlighted");
        const block = touch ? 10 : 6;
        const short = [
          ["top", px.top, block],
          ["bottom", px.bottom, block],
          ["start", px.start, 6],
        ].find(([, v, want]) => v < want - 0.5);
        if (short)
          out.push({ rule: "rim", node: opt, el: sig(lead), box: sig(opt), side: short[0], px: +short[1].toFixed(1) });
      }
      for (const row of document.querySelectorAll("li,[role=row],[role=listitem],[class*='row'],[class*='item']")) {
        if (!seen(row) || options.has(row) || row.closest("[role=option],[role^=menuitem],.ac-menu__item,svg"))
          continue;
        if (!row.matches("li,[role=row],[role=listitem]") && !ROW_ITEM.test(row.className)) continue;
        const s = style(row);
        if (!isRow(s)) continue;
        // A plate (a fill, a shadow) shows every side; hairlines only the room above and below.
        const plate = painted(s.backgroundColor) || s.boxShadow !== "none";
        const lined = SIDES.some((d) => parseFloat(s[`border${d}Width`]) > 0 && s[`border${d}Style`] !== "none");
        if (!plate && !lined) continue;
        const lead = leadOf(row);
        if (!lead) continue;
        const px = room(lead, row);
        const short = (plate ? ["top", "bottom", "start"] : ["top", "bottom"])
          .map((side) => [side, px[side]])
          .find(([, v]) => v < 7.5);
        if (short)
          out.push({ rule: "rim", node: row, el: sig(lead), box: sig(row), side: short[0], px: +short[1].toFixed(1) });
      }
    },
    /**
     * Words right after an inline box that leads with a face or a glyph (an inline-flex name with its face) sit on the
     * baseline of that box's own words, within 0.5px. An inline-flex box's baseline is its first item's: a face's initial.
     */
    inlinebase(out) {
      for (const box of document.body.querySelectorAll("*")) {
        if (!seen(box) || !/^inline-(flex|grid)$/.test(style(box).display)) continue;
        const nodes = flowNodes(box);
        const lead = nodes[0];
        if (lead?.nodeType !== 1 || !(lead.matches(FACE) || glyphOf(lead))) continue;
        const own = nodes.slice(1).map(wordsOf).find(Boolean);
        if (!own) continue;
        let next = null;
        for (let at = box; at && !next; at = at.parentElement) {
          for (let n = at.nextSibling; n; n = n.nextSibling) {
            if (n.nodeType === 3 && n.textContent.trim()) next = n;
            else if (n.nodeType === 1 && seen(n) && style(n).display.startsWith("inline")) next = firstWords(n);
            if (next || (n.nodeType === 1 && seen(n))) break;
          }
          if (!at.parentElement || style(at.parentElement).display !== "inline") break;
        }
        if (!next) continue;
        const a = capsAt(own);
        const b = capsAt(next);
        if (!a || !b) continue;
        const px = b.base - a.base;
        // The words after it wrapped to the next line: no line to share.
        if (Math.abs(px) > lineHeightOf(box) / 2) continue;
        if (Math.abs(px) > 0.5)
          out.push({
            rule: "inlinebase",
            node: box,
            el: sig(box),
            box: placeOf(box),
            px: +px.toFixed(1),
            text: words(box),
          });
      }
    },
    /**
     * A glyph's middle on its line's capitals' middle, within 1px, where the eye centres a sign beside words: a row's
     * lead (a glyph, or a face no taller than 1.25 lines) on its first line, and a glyph inside or after words (an svg, or
     * a wordless box around one: a hint's ⓘ, a mark) on those words, in a line of text or in a row. A person's initials
     * sit within 0.5px of their tile's middle.
     */
    iconmid(out) {
      const push = (node, part, px, row) =>
        out.push({
          rule: "iconmid",
          node,
          el: sig(node),
          box: row ? sig(row) : placeOf(node),
          part,
          px: +px.toFixed(1),
        });
      const leads = new Set();
      for (const row of document.body.querySelectorAll("*")) {
        if (!seen(row) || row.closest("svg") || !isRow(style(row))) continue;
        const nodes = flowNodes(row);
        const lead = nodes[0];
        if (lead?.nodeType !== 1) continue;
        const mark = glyphOf(lead) ?? (lead.matches(FACE) ? lead : null);
        if (!mark) continue;
        const text = nodes.slice(1).map(wordsOf).find(Boolean);
        if (!text) continue;
        const box = mark.getBoundingClientRect();
        if (box.height > 1.25 * lineHeightOf(text.parentElement) + 0.5) continue;
        leads.add(mark);
        leads.add(lead);
        // A row that wrapped puts its words under the lead, not beside it: no line to share.
        const first = textRects(text)[0];
        if (!first || Math.min(first.bottom, box.bottom) <= Math.max(first.top, box.top)) continue;
        const caps = capsAt(text, () => mark.getBoundingClientRect());
        // The probe moved the lead (a line that fit exactly and wrapped): this layout can't be measured this way.
        if (!caps || Math.abs(caps.beside.top - box.top) > 0.5) continue;
        const px = (box.top + box.bottom) / 2 - caps.mid;
        if (Math.abs(px) > 1) push(lead, "lead", px, row);
      }
      for (const svg of document.body.querySelectorAll("svg")) {
        if (!seen(svg) || leads.has(svg) || svg.parentElement?.closest("svg,.ac-avatar,.ac-rolemark")) continue;
        let glyph = svg;
        for (let p = svg.parentElement; p && p !== document.body; p = p.parentElement) {
          const ps = style(p);
          if (ps.display === "contents") continue;
          if (visibleText(p) || hasSurface(ps) || [...p.querySelectorAll("svg")].filter(seen).length !== 1) break;
          if (p.matches("button,a,[role=button]") && !p.matches(".ac-hint")) break;
          if (style(glyph).display.startsWith("inline") && !ps.display.startsWith("inline")) break;
          glyph = p;
        }
        if (leads.has(glyph)) continue;
        const box = glyph.getBoundingClientRect();
        if (box.height < 8) continue;
        let caps = null;
        if (style(glyph).display.startsWith("inline")) {
          let line = glyph.parentElement;
          while (line && style(line).display === "inline") line = line.parentElement;
          if (!line || box.height > 1.25 * lineHeightOf(line) + 0.5) continue;
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          let shares = false;
          for (let n = walker.nextNode(); n && !shares; n = walker.nextNode()) {
            if (!n.textContent.trim() || glyph.contains(n) || !seen(n.parentElement)) continue;
            let inline = true;
            for (let p = n.parentElement; p && p !== line; p = p.parentElement)
              if (style(p).display !== "inline") inline = false;
            shares = inline && textRects(n).some((t) => sameLine(t, box));
          }
          if (shares) caps = capsAfter(glyph);
        } else {
          const row = layoutParent(glyph);
          if (!row || !isRow(style(row))) continue;
          const nodes = flowNodes(row);
          const at = nodes.indexOf(glyph);
          const words = at > 0 ? nodes[at - 1] : null;
          const before = words ? wordsOf(words) : null;
          if (!before || box.height > 1.25 * lineHeightOf(before.parentElement) + 0.5) continue;
          // After words on one line, on that line. In a row of two lines or more (a select's name and its line, a
          // setting's name over its value) a glyph ends the control, centred on it.
          const lines = [];
          const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode())
            if (n.textContent.trim() && !glyph.contains(n) && seen(n.parentElement)) lines.push(...textRects(n));
          if (lineCount(lines) === 1 && lines.some((t) => sameLine(t, box))) caps = capsAt(before);
        }
        if (!caps) continue;
        const px = (box.top + box.bottom) / 2 - caps.mid;
        if (Math.abs(px) > 1) push(glyph, "inline", px);
      }
      for (const face of document.querySelectorAll(".ac-avatar")) {
        if (!seen(face) || face.querySelector("img,canvas")) continue;
        const text = firstWords(face);
        const caps = text && capsAt(text);
        if (!caps) continue;
        const r = face.getBoundingClientRect();
        const px = caps.mid - (r.top + r.bottom) / 2;
        if (Math.abs(px) > 0.5) push(face, "initials", px);
      }
    },
    /**
     * In a stack of fields (a box holding two or more), each field's control is as wide as the field and as tall as the
     * stack's usual control, within 1 and 0.5px. A button that shows a value is drawn as a select, never a plain button.
     */
    fieldwidth(out) {
      const LABEL = ".ac-field__label,.ac-field__label-row,.ac-hintline";
      const TOGGLE =
        "[role=checkbox],[role=radio],[role=switch],[role=radiogroup],input[type=checkbox],input[type=radio]";
      const stacks = new Set();
      for (const field of document.querySelectorAll(".ac-field")) {
        const p = layoutParent(field);
        if (p && seen(field)) stacks.add(p);
      }
      for (const stack of stacks) {
        const pairs = flow(stack)
          .filter((f) => f.matches(".ac-field:not(.ac-field--inline)"))
          .map((field) => [field, flow(field).find((c) => !c.matches(LABEL))]);
        if (pairs.length < 2) continue;
        // What a person fills or picks: a help line in the control's place is no control.
        const CONTROL =
          "input,select,textarea,button,[role=combobox],[role=button],[contenteditable],.ac-select,.ac-seg,.ac-input-affix";
        const controls = pairs.filter(
          ([, c]) =>
            c && (c.matches(CONTROL) || c.querySelector(CONTROL)) && !c.matches(TOGGLE) && !c.querySelector(TOGGLE),
        );
        const count = new Map();
        for (const [, c] of controls) {
          const h = Math.round(c.getBoundingClientRect().height * 2) / 2;
          count.set(h, (count.get(h) ?? 0) + 1);
        }
        const usual = [...count].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
        for (const [field, control] of controls) {
          const fs = style(field);
          const inner =
            field.getBoundingClientRect().width -
            parseFloat(fs.paddingLeft) -
            parseFloat(fs.paddingRight) -
            parseFloat(fs.borderLeftWidth) -
            parseFloat(fs.borderRightWidth);
          const c = control.getBoundingClientRect();
          const base = { rule: "fieldwidth", node: control, el: sig(control), box: sig(field) };
          if (control.matches(".ac-btn")) out.push({ ...base, drawn: "button", text: words(control) });
          if (Math.abs(c.width - inner) > 1) out.push({ ...base, side: "width", px: +(c.width - inner).toFixed(1) });
          const tall = control.matches("textarea") || control.querySelector("textarea") || c.height > 2 * usual;
          if (!tall && Math.abs(c.height - usual) > 0.5)
            out.push({ ...base, side: "height", px: +(c.height - usual).toFixed(1) });
        }
      }
    },
    /**
     * A ring (an inset shadow, an outline, a border on both sides of a corner) whose corner meets the rounded inside
     * corner of the box clipping it is rounded as much, or the clip cuts it there. A row filled at rest (selected,
     * current) inside a rounded box, clear of its edges, has rounded corners of its own.
     */
    corner(out) {
      const CORNERS = [
        ["TopLeft", "Top", "Left"],
        ["TopRight", "Top", "Right"],
        ["BottomLeft", "Bottom", "Left"],
        ["BottomRight", "Bottom", "Right"],
      ];
      for (const el of document.body.querySelectorAll("*")) {
        if (!seen(el) || el.closest("svg")) continue;
        const s = style(el);
        const ringed = s.boxShadow.includes("inset") || (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0);
        const lined = (side) => parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== "none";
        const rung = CORNERS.filter(([, v, h]) => ringed || (lined(v) && lined(h)));
        const clip = rung.length ? clipperOf(el) : null;
        if (clip) {
          const cs = style(clip);
          const a = el.getBoundingClientRect();
          const b = clip.getBoundingClientRect();
          const edge = {
            Top: b.top + parseFloat(cs.borderTopWidth),
            Bottom: b.bottom - parseFloat(cs.borderBottomWidth),
            Left: b.left + parseFloat(cs.borderLeftWidth),
            Right: b.right - parseFloat(cs.borderRightWidth),
          };
          const at = { Top: a.top, Bottom: a.bottom, Left: a.left, Right: a.right };
          for (const [name, v, h] of rung) {
            const want = parseFloat(cs[`border${name}Radius`]) - parseFloat(cs[`border${v}Width`]);
            if (!(want > 0.5) || Math.abs(at[v] - edge[v]) > 1 || Math.abs(at[h] - edge[h]) > 1) continue;
            const own = parseFloat(s[`border${name}Radius`]);
            if (own < want - 0.5)
              out.push({ rule: "corner", node: el, el: sig(el), box: sig(clip), side: name, px: own, want });
          }
        }
        if (!el.matches(PICKED) || !painted(s.backgroundColor)) continue;
        if (CORNERS.some(([name]) => parseFloat(s[`border${name}Radius`]) > 0)) continue;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const ps = style(p);
          if (!CORNERS.some(([name]) => parseFloat(ps[`border${name}Radius`]) > 0)) continue;
          if (!hasSurface(ps) && ps.overflowX === "visible") continue;
          const a = el.getBoundingClientRect();
          const b = p.getBoundingClientRect();
          if (a.left > b.left + 1 && a.right < b.right - 1 && a.top > b.top + 1 && a.bottom < b.bottom - 1)
            out.push({ rule: "corner", node: el, el: sig(el), box: sig(p), side: "square" });
          break;
        }
      }
    },
    /**
     * A ring drawn outside a box (an outline, or a box shadow with a spread, or a blur of 2px at most) cut by the box that
     * clips or scrolls it, on a side where the box itself is inside it: a border that shows only at the corners.
     */
    clip(out) {
      for (const el of document.body.querySelectorAll("*")) {
        if (!seen(el) || el.closest("svg")) continue;
        const s = style(el);
        const reach = { top: 0, bottom: 0, left: 0, right: 0 };
        for (const l of outerShadows(s.boxShadow)) {
          if (!(l.spread > 0 || l.blur <= 2)) continue;
          const grow = l.spread + l.blur;
          reach.top = Math.max(reach.top, grow - l.y);
          reach.bottom = Math.max(reach.bottom, grow + l.y);
          reach.left = Math.max(reach.left, grow - l.x);
          reach.right = Math.max(reach.right, grow + l.x);
        }
        if (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) {
          const o = parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset);
          for (const side of Object.keys(reach)) reach[side] = Math.max(reach[side], o);
        }
        if (!Object.values(reach).some((v) => v > 0.5)) continue;
        const clip = clipperOf(el);
        if (!clip) continue;
        const cs = style(clip);
        const a = el.getBoundingClientRect();
        const b = clip.getBoundingClientRect();
        const pad = {
          top: b.top + parseFloat(cs.borderTopWidth),
          bottom: b.bottom - parseFloat(cs.borderBottomWidth),
          left: b.left + parseFloat(cs.borderLeftWidth),
          right: b.right - parseFloat(cs.borderRightWidth),
        };
        // A side of the clip on the window's own edge cuts nothing the window wouldn't.
        const cut = [
          ["top", cs.overflowY, pad.top > 0.5 && a.top >= pad.top - 0.5 && a.top - reach.top < pad.top - 0.5],
          [
            "bottom",
            cs.overflowY,
            pad.bottom < innerHeight - 0.5 &&
              a.bottom <= pad.bottom + 0.5 &&
              a.bottom + reach.bottom > pad.bottom + 0.5,
          ],
          ["left", cs.overflowX, pad.left > 0.5 && a.left >= pad.left - 0.5 && a.left - reach.left < pad.left - 0.5],
          [
            "right",
            cs.overflowX,
            pad.right < innerWidth - 0.5 && a.right <= pad.right + 0.5 && a.right + reach.right > pad.right + 0.5,
          ],
        ].find(([, overflow, hit]) => hit && overflow !== "visible");
        if (cut) out.push({ rule: "clip", node: el, el: sig(el), box: sig(clip), side: cut[0] });
      }
    },
    /**
     * A popover's own actions (its primary button, its actions' row, the field at its foot) cut by its box: scrolled out
     * of sight instead of pinned to its foot. The box, not the window: where a captured screen puts it isn't Radix's.
     */
    actions(out) {
      for (const pop of document.querySelectorAll(".ac-popover")) {
        if (!seen(pop)) continue;
        const p = pop.getBoundingClientRect();
        for (const el of pop.querySelectorAll(
          ".ac-btn--primary,[class*='actions'] > .ac-btn,[class*='__foot'] input",
        )) {
          if (!seen(el)) continue;
          const r = el.getBoundingClientRect();
          const px = Math.max(r.bottom - p.bottom, p.top - r.top);
          if (px > 0.5)
            out.push({ rule: "actions", node: el, el: sig(el), box: sig(pop), px: +px.toFixed(1), text: words(el) });
        }
      }
    },
  };

  /**
   * With everything rendered: a box skipped by `content-visibility: auto` (a conversation's rows) has its placeholder
   * size in one layout and its own in another, which no CSS order explains.
   */
  /**
   * A picture's own size (an image, a video, a canvas) waits on its file decoding, so the two tabs can catch it at
   * different moments: it is never a tie between two sheets, and `cascadeorder` leaves it out.
   */
  const LOADED = "img,image,video,canvas,iframe,object,embed";
  const orderValue = (el, s, p) =>
    (p === "width" || p === "height") && el.matches(LOADED) ? "" : s.getPropertyValue(p);
  const rendered = (measure) => {
    const pin = document.createElement("style");
    pin.textContent = "*{content-visibility:visible!important}";
    document.head.append(pin);
    try {
      return measure();
    } finally {
      pin.remove();
    }
  };

  window.geometry = {
    /** Puts a captured screen in the page and waits for the type its words use. */
    async load(html) {
      document.body.innerHTML = html;
      // The tests' DOM measures nothing, so a captured popover says it has no room (-24px) and its cap folds it to
      // nothing: it gets the window's, as Radix gives a card on a side with the room.
      for (const w of document.querySelectorAll("[data-radix-popper-content-wrapper]")) {
        if (parseFloat(w.style.getPropertyValue("--radix-popper-available-height")) <= 0)
          w.style.setProperty("--radix-popper-available-height", "calc(100vh - 24px)");
      }
      await document.fonts.ready;
    },
    detect() {
      seenOf = new Map();
      const out = [];
      for (const rule of Object.values(rules)) rule(out);
      return out.map(({ node, ...f }) => (kitOnly(f.el) && kitOnly(f.box) && node ? { ...f, at: placeOf(node) } : f));
    },
    /**
     * `cascadeorder`: one hash per element over what a tie between two sheets can change, for `check.ts` to compare
     * the screen laid out in two CSS orders, then the values of the ones that differ.
     */
    styles() {
      return rendered(() =>
        [...document.body.querySelectorAll("*")].map((el) => {
          const s = getComputedStyle(el);
          let h = 0x811c9dc5;
          for (const p of ORDER_PROPS) {
            const v = orderValue(el, s, p);
            for (let i = 0; i < v.length; i++) h = Math.imul(h ^ v.charCodeAt(i), 16777619);
            h = Math.imul(h ^ 0x7c, 16777619);
          }
          return h >>> 0;
        }),
      );
    },
    styleOf(indices) {
      return rendered(() => {
        const all = [...document.body.querySelectorAll("*")];
        const index = new Map(all.map((el, i) => [el, i]));
        return indices.map((i) => {
          const el = all[i];
          const s = getComputedStyle(el);
          const signature = sig(el);
          return {
            el: signature,
            at: kitOnly(signature) ? placeOf(el) : undefined,
            parent: index.get(el.parentElement) ?? -1,
            props: ORDER_PROPS,
            values: ORDER_PROPS.map((p) => orderValue(el, s, p)),
          };
        });
      });
    },
  };
})();
