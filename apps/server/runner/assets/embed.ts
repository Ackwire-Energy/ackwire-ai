import { readFileSync } from "node:fs";

/**
 * A file of this folder as base64. Imported `with { type: "macro" }`: Bun runs it while it builds (or
 * transpiles) the importing module and puts the string in its place, so the runner stays one file with its
 * images in it. Bun's own loaders can't: `text` mangles binary and `file` writes the file next to the bundle.
 */
export function base64(name: string): string {
  return readFileSync(new URL(name, import.meta.url)).toString("base64");
}
