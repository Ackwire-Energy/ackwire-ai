import { closeSync, constants, fstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** The file's JSON, or null when it is missing or not JSON. */
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * A file's JSON when it is a plain file of at most `maxBytes`, else null. Never follows a link, and never waits on
 * a pipe put in its place (root reads folders an agent's user had: a blocked open would hang it).
 */
export function readJsonNoFollow(file: string, maxBytes: number): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    return st.isFile() && st.size <= maxBytes ? JSON.parse(readFileSync(fd, "utf8")) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Written whole (mode 600), then renamed: a crash never leaves half a file. */
export function writeJson(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}
