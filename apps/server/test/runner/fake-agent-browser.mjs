// A fake `agent-browser` for browser tests: answers `--json` like the real one.
// Each run appends `{ args, stdin }` to $FAKE_AB_LOG (one JSON line). The page
// lives in $FAKE_AB_STATE: `{ open, url, attrs: { "@e3": { type } }, clickTo, tabTo, noHistory, port }`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const stdin = await new Promise((resolve) => {
  let data = "";
  process.stdin.on("data", (c) => {
    data += c;
  });
  process.stdin.on("end", () => resolve(data));
});
if (process.env.FAKE_AB_LOG) appendFileSync(process.env.FAKE_AB_LOG, `${JSON.stringify({ args: argv, stdin })}\n`);

const VALUED = new Set([
  "--namespace",
  "--session",
  "--profile",
  "--config",
  "--max-output",
  "--idle-timeout",
  "--download-path",
  "--screenshot-dir",
  "--screenshot-format",
  "--screenshot-quality",
  "--executable-path",
  "--args",
  "--cdp",
  "--screenshot-format",
  "--screenshot-quality",
]);
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) i++;
  else if (!argv[i].startsWith("--")) rest.push(argv[i]);
  else if (argv[i] === "--all") rest.push("--all");
}
const file = process.env.FAKE_AB_STATE;
const state = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { open: false, url: "about:blank" };
const save = () => file && writeFileSync(file, JSON.stringify(state));
const out = (o) => {
  process.stdout.write(`${JSON.stringify(o)}\n`);
  save();
};

const [command, ...args] = rest;
switch (command) {
  case "open":
  case "goto":
    state.open = true;
    state.prev = state.url;
    // Like the real one: schemes kept (about:blank too), bare hosts get https.
    state.url = /^[a-z][a-z0-9+.-]*:/i.test(args[0]) ? args[0] : `https://${args[0]}`;
    out({ success: true, data: { url: state.url } });
    break;
  case "stream":
    out({ success: true, data: { enabled: true, port: state.port ?? 41234, connected: state.open === true } });
    break;
  case "get":
    if (args[0] === "url") out({ success: true, data: { url: state.url } });
    else if (args[0] === "attr") out({ success: true, data: { value: state.attrs?.[args[1]]?.[args[2]] ?? null } });
    else out({ success: false, error: "bad get" });
    break;
  case "snapshot":
    out({ success: true, data: { snapshot: '- button "Go" [ref=e1]' } });
    break;
  case "click":
    if (state.clickTo) {
      state.prev = state.url;
      state.url = state.clickTo;
    }
    out({ success: true, data: { clicked: args[0] } });
    break;
  case "back":
    // A new tab has no history: `back` leaves it where it is.
    if (!state.noHistory) state.url = state.prev ?? "about:blank";
    out({ success: true, data: {} });
    break;
  case "tab":
    // `tab <n>`: switch to a tab that is on `tabTo` (a link that opened a new tab).
    if (/^\d+$/.test(args[0] ?? "") && state.tabTo) state.url = state.tabTo;
    out({ success: true, data: {} });
    break;
  case "batch": {
    const list = JSON.parse(stdin || "[]");
    out(list.map((cmd) => ({ command: cmd, success: true, result: {}, error: null })));
    break;
  }
  case "close":
    state.open = false;
    out({ success: true, data: { closed: true } });
    break;
  case "screenshot": {
    // Like the real one: it writes the file and fails when its folder isn't there. A `.jpg`
    // is a real JPEG header (1280×800); `--annotate` numbers the page's one button.
    const annotate = argv.includes("--annotate");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x05, 0x00, 0x03, 0, 0, 0, 0]);
    try {
      writeFileSync(args[0], args[0].endsWith(".jpg") ? jpeg : "png");
      out({
        success: true,
        data: {
          path: args[0],
          ...(annotate
            ? {
                annotations: [
                  { ref: "e1", number: 1, role: "button", name: "Go", box: { x: 10, y: 20, width: 100, height: 40 } },
                ],
              }
            : {}),
        },
      });
    } catch {
      out({ success: false, data: null, error: `Failed to save screenshot to ${args[0]}: No such file or directory` });
    }
    break;
  }
  case "eval":
    // The page's size, or a settle check (true).
    out({
      success: true,
      data: { result: args.join(" ").includes("innerWidth") ? [1280, 800] : true, origin: state.url },
    });
    break;
  case "upload":
    out({ success: true, data: { files: args.slice(1) } });
    break;
  default:
    out({ success: false, data: null, error: `unknown command ${command}` });
    process.exitCode = 1;
}
