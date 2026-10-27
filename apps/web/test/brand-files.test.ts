import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readdirSync } from "node:fs";
import { PROVIDER_MARKS } from "@agenteschat/ui/brand/marks";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { DatabaseIcon } from "@/components/DatabaseConnect";
import { POSTGRES_MARK } from "@/lib/brands";

afterEach(() => cleanup());

const BRANDS = new URL("../public/brands/", import.meta.url).pathname;

describe("the brand files the app serves", () => {
  test("every SVG is a drawing on the 24×24 grid that runs nothing and loads nothing", async () => {
    const svgs = readdirSync(BRANDS).filter((name) => name.endsWith(".svg"));
    expect(svgs).toContain("postgresql.svg");
    for (const name of svgs) {
      const svg = await Bun.file(BRANDS + name).text();
      expect([name, /<svg\b[^>]*\sviewBox="0 0 24 24"/.test(svg)]).toEqual([name, true]);
      expect([name, svg.match(/<script|<style|<foreignObject|\sstyle\s*=|\son[a-z]+\s*=/gi)]).toEqual([name, null]);
      // Links only to the file's own ids (`href="#a"`, `url(#a)`), never out.
      expect([name, svg.match(/href\s*=\s*["'](?!#)|url\(\s*["']?(?![#"'])/gi)]).toEqual([name, null]);
    }
  });

  test("each AI maker's image mark is a file here, 128 px square", async () => {
    const images = Object.values(PROVIDER_MARKS).flatMap((mark) => ("image" in mark ? [mark.image] : []));
    expect(images).toEqual(["/brands/gemini.png"]);
    for (const image of images) {
      const png = new DataView(await Bun.file(new URL(`../public${image}`, import.meta.url).pathname).arrayBuffer());
      // The PNG signature, then the header's width and height.
      expect([image, png.getUint32(0), png.getUint32(16), png.getUint32(20)]).toEqual([image, 0x89504e47, 128, 128]);
    }
  });

  test("the database connector draws PostgreSQL's own mark, in its own colors", () => {
    const tile = render(createElement(DatabaseIcon, { size: "lg" })).container.firstElementChild as HTMLElement;
    expect(tile.className).toBe("connector-icon connector-icon--lg connector-icon--brand");
    const img = tile.querySelector("img");
    expect([img?.className, img?.getAttribute("src"), img?.getAttribute("alt")]).toEqual([
      "connector-icon__img",
      "/brands/postgresql.svg",
      "",
    ]);
    expect(POSTGRES_MARK).toBe("/brands/postgresql.svg");
  });
});
