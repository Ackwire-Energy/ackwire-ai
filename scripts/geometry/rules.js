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
        !el.closest(".sr-only,.ac-sr-only,.visually-hidden,.ac-visually-hidden,[hidden],[inert]");
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
  /** The nearest box that clips the words of `el` sideways, unless its "…" reaches them (inline all the way down). */
  const cutBy = (el) => {
    let inline = style(el).display === "inline";
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ps = style(p);
      if (ps.overflowX === "hidden" || ps.overflowX === "clip")
        return inline && ps.textOverflow === "ellipsis" ? null : p;
      if (ps.overflowX !== "visible") return null;
      inline = inline && ps.display === "inline";
    }
    return null;
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
          // Cut by a box around it instead: that box's "…" reaches only words on its own lines, not a block inside it
          // (a picker's two lines, a flex column), so they stop mid-word at its edge.
          const by = clips(s.overflowX) ? null : cutBy(el);
          if (by) {
            const edge = by.getBoundingClientRect().left + by.clientLeft + by.clientWidth;
            let start = Infinity;
            let end = -Infinity;
            for (const n of el.childNodes) {
              if (n.nodeType !== 3 || !n.textContent.trim()) continue;
              for (const r of textRange(n).getClientRects()) {
                if (r.width <= 0) continue;
                start = Math.min(start, r.left);
                end = Math.max(end, r.right);
              }
            }
            if (start < edge && end - edge > 1)
              out.push({
                rule: "clipped",
                node: el,
                el: sig(el),
                box: placeOf(el),
                px: Math.round(end - edge),
                text: words(el),
              });
          }
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
    /**
     * Words broken inside themselves: more lines than words, so the box is narrower than its own words. `wordwrap` looks
     * only at text right inside a row; this catches it however deep the row that squeezes it is (a title beside a bar's
     * buttons, wrapped in a link or an edit-in-place).
     */
    midword(out) {
      for (const el of document.body.querySelectorAll("*")) {
        if (!ownText(el) || !seen(el) || el.closest("svg,pre,code,table")) continue;
        let count = 0;
        const tops = new Set();
        for (const n of el.childNodes) {
          if (n.nodeType !== 3) continue;
          count += n.textContent.trim().split(/\s+/).filter(Boolean).length;
          for (const r of textRange(n).getClientRects()) if (r.width > 0) tops.add(Math.round(r.top));
        }
        if (count >= 2 && tops.size >= 3 && tops.size > count)
          out.push({ rule: "midword", node: el, el: sig(el), box: placeOf(el), lines: tops.size, text: words(el) });
      }
    },
    /** A line its "…" leaves a letter or two of ("O…" for an agent's name): it says nothing, the row gave it no room. */
    stub(out) {
      for (const el of document.body.querySelectorAll("*")) {
        if (!ownText(el) || !seen(el) || el.closest("svg,pre,code,table,textarea,input")) continue;
        const s = style(el);
        // An inline box has no width of its own (`clientWidth` 0) and draws no "…": its block does.
        if (s.display === "inline" || s.textOverflow !== "ellipsis" || !["hidden", "clip"].includes(s.overflowX))
          continue;
        if (words(el).length <= 3 || el.clientWidth >= 2.5 * parseFloat(s.fontSize)) continue;
        // Its words' own width: with an ellipsis `scrollWidth` can stay a pixel past the box however much it cut ("Otto" in
        // 34px read "O…" with 35).
        let natural = el.scrollWidth;
        for (const n of el.childNodes)
          if (n.nodeType === 3) natural = Math.max(natural, textRange(n).getBoundingClientRect().width);
        if (natural - el.clientWidth > 0.5)
          out.push({ rule: "stub", node: el, el: sig(el), box: placeOf(el), px: el.clientWidth, text: words(el) });
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
  };
})();
