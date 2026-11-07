/*
 * The layout rules, run inside Chromium on a laid-out screen. Each finding names its element by its classes, never by
 * its words or size, so a baseline entry survives new copy and only a new offender is new.
 */
(() => {
  const EDGE_MIN = 8;
  /** A quiet line (the agents' pair, a date, "Novas") and a bubble: closer than this reads as touching. */
  const QUIET_MIN = 4;
  const PAD_DIFF = 2;
  const PLATE_DIFF = 1;
  const GAP_DIFF = 1.5;

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
      const q =
        ".ac-btn:not(.ac-btn--icon,.ac-btn--glyph,.ac-btn--loading),.ac-token,.ac-chip,.ac-countchip,[class*='pill'],[class*='chip'],[class*='__tag'],[class*='-tag']";
      for (const el of document.querySelectorAll(q)) {
        if (!seen(el)) continue;
        const s = style(el);
        if (!hasSurface(s) || s.display === "inline") continue;
        const b = el.getBoundingClientRect();
        if (b.width > 320 || el.scrollWidth > el.clientWidth + 1) continue;
        // A face at the start of a pill sits concentric with its round end, tighter than the words at the other.
        if (el.firstElementChild?.matches(".ac-avatar,.ac-rolemark,canvas,[class*='face']")) continue;
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
  };

  window.geometry = {
    /** Puts a captured screen in the page and waits for the type its words use. */
    async load(html) {
      document.body.innerHTML = html;
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
