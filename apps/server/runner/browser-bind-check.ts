import type { EventEmitter } from "node:events";
import { createServer } from "node:net";

export type BindAttempt = (host: string, port: number) => Promise<string>;

const attemptBind: BindAttempt = (host, port) =>
  new Promise((resolve) => {
    const server = createServer();
    (server as unknown as EventEmitter).once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve("bound")));
  });

/** Called in the agent slice before its worker starts; test the actual kernel result. */
export async function verifyBrowserBindPolicy(
  forbidden: number,
  allowed: number[],
  attempt: BindAttempt = attemptBind,
) {
  if (
    !Number.isInteger(forbidden) ||
    forbidden < 1 ||
    forbidden > 65_535 ||
    allowed.length !== 3 ||
    allowed.some((p) => !Number.isInteger(p) || p < 0 || p > 65_535)
  ) {
    throw new Error("Invalid browser bind policy self-check ports");
  }
  for (const host of ["127.0.0.1", "::1"]) {
    for (const deniedPort of [forbidden, 0]) {
      const result = await attempt(host, deniedPort);
      if (result !== "EPERM" && result !== "EACCES") {
        throw new Error(`Browser bind isolation failed for ${host}:${deniedPort}: ${result}`);
      }
    }
    for (const allowedPort of allowed) {
      if (allowedPort === 0) continue; // An already-running browser owns this port.
      const result = await attempt(host, allowedPort);
      if (result !== "bound") {
        throw new Error(`Browser bind allow failed for ${host}:${allowedPort}: ${result}`);
      }
    }
  }
}
