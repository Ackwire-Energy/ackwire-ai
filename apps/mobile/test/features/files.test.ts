import { describe, expect, test } from "bun:test";
import type { ArtifactDetail } from "@agenteschat/client";
import {
  decodeFileList,
  driveWebUrl,
  encodeFileList,
  extensionOf,
  extLabel,
  fileInfo,
  resolveDownloadUrl,
  safeFileName,
  shareSource,
  singleImageHeight,
  utf8Bytes,
  withExtension,
} from "../../src/features/files/logic";
import { clampZoomTranslate, containSize, doubleTapZoom, MAX_ZOOM, zoomAround } from "../../src/features/files/zoom";

type Input = Pick<ArtifactDetail, "kind" | "title" | "content">;
const upload = (name: string, contentType: string, size = 1000, text?: string): Input => ({
  kind: "file",
  title: name,
  content: { kind: "file", name, contentType, size, sha256: "x", ...(text !== undefined ? { text } : {}) },
});

describe("file kind, tile and size", () => {
  test("raster pictures are images; SVG is not", () => {
    expect(fileInfo(upload("home.png", "image/png")).view).toBe("image");
    expect(fileInfo(upload("foto.JPG", "image/jpeg; charset=binary")).view).toBe("image");
    expect(fileInfo(upload("logo.svg", "image/svg+xml")).view).toBe("other");
    expect(fileInfo(upload("logo.svg", "image/svg+xml")).type).toBe("image");
  });

  test("PDF, Markdown and text open in the document screen", () => {
    const pdf = fileInfo(upload("Relatório.pdf", "application/pdf", 2048));
    expect(pdf).toMatchObject({ view: "pdf", type: "pdf", ext: "PDF", size: 2048, name: "Relatório.pdf" });
    expect(fileInfo(upload("notes.md", "application/octet-stream")).view).toBe("markdown");
    expect(fileInfo(upload("notes.md", "text/markdown")).type).toBe("document");
    const csv = fileInfo(upload("vendas.csv", "text/csv"));
    expect(csv).toMatchObject({ view: "text", type: "table", ext: "CSV" });
    expect(fileInfo(upload("log.txt", "text/plain")).type).toBe("text");
  });

  test("other files are cards with their type", () => {
    expect(fileInfo(upload("backup.zip", "application/zip"))).toMatchObject({
      view: "other",
      type: "archive",
      ext: "ZIP",
    });
    expect(fileInfo(upload("sem-extensao", "application/octet-stream"))).toMatchObject({ type: "file", ext: "" });
  });

  test("a document artifact: title with .md, size from its text", () => {
    const doc = fileInfo({
      kind: "document",
      title: "Resumo da home",
      content: { kind: "document", markdown: "Olá é" },
    });
    expect(doc).toMatchObject({ name: "Resumo da home.md", view: "markdown", type: "document", ext: "MD", size: 7 });
    const table = fileInfo({ kind: "table", title: "Vendas", content: { kind: "table", columns: [], rows: [] } });
    expect(table).toMatchObject({ name: "Vendas.csv", view: "other", type: "table", size: null });
  });

  test("helpers", () => {
    expect(extensionOf("a.tar.GZ")).toBe("gz");
    expect(extensionOf("README")).toBe("");
    expect(extLabel("jpeg")).toBe("JPEG");
    expect(extLabel("markdown")).toBe("MARK");
    expect(withExtension("x.md", "md")).toBe("x.md");
    expect(withExtension("x", "md")).toBe("x.md");
    expect(utf8Bytes("a")).toBe(1);
    expect(utf8Bytes("ç")).toBe(2);
    expect(utf8Bytes("€")).toBe(3);
    expect(utf8Bytes("😀")).toBe(4);
  });
});

describe("pictures in a message", () => {
  test("a lone picture keeps its shape, within limits", () => {
    expect(singleImageHeight(300, null)).toBe(225);
    expect(singleImageHeight(300, { width: 1000, height: 1000 })).toBe(300);
    expect(singleImageHeight(300, { width: 1170, height: 2532 })).toBe(533); // a phone screenshot: 9:16 at most
    expect(singleImageHeight(300, { width: 4000, height: 500 })).toBe(150); // a panorama: 2:1 at most
  });
});

