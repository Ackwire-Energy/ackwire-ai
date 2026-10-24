// A fake `claude` / `codex` for account tests: signs in to the folder in
// $CLAUDE_CONFIG_DIR / $CODEX_HOME, printing what Claude Code 2.1.304 and
// Codex 0.163.0 print (escapes and the OSC 8 hyperlink included). The file
// `signed-in` in that folder is the sign-in.
// $FAKE_ACCOUNT_MODE: "silent" prints nothing and waits; "fail" refuses.
// $FAKE_ACCOUNT_CODE: the Claude code it accepts (default "good-code").
// $FAKE_ACCOUNT_LOG: one JSON line per run (args, the folder). `auth login --email <address>`
// signs in like `auth login` (the address is only the account to offer).
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2).join(" ");
// Each reads only its own variable, as the real CLIs do (`auth …` is Claude Code, the rest Codex): a
// CLAUDE_CONFIG_DIR inherited from the shell (set when tests run inside Claude Code) must not move Codex's folder.
const home = (args.startsWith("auth ") ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME) ?? "";
const marker = path.join(home, "signed-in");
const mode = process.env.FAKE_ACCOUNT_MODE ?? "";
const log = process.env.FAKE_ACCOUNT_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ args, home })}\n`);

const ESC = "\x1b";
const CLAUDE_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Ainference&code_challenge=x&code_challenge_method=S256&state=st4te";

const end = (code, text = "", stream = process.stdout) => stream.write(text, () => process.exit(code));
const waitForever = () => setInterval(() => {}, 1000);

switch (args.replace(/^auth login --email \S+$/, "auth login")) {
  case "auth login": {
    if (mode === "silent") {
      waitForever();
      break;
    }
    process.stdout.write("Opening browser to sign in…\n");
    process.stdout.write(
      `If the browser didn't open, visit: ${ESC}]8;;${CLAUDE_URL}${ESC}\\${CLAUDE_URL}${ESC}]8;;${ESC}\\\n`,
    );
    process.stdout.write("Paste code here if prompted > ");
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const code = line.trim();
      if (mode !== "fail" && code === (process.env.FAKE_ACCOUNT_CODE ?? "good-code")) {
        writeFileSync(marker, "");
        end(0, "\nLogin successful.\n");
        return;
      }
      // Repeats the code it refused (the runner must not pass it on).
      end(1, `\nOAuth error: invalid code ${code}\n`);
    });
    break;
  }
  case "login --device-auth": {
    if (mode === "silent") {
      waitForever();
      break;
    }
    process.stdout.write(
      [
        "",
        `Welcome to Codex [v${ESC}[90m0.163.0${ESC}[0m]`,
        `${ESC}[90mOpenAI's command-line coding agent${ESC}[0m`,
        "",
        "Follow these steps to sign in with ChatGPT using device code authorization:",
        "",
        "1. Open this link in your browser and sign in to your account",
        `   ${ESC}[94mhttps://auth.openai.com/codex/device${ESC}[0m`,
        "",
        `2. Enter this one-time code ${ESC}[90m(expires in 15 minutes)${ESC}[0m`,
        `   ${ESC}[94m7HYC-J6JGM${ESC}[0m`,
        "",
        `${ESC}[90mDevice codes are a common phishing target. Never share this code.${ESC}[0m`,
        "",
      ].join("\n"),
    );
    // The person enters the code elsewhere; Codex finishes by itself.
    setTimeout(
      () => {
        if (mode === "fail") return end(1, "Error logging in: device code expired\n", process.stderr);
        writeFileSync(marker, "");
        end(0, "Successfully logged in\n", process.stderr);
      },
      Number(process.env.FAKE_CODEX_DELAY ?? 300),
    );
    break;
  }
  case "auth status --json":
    if (existsSync(marker)) {
      end(
        0,
        `${JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "dev@acme.test", subscriptionType: "max" })}\n`,
      );
    } else end(1, `${JSON.stringify({ loggedIn: false, authMethod: "none" })}\n`);
    break;
  case "login status":
    if (existsSync(marker)) end(0, "Logged in using ChatGPT\n", process.stderr);
    else end(1, "Not logged in\n", process.stderr);
    break;
  case "auth logout":
  case "logout":
    rmSync(marker, { force: true });
    end(0, "Successfully logged out\n");
    break;
  default:
    end(2, `unknown command: ${args}\n`, process.stderr);
}
