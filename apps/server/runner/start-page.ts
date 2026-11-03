import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { AgentScope, MachineEgress } from "@agenteschat/adapters/machine-protocol";
import { countryFlagUrl } from "@agenteschat/ui/brand/flags";
import { type AgentUser, agentGid } from "./agent-users";
import MARK from "./assets/desktop-mark.png.b64" with { type: "text" };
import DOTO from "./assets/start/doto.woff2.b64" with { type: "text" };
import MANIFEST from "./assets/start/manifest.json.txt" with { type: "text" };
import CSS from "./assets/start/start.css.txt" with { type: "text" };
import HTML from "./assets/start/start.html.txt" with { type: "text" };
import JS from "./assets/start/start.js.txt" with { type: "text" };
import { desktopName } from "./desktop-look";
import { SYSTEM_BROWSER_DIR } from "./install-script";

export const START_VERSION = 2;
export const systemStartPage = (uid: number) => path.join(SYSTEM_BROWSER_DIR, "start", String(uid));
export const startLocale = (locale?: string | null): "pt-BR" | "en" =>
  /^pt(?:-|$)/i.test(locale ?? "") ? "pt-BR" : "en";
export interface StartPageData {
  locale?: string;
  egress?: MachineEgress | null;
}
/** Files contain no credentials. System mode writes them as root outside the agent's writable home. */
export function prepareStartPage(
  directory: string,
  agent: Pick<AgentScope, "name" | "handle">,
  data: StartPageData = {},
  gid?: number,
) {
  mkdirSync(path.dirname(directory), { recursive: true, mode: 0o755 });
  mkdirSync(directory, { recursive: true, mode: gid === undefined ? 0o755 : 0o750 });
  const st = lstatSync(directory);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid()) || st.mode & 0o022)
    throw new Error("Unsafe start page folder");
  if (gid !== undefined) {
    if (st.gid !== gid) chownSync(directory, 0, gid);
    if ((st.mode & 0o777) !== 0o750) chmodSync(directory, 0o750);
  }
  const marker = path.join(directory, "version");
  if (!existsSync(marker) || readFileSync(marker, "utf8") !== String(START_VERSION)) {
    for (const [name, contents] of Object.entries({
      "manifest.json": MANIFEST,
      "start.html": HTML,
      "start.css": CSS,
      "start.js": JS,
      "mark.png": Buffer.from(MARK.trim(), "base64"),
      "doto.woff2": Buffer.from(DOTO.trim(), "base64"),
    })) {
      writeFileSync(path.join(directory, name), contents, { mode: 0o644 });
    }
    writeFileSync(marker, String(START_VERSION), { mode: 0o644 });
  }
  const value = JSON.stringify({
    name: desktopName(agent),
    locale: startLocale(data.locale),
    egress: data.egress ?? null,
    flag: countryFlagUrl(data.egress?.country),
  });
  const dest = path.join(directory, "data.json");
  if (!existsSync(dest) || readFileSync(dest, "utf8") !== value) {
    writeFileSync(`${dest}.tmp`, value, { mode: 0o644 });
    renameSync(`${dest}.tmp`, dest);
  }
  return directory;
}
export function readStartLocale(directory: string) {
  try {
    return startLocale(JSON.parse(readFileSync(path.join(directory, "data.json"), "utf8")).locale);
  } catch {
    return "en";
  }
}

const agentGroups = new Map<number, number>();
export function prepareSystemStartPage(
  user: AgentUser,
  agent: Pick<AgentScope, "name" | "handle">,
  data: StartPageData,
) {
  let gid = agentGroups.get(user.uid);
  if (gid === undefined) {
    gid = agentGid(user.user);
    agentGroups.set(user.uid, gid);
  }
  return prepareStartPage(systemStartPage(user.uid), agent, data, gid);
}