describe("shared copies", () => {
  test("safe names: no folders, no refused characters, never empty, extension kept", () => {
    expect(safeFileName("../../etc/passwd")).toBe("-..-etc-passwd");
    expect(safeFileName('a:b*c?"d<e>f|g.png')).toBe("a-b-c--d-e-f-g.png");
    expect(safeFileName("  .hidden. ")).toBe("hidden");
    expect(safeFileName("line\nbreak\u0000.txt")).toBe("linebreak.txt");
    expect(safeFileName("   ")).toBe("file");
    const long = safeFileName(`${"a".repeat(300)}.pdf`);
    expect(long.length).toBe(120);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  test("where the copy comes from", () => {
    expect(shareSource({ kind: "document", title: "Plano", content: { kind: "document", markdown: "# Oi" } })).toEqual({
      from: "text",
      text: "# Oi",
      name: "Plano.md",
      mime: "text/markdown",
    });
    expect(
      shareSource({ kind: "table", title: "Vendas", content: { kind: "table", columns: [], rows: [] } }),
    ).toMatchObject({ from: "export", format: "csv", name: "Vendas.csv" });
    expect(shareSource(upload("home/print.png", "image/png"))).toEqual({
      from: "download",
      name: "home-print.png",
      mime: "image/png",
    });
  });

  test("download links: signed links as they are, ours with the session", () => {
    expect(resolveDownloadUrl("https://app.agentes.chat", "https://bucket.s3/x?sig=1")).toEqual({
      uri: "https://bucket.s3/x?sig=1",
      needsSession: false,
    });
    expect(resolveDownloadUrl("https://app.agentes.chat", "https://app.agentes.chat.attacker.test/file")).toEqual({
      uri: "https://app.agentes.chat.attacker.test/file",
      needsSession: false,
    });
    expect(resolveDownloadUrl("https://app.agentes.chat", "https://app.agentes.chat/file")).toEqual({
      uri: "https://app.agentes.chat/file",
      needsSession: true,
    });
    expect(
      resolveDownloadUrl("https://app.agentes.chat/", "/api/app/organizations/o/artifacts/a/file?version=2"),
    ).toEqual({
      uri: "https://app.agentes.chat/api/app/organizations/o/artifacts/a/file?version=2",
      needsSession: true,
    });
  });

  test("the web Drive at the file", () => {
    expect(driveWebUrl("https://app.agentes.chat/", "org1", "a1")).toBe(
      "https://app.agentes.chat/org/org1/drive?artifact=a1",
    );
    expect(driveWebUrl("https://app.agentes.chat", "org1", "a1", 3)).toBe(
      "https://app.agentes.chat/org/org1/drive?artifact=a1&v=3",
    );
  });
});

describe("viewer", () => {
  test("the route's file list round-trips and drops junk", () => {
    const list = [{ id: "a-1", version: 2 }, { id: "b_2" }];
    expect(decodeFileList(encodeFileList(list))).toEqual(list);
    expect(decodeFileList("a@0,../x,b@x,c@3")).toEqual([{ id: "a" }, { id: "b" }, { id: "c", version: 3 }]);
    expect(decodeFileList(undefined)).toEqual([]);
  });

  test("zoom keeps the point under the fingers still and stays inside the picture", () => {
    expect(zoomAround({ x: 0, y: 0 }, 1, 2, 50, -20)).toEqual({ x: -50, y: 20 });
    expect(zoomAround({ x: 0, y: 0 }, 1, 2, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(clampZoomTranslate(500, -500, 2, 400, 800)).toEqual({ x: 200, y: -400 });
    expect(clampZoomTranslate(30, 10, 1, 400, 800)).toEqual({ x: 0, y: 0 });
    // A wide banner drawn 400×100: zoomed 4× it is 1600×400, shorter than the screen, so it can't move up or down.
    expect(clampZoomTranslate(9999, 9999, 4, 400, 800, 400, 100)).toEqual({ x: 600, y: 0 });
    expect(containSize(3600, 900, 400, 800)).toEqual({ w: 400, h: 100 });
    expect(containSize(0, 0, 400, 800)).toEqual({ w: 400, h: 800 });
    expect(doubleTapZoom(400, 100, 400, 800)).toBe(MAX_ZOOM);
    expect(doubleTapZoom(400, 600, 400, 800)).toBe(2.5);
  });
});
