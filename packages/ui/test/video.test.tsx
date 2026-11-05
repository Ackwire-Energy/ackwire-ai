import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { claimPlayback, releasePlayback, stopPlayback } from "../src/components/media-playback";
import { VideoPlayer, type VideoPlayerProps } from "../src/components/VideoPlayer";

afterEach(() => cleanup());

const labels: VideoPlayerProps["labels"] = {
  play: "Tocar",
  pause: "Pausar",
  replay: "Ver de novo",
  seek: "Posição no vídeo",
  volume: "Volume",
  mute: "Tirar o som",
  unmute: "Ligar o som",
  speed: (s) => `Velocidade ${s}×`,
  fullscreen: "Tela cheia",
  exitFullscreen: "Sair da tela cheia",
  open: "Abrir",
};
const player = (props: Partial<VideoPlayerProps> = {}) =>
  render(<VideoPlayer src="/f?version=2" name="abertura.mp4" size="7,5 MB" labels={labels} {...props} />);

describe("VideoPlayer", () => {
  test("stopped: the first frame, a play key named after the file, the caption and the corner button", () => {
    let opened = 0;
    player({ onOpen: () => opened++ });
    const video = document.querySelector("video");
    // `#t`: the first frame shows before it plays; only its details load until then.
    expect(video?.getAttribute("src")).toBe("/f?version=2#t=0.001");
    expect(video?.getAttribute("preload")).toBe("metadata");
    expect(screen.getByRole("button", { name: "Tocar: abertura.mp4" })).toBeTruthy();
    expect(document.querySelector(".ac-video__caption")?.textContent).toContain("abertura.mp4");
    expect(document.querySelector(".ac-video__caption")?.textContent).toContain("7,5 MB");
    // The bar waits, out of the tab order, until it plays.
    expect(document.querySelector(".ac-video__bar")?.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));
    expect(opened).toBe(1);
  });

  test("the viewer has no caption and no corner button", () => {
    player({ variant: "viewer", onOpen: () => undefined });
    expect(document.querySelector(".ac-video__caption")).toBeNull();
    expect(screen.queryByRole("button", { name: "Abrir" })).toBeNull();
  });

  test("a video that can't play here says so to the caller", () => {
    let failed = 0;
    player({ onFailed: () => failed++ });
    const video = document.querySelector("video");
    if (!video) throw new Error("no video");
    fireEvent.error(video);
    expect(failed).toBe(1);
  });

  test("speed goes 1×, 1.5×, 2× and back", () => {
    player();
    const speed = () => screen.getByRole("button", { name: /^Velocidade/, hidden: true });
    expect(speed().textContent).toBe("1×");
    fireEvent.click(speed());
    expect(speed().textContent).toBe("1.5×");
    fireEvent.click(speed());
    fireEvent.click(speed());
    expect(speed().textContent).toBe("1×");
  });
});

describe("one thing plays at a time", () => {
  test("claiming stops the one before; releasing forgets it", () => {
    const stopped: string[] = [];
    const a = () => stopped.push("a");
    const b = () => stopped.push("b");
    claimPlayback(a);
    claimPlayback(b);
    expect(stopped).toEqual(["a"]);
    releasePlayback(b);
    stopPlayback();
    expect(stopped).toEqual(["a"]);
    claimPlayback(a);
    stopPlayback();
    expect(stopped).toEqual(["a", "a"]);
  });
});
