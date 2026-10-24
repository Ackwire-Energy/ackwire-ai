import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** The file's JSON, or null when it is missing or not JSON. */
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Written whole (mode 600), then renamed: a crash never leaves half a file. */
export function writeJson(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}
