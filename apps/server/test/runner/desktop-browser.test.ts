import { afterEach, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { createConnection, type Server } from "node:net";
import path from "node:path";
import {
  BROWSER_SOCKET,
  closeBrowser,
  type DesktopNote,
  noteArgs,
  runDesktopBrowser,
  serveBrowser,
} from "../../runner/desktop-browser";
import { RunnerError } from "../../runner/errors";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  removeDirs(dirs);
});

const posix = process.platform !== "win32";

function socketIn() {
  const dir = tempDir("dbs-");
  dirs.push(dir);
  return path.join(dir, BROWSER_SOCKET);
}

async function serve(socket: string, open: (installing: () => void) => Promise<void>) {
  const server = await serveBrowser(socket, open);
  servers.push(server);
  return server;
}

/** The notes the launcher showed, and which it closed. */
function notes() {
  const shown: { kind: "wait" | "error"; text: string; closed: boolean }[] = [];
  const note: DesktopNote = (kind, text) => {
    const n = { kind, text, closed: false };
    shown.push(n);
    return {
      close: () => {
        n.closed = true;
      },
    };
  };
  return { shown, note };
}

/** What the runner answers one connection that says `word`. */
function answers(socket: string, word: string): Promise<string> {
  return new Promise((resolve) => {
    let got = "";
    const conn = createConnection(socket);
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(word));
    conn.on("data", (chunk: string) => {
      got += chunk;
    });
    conn.on("error", () => resolve(got));
    conn.on("close", () => resolve(got));
  });
}

test.if(posix)(
  "a click: the runner opens the agent's browser, and the launcher shows nothing when it's quick",
  async () => {
    const socket = socketIn();
    let opened = 0;
    await serve(socket, async () => {
      opened++;
    });
    const n = notes();
    expect(await runDesktopBrowser(socket, { note: n.note })).toBe(0);
    expect(opened).toBe(1);
    expect(n.shown).toEqual([]);
  },
);

test.if(posix)("Chrome for Testing installing first: a wait note, closed once the browser is open", async () => {
  const socket = socketIn();
  let release = () => {};
  await serve(socket, async (installing) => {
    installing();
    await new Promise<void>((r) => {
      release = r;
    });
  });
  const n = notes();
  const run = runDesktopBrowser(socket, { note: n.note });
  while (n.shown.length === 0) await new Promise((r) => setTimeout(r, 5));
  expect(n.shown).toEqual([
    {
      kind: "wait",
      text: "Getting the browser ready…\nThe first time takes about a minute. It opens by itself.",
      closed: false,
    },
  ]);
  release();
  expect(await run).toBe(0);
  expect(n.shown).toEqual([expect.objectContaining({ kind: "wait", closed: true })]);
});

test.if(posix)("a browser that can't open: why, on one line, in a note that stays until it is read", async () => {
  const socket = socketIn();
  await serve(socket, async () => {
    throw new RunnerError("not_allowed", "The browser is turned off\non this computer");
  });
  const n = notes();
  expect(await runDesktopBrowser(socket, { note: n.note })).toBe(1);
  expect(n.shown).toEqual([
    { kind: "error", text: "The browser didn't open.\nThe browser is turned off on this computer", closed: false },
  ]);
  // Nobody listening (the runner restarting), or one that takes too long.
  const nobody = notes();
  expect(await runDesktopBrowser(path.join(path.dirname(socket), "none.sock"), { note: nobody.note })).toBe(1);
  expect(nobody.shown[0]?.text).toBe(
    "The browser didn't open.\nagentes.chat isn't running on this computer right now. Try again in a minute.",
  );
  const slow = socketIn();
  await serve(slow, () => new Promise(() => {}));
  const late = notes();
  expect(await runDesktopBrowser(slow, { note: late.note, timeoutMs: 50 })).toBe(1);
  expect(late.shown[0]?.text).toBe("The browser didn't open.\nIt is taking too long. Try again in a minute.");
});

test.if(posix)("only `open` opens: anything else is dropped unanswered, and the runner hears nothing", async () => {
  const socket = socketIn();
  let opened = 0;
  await serve(socket, async () => {
    opened++;
  });
  expect(await answers(socket, "open https://elsewhere.example\n")).toBe("");
  expect(await answers(socket, "--remote-debugging-address=0.0.0.0\n")).toBe("");
  expect(await answers(socket, "OPEN\n")).toBe("");
  expect(opened).toBe(0);
  expect(await answers(socket, "open\n")).toBe("ok\n");
  expect(opened).toBe(1);
});

test.if(posix)("two clicks at once: one browser, both answered, both told it installs", async () => {
  const socket = socketIn();
  let opened = 0;
  let release = () => {};
  await serve(socket, async (installing) => {
    opened++;
    installing();
    await new Promise<void>((r) => {
      release = r;
    });
  });
  const first = answers(socket, "open\n");
  while (opened === 0) await new Promise((r) => setTimeout(r, 5));
  const second = answers(socket, "open\n");
  await new Promise((r) => setTimeout(r, 30));
  release();
  expect(await first).toBe("installing\nok\n");
  expect(await second).toBe("installing\nok\n");
  expect(opened).toBe(1);
  // The next click is a new one.
  const third = answers(socket, "open\n");
  while (opened === 1) await new Promise((r) => setTimeout(r, 5));
  release();
  expect(await third).toBe("installing\nok\n");
});

test.if(posix)("the socket: its folder's group may write to it, nobody else; closed, it is gone", async () => {
  const socket = socketIn();
  const server = await serve(socket, async () => {});
  const st = statSync(socket);
  expect(st.isSocket()).toBe(true);
  expect(st.mode & 0o777).toBe(0o660);
  expect(st.gid).toBe(statSync(path.dirname(socket)).gid);
  // A file left from an earlier runner is replaced.
  servers.splice(servers.indexOf(server), 1);
  closeBrowser(server, socket);
  expect(existsSync(socket)).toBe(false);
  await serve(socket, async () => {});
  expect(await answers(socket, "open\n")).toBe("ok\n");
});

test("the note: a small terminal window of Browser's class, its text wrapped and indented, no cursor", () => {
  const head = [
    "--disable-server",
    "--class=agentes-browser",
    "--title=Browser",
    "--icon=org.xfce.webbrowser",
    "--hide-menubar",
    "--hide-toolbar",
    "--hide-scrollbar",
  ];
  const show = "printf '\\033[?25l\\n'; printf '%s\\n' \"$1\" | fold -s -w 56 | sed 's/^/  /';";
  expect(noteArgs("wait", "Getting the browser ready…")).toEqual([
    ...head,
    "--geometry=60x6",
    "-x",
    "/bin/sh",
    "-c",
    `${show} exec sleep 960`,
    "sh",
    "Getting the browser ready…",
  ]);
  expect(noteArgs("error", "The browser didn't open.\nWhy")).toEqual([
    ...head,
    "--geometry=60x10",
    "-x",
    "/bin/sh",
    "-c",
    `${show} printf '\\n  %s' 'Press Enter to close.'; read -r _`,
    "sh",
    "The browser didn't open.\nWhy",
  ]);
});
