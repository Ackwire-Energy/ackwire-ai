import { bodyTones, drawAgent } from "@agenteschat/ui/agent/engine";
import { Canvas, createPicture, Picture } from "@shopify/react-native-skia";
import { useMemo } from "react";
import { useTheme } from "@/ui/theme";
import type { AgentLookInput } from "./looks";
import { asCtx, compile, RecordingContext } from "./recorder";
import { replay } from "./skia-ctx";

/** An open pixel book: P page, L text line, C the cover (agent's tone), S the spine (the web's, `MemoryPixels`). */
const BOOK = ["..PPPP.PPPP..", ".PLLLPSPLLLP.", ".PLLPPSPLLPP.", "CPPPPPSPPPPPC", ".CCCCCSCCCCC."];
export const BOOK_W = 30;
export const BOOK_H = 24;
/** The pages and their lines, as the web's `--book-page` and `--book-line`. */
const PAPER = { light: { page: "#fffdf6", line: "#cfc8b6" }, dark: { page: "#ebe6d8", line: "#a59e8c" } };

/**
 * The memory mark's picture, as the web's `AgentReadingBook`: the agent, drawn by the engine in its own colors,
 * eyes down on an open pixel book. Still (the web turns a page on hover; a phone has none). Decorative: the caller
 * names it.
 */
export function AgentReadingBook({ look }: { look: Pick<AgentLookInput, "color" | "eyes"> }) {
  const { scheme } = useTheme();
  const paper = PAPER[scheme === "dark" ? "dark" : "light"];
  const picture = useMemo(() => {
    const rec = new RecordingContext();
    const side = 20;
    drawAgent(asCtx(rec), (BOOK_W - side) / 2, 0, side, {
      color: look.color,
      eyes: look.eyes,
      cells: 10,
      pose: { look: [0, 0.06], turn: [0, 0.12] },
    });
    const tones = bodyTones(look.color);
    const u = 2;
    const ox = Math.round((BOOK_W - 13 * u) / 2);
    const oy = BOOK_H - 5 * u;
    const fill: Record<string, string | undefined> = { P: paper.page, L: paper.line, C: tones[1], S: tones[0] };
    BOOK.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        const color = fill[ch];
        if (!color) return;
        rec.fillStyle = color;
        rec.fillRect(ox + x * u, oy + y * u, u, u);
      });
    });
    const commands = compile(rec.commands);
    return createPicture((canvas) => replay(canvas, commands), { width: BOOK_W, height: BOOK_H });
  }, [look.color, look.eyes, paper.page, paper.line]);
  return (
    <Canvas style={{ width: BOOK_W, height: BOOK_H }}>
      <Picture picture={picture} />
    </Canvas>
  );
}
