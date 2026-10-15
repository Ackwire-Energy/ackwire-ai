/**
 * Registers the agents' computer image as a Daytona snapshot (D30), then
 * checks it: `bun apps/server/scripts/sandbox-snapshot.ts [name]` (reads
 * `.env`: DAYTONA_API_KEY, optional DAYTONA_API_URL / DAYTONA_TARGET).
 *
 * Builds infra/sandbox/Dockerfile on Daytona (POST /snapshots with the
 * Dockerfile content), waits until it is active, starts one sandbox from it
 * (no network) and runs `node -v`, `npm -v`, `pnpm -v`, `yarn -v`, gcc, go, cargo, sudo and
 * `python3 -c "import pandas, matplotlib"`, then deletes that sandbox. Set
 * SANDBOX_SNAPSHOT to the name afterwards. Never part of `bun test`.
 */
import { resolve } from "node:path";
import { createDaytonaSandboxProvider } from "@agenteschat/adapters";
import { loadConfig } from "@agenteschat/config";

const config = loadConfig();
const key = config.DAYTONA_API_KEY;
if (!key) {
  console.error("Set DAYTONA_API_KEY in .env");
  process.exit(1);
}
// The current image version; bump it whenever infra/sandbox/Dockerfile changes
// (a snapshot is immutable), then point SANDBOX_SNAPSHOT at the new name.
const name = process.argv[2] ?? "agentes-computer-v3";
const api = config.DAYTONA_API_URL.replace(/\/$/, "");
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const dockerfile = await Bun.file(resolve(import.meta.dir, "../../../infra/sandbox/Dockerfile")).text();
const started = Date.now();
const step = (msg: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${msg}`);

type Snapshot = { id: string; name: string; state: string; errorReason?: string | null };

async function findByName(): Promise<Snapshot | null> {
  const res = await fetch(`${api}/snapshots/${encodeURIComponent(name)}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET snapshot: ${res.status} ${await res.text()}`);
  return (await res.json()) as Snapshot;
}

let snapshot = await findByName();
if (snapshot) step(`snapshot ${name} already exists (${snapshot.state})`);
else {
  step(`building snapshot ${name} from infra/sandbox/Dockerfile`);
  const res = await fetch(`${api}/snapshots`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name,
      buildInfo: { dockerfileContent: dockerfile },
      cpu: 1,
      memory: 2,
      disk: 5,
    }),
  });
  if (!res.ok) throw new Error(`POST /snapshots: ${res.status} ${await res.text()}`);
  snapshot = (await res.json()) as Snapshot;
}
for (let i = 0; snapshot && snapshot.state !== "active"; i++) {
  if (["error", "build_failed"].includes(snapshot.state)) {
    throw new Error(`snapshot ${name} failed: ${snapshot.errorReason ?? snapshot.state}`);
  }
  if (i > 240) throw new Error("the snapshot took more than 20 minutes");
  await Bun.sleep(5000);
  snapshot = await findByName();
  step(`snapshot ${name}: ${snapshot?.state ?? "missing"}`);
}
step(`snapshot ${name} is active; checking it`);

const provider = createDaytonaSandboxProvider({
  apiKey: key,
  apiUrl: config.DAYTONA_API_URL,
  target: config.DAYTONA_TARGET,
  snapshot: name,
});
const box = await provider.create({
  key: `snapshot-check:${name}`,
  labels: { "agentes.snapshot-check": name },
  allowDomains: [],
  autoStopMinutes: 5,
  autoArchiveMinutes: 60,
});
let failed = false;
try {
  for (const command of [
    "node -v",
    "npm -v",
    // With the network blocked, these prove nothing is downloaded on first use.
    "pnpm -v",
    "command -v pnpm",
    "yarn -v",
    "python3 -c \"import pandas, matplotlib; print('ok')\"",
    "gcc --version | head -1",
    "go version",
    "cargo --version",
    "sudo -n true && echo sudo-ok",
    "pwd",
    "whoami",
  ]) {
    const r = await provider.exec(box.id, { command, timeoutSeconds: 60 });
    console.log(`$ ${command}\n${r.stdout.trim()}${r.stderr.trim() ? `\n${r.stderr.trim()}` : ""}`);
    if (r.exitCode !== 0) failed = true;
  }
} finally {
  await provider.destroy(box.id);
  step("check sandbox deleted");
}
if (failed) {
  console.error(`snapshot ${name}: a check failed`);
  process.exit(1);
}
step(`ok: set SANDBOX_SNAPSHOT=${name}`);
