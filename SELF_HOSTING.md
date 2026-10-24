# Self-hosting agentes.chat

agentes.chat runs as two containers: Postgres 18 with the pgvector extension, and the app, one Bun
process that serves the web app, the API and the WebSockets and runs the background workers. A
third, Tailscale, puts it on your private network with HTTPS. Migrations run when the app starts.
Everything it keeps is in Postgres, except uploaded files, which the compose file stores in a volume.

`PUBLIC_URL` must be the exact address people open, scheme, host and port included
(`https://agentes.tail1234.ts.net`, `https://chat.example.com`, or `http://localhost:3000` on your
own machine). The setup writes it for you. Sign-in cookies, the only browser origin allowed to change
anything, and every link the app sends come from it. Opened at any other address, sign-in fails with
"Invalid origin" and saving fails with `bad_origin`.

The server needs no model key of its own. Each organization adds its Anthropic or OpenAI keys in
**Settings → API keys**. Keys are stored encrypted with a key derived from `AGENTES_SECRET` and are
never sent to browsers.

**Requirements**

- A 64-bit Linux server (amd64 or arm64) with Docker Engine and the Compose v2 plugin
  (`docker compose`), 2.23.1 or newer. Docker Desktop works for trying it on a laptop. The setup
  checks both and says how to install what's missing.
- Node.js 18 or newer for `npx`, or nothing more: the setup also runs from the app's image.
- Sizing has not been measured yet. As a starting point for a small team: 2 vCPUs, 4 GB of RAM and
  20 GB of disk. The image is large (about 2 GB of dependencies), and the database and the files
  volume grow with use.
- A Tailscale account (signing up is free), for the default: private HTTPS, no domain and no open
  port. For a public instance instead, a domain whose DNS points at the server, and ports 80 and 443
  open.
- Outbound HTTPS to the model providers your organizations use, and to any service you turn on below.

<details open>
<summary><b>Quick start (about 10 minutes)</b></summary>

You end up with agentes.chat on your Tailscale network (your tailnet), at
`https://agentes.<your-tailnet>.ts.net` with a real certificate. Only devices signed in to your
tailnet can open it: no domain, no open port, nothing on the public internet.

1. **Tailscale.** No tailnet yet? Sign up at https://login.tailscale.com/start. Install Tailscale on
   the computer you'll use (https://tailscale.com/download) and sign in. Done when that computer is
   listed on https://console.tailscale.com/admin/machines.
2. **MagicDNS and HTTPS.** Open https://console.tailscale.com/admin/dns. If you see
   **Enable MagicDNS**, click it. Under **HTTPS Certificates**, click **Enable HTTPS** and confirm.
   The server's name and your tailnet's go into a public certificate log; the setup's `--hostname`
   names the server something other than `agentes`. Done when the page shows both on.
3. **An auth key.** Open https://console.tailscale.com/admin/settings/keys and click
   **Generate auth key**. Leave **Reusable** and **Ephemeral** off, turn **Pre-approved** on if you
   see it, and click **Generate key**. Copy the key (`tskey-auth-…`): it's shown once, and works once.
4. **The setup.** On the server, in an empty directory:

   ```sh
   mkdir agentes && cd agentes
   npx @agenteschat/setup
   ```

   Press Enter for **Tailscale**, paste the key, and press Enter to skip email, or set it up (Email,
   under Configuration). The setup checks Docker, writes `.env` with generated secrets (readable by
   you only), downloads `docker-compose.yml`, starts Tailscale, writes `PUBLIC_URL` from the address
   Tailscale gives the server, starts the app, and waits for the certificate and `/api/health`. The
   first time, it downloads about 2 GB. Done when it prints:

   ```
   ✓ On your tailnet as agentes.tail1234.ts.net
   ✓ .env: PUBLIC_URL=https://agentes.tail1234.ts.net
   ✓ HTTPS certificate ready
   ✓ agentes.chat <version> is up

     https://agentes.tail1234.ts.net
   ```

   then a QR code for your phone, and what to do next.
5. **Your account.** On a computer in your tailnet, open that address and sign up. The first account
   is always allowed and becomes the owner; after it, sign-up is closed and people join by
   invitation. Onboarding then creates your organization and asks for its model key.
6. **Key expiry.** The server leaves your tailnet when its Tailscale key expires (after 180 days,
   unless your tailnet sets otherwise), and the setup prints that date. On
   https://console.tailscale.com/admin/machines, open the server's **⋯** menu and choose
   **Disable Key Expiry**. A server added with an OAuth client secret (For AI agents) never expires.

No Node.js on the server? The setup is in the app's image too, and works on the current directory:

```sh
docker run --rm -it --user "$(id -u):$(id -g)" -v "$PWD":/work -w /work ghcr.io/agentes-chat/agentes:latest setup
```

Inside a container it can't start the others, so it ends with the three commands to run; the second
reads the address from Tailscale and writes `PUBLIC_URL`.

**People you invite** need your tailnet too: invite them at https://console.tailscale.com/admin/users
(**Invite users**), or share only this server with their tailnet (its **⋯** menu on the Machines
page, **Share**). Then invite them in the app, from **Settings → Members and invitations**.

**Running the setup again** is safe: it keeps `.env` and fills in only what's missing, asking with
your current answers as defaults. A `PUBLIC_URL` of your own (nginx, a tunnel) stays as it is.
Choosing another way in removes the old one's container (Caddy or Tailscale), which
`docker compose up` alone would leave running. `--dry-run` prints the plan and changes nothing, and
`--help` lists every option.

`docker compose ps` shows the app as `healthy` once it answers `/api/health`, and
`docker compose logs -f agentes` shows what it is doing.

</details>

<details>
<summary><b>Your phone</b></summary>

1. Install the Tailscale app (https://tailscale.com/download/ios or
   https://tailscale.com/download/android) and sign in to the same tailnet. Done when it says
   **Connected**.
2. Install the agentes.chat app.
3. Point the phone's camera at a QR code for your instance. The setup prints one at the end; in the
   web app, **Open on your phone** (**Abrir no celular** in Portuguese) in the account menu shows
   one that also signs you in. Or, on the app's sign-in screen, tap the server line
   (**Server: agentes.chat · Change**, or **Servidor: agentes.chat · Trocar**), then
   **Scan QR code**, or type the address and tap **Use this server**.
4. The app shows your server's address. Confirm, then sign in (the web app's code signs you in by
   itself).

If the app can't reach the server, open the Tailscale app, check that it's connected, and try again.
**Back to agentes.chat**, on the screen **Change** opens, goes back to agentes.chat Cloud.

The QR code is a link, `agenteschat://connect?server=<the address, URL-encoded>`. The web app's adds
`&token=<a one-time sign-in>`, which works once, within 3 minutes, for whoever scans it: show it to
your own phone only.

</details>

<details>
<summary><b>Connect a computer</b></summary>

Agents run commands and code, drive a browser, and can think with Claude Code or Codex on computers
you connect (Agent computers, below). A computer must reach the instance, so on Tailscale, install
Tailscale on it and sign in to the same tailnet first.

- **A Mac:** the agentes.chat desktop app. On its first screen, click the server line
  (**Server: agentes.chat · Change**), paste your address (`https://agentes.<your-tailnet>.ts.net`),
  click **Use this server**, and sign in when the browser opens. **Add organization** has the same
  line.
- **Linux, a server or a VM:** **Settings → Computers → Connect a computer** shows the command, and
  Agent computers below explains it.

</details>

<details>
<summary><b>For AI agents</b></summary>

A runbook for an AI agent, or a script, installing agentes.chat on a server where it can run
commands.

**What needs a person.** In the Tailscale admin console, once per tailnet: MagicDNS and HTTPS on
(Quick start, step 2), and a key for the server. That can be a one-off auth key for each install
(step 3), or an OAuth client secret, created once, which installs with nobody at the console:

1. On https://console.tailscale.com/admin/acls, add the tag under `"tagOwners"` and save:
   `"tag:agentes": ["autogroup:admin"]`.
2. On https://console.tailscale.com/admin/settings/trust-credentials, click **Credential**, choose
   **OAuth**, give **Auth Keys** Write access with the tag `tag:agentes`, and click
   **Generate credential**. The secret starts with `tskey-client-`.

A server added with it joins as `tag:agentes`, approved, with a key that never expires. If your
tailnet policy file limits who reaches what, let your people reach `tag:agentes` on port 443.

**The command**, in an empty directory on the server:

```sh
AGENTES_SETUP_TAILSCALE_KEY='tskey-client-…' npx -y @agenteschat/setup --network tailscale --email skip --json
```

- Every answer is a flag or an `AGENTES_SETUP_<OPTION>` variable; `--help` lists them, and a flag
  wins over a variable. With `--json` nothing is asked: a missing answer is a failed check.
- stdout is one JSON object, and progress goes to stderr. Exit code 0: done; 1: a check failed;
  2: a wrong option.
- `--dry-run --json` returns the plan and changes nothing.
- After a failure, do what `fix` says and run the same command again: it keeps what's done.
- An OAuth client with another tag: `--tailscale-tag tag:<name>` (default `tag:agentes`).
- Without `--json` and without a terminal, answers are read from stdin, one per line; an empty line
  or the end of the input takes the default.

Done:

```json
{
  "ok": true,
  "network": "tailscale",
  "url": "https://agentes.tail1234.ts.net",
  "health": { "status": "ok", "version": "…", "edition": "selfhost" },
  "ownerExists": false,
  "phoneLink": "agenteschat://connect?server=https%3A%2F%2Fagentes.tail1234.ts.net",
  "nextSteps": ["On a computer or phone signed in to your tailnet, open https://agentes.tail1234.ts.net and create your account: the first one owns this instance.", "…"]
}
```

Give the person `url` and `nextSteps`: the first account, created from a device in the tailnet, owns
the instance. A failure names the check, what happened and the fix:

```json
{
  "ok": false,
  "check": "tailscale.https",
  "error": "HTTPS certificates are off in your tailnet.",
  "fix": "Open https://console.tailscale.com/admin/dns, under \"HTTPS Certificates\" click \"Enable HTTPS\" and confirm."
}
```

**Checking each step yourself**, in the install directory:

| Step | Command | Done when |
| --- | --- | --- |
| Docker | `docker compose version --short` | `2.23.1` or newer |
| On the tailnet | `docker compose exec -T tailscale tailscale status --json` | `"BackendState": "Running"`, and the address under `"CertDomains"` |
| HTTPS proxy | `docker compose exec -T tailscale tailscale serve status` | `https://agentes.<tailnet>.ts.net`, with `/` proxied to `http://agentes:3000` |
| Address | `grep '^PUBLIC_URL=' .env` | `PUBLIC_URL=https://agentes.<tailnet>.ts.net` |
| App | `curl -fsS http://127.0.0.1:3000/api/health` | `{"status":"ok",…}` |
| End to end, from a device in the tailnet | `curl -fsS https://agentes.<tailnet>.ts.net/api/health` | the same |
| Containers | `docker compose ps` | `postgres`, `agentes` and `tailscale` up and `healthy` |

**Troubleshooting.** `check` names what failed:

| `check` | What happened | Fix |
| --- | --- | --- |
| `docker`, `docker.compose` | Docker, or Compose v2 2.23.1 or newer, is missing | Linux: `curl -fsSL https://get.docker.com \| sudo sh`. Mac and Windows: Docker Desktop. |
| `docker.daemon`, `docker.permission` | Docker isn't running, or this user can't use it | `sudo systemctl start docker`; `sudo usermod -aG docker $USER`, then log in again. |
| `tailscale.key` | No key, or Tailscale refused it: expired, revoked, or a one-off key already used | A new auth key, or the OAuth client secret. |
| `tailscale.approval` | The server waits for device approval | Machines page: the server marked **Needs approval**, its **⋯** menu, **Approve**. A pre-approved key or an OAuth client secret skips this. |
| `tailscale.magicdns`, `tailscale.https` | MagicDNS or HTTPS certificates are off in the tailnet | Quick start, step 2. |
| `tailscale.tag` | Tailscale refused the OAuth client secret's tag | The tag under `tagOwners`, the one the OAuth client has, passed with `--tailscale-tag`. |
| `tailscale.serve`, `tailscale.cert` | The HTTPS proxy or its certificate didn't come up | `docker compose logs tailscale`. After many tries, Let's Encrypt makes one name wait. |
| `port` | Another program uses the app's port, or 80 and 443 for a public domain | `HOST_PORT=3001` in `.env`, or stop that program. |
| `app.config` | The app refused a value in `.env` | The values `error` names. |
| `app.health`, `tailscale.timeout` | Something didn't answer in time (`--timeout`, 300 s by default) | `docker compose logs agentes`, or `tailscale`. |

</details>

<details>
<summary><b>A public domain instead (Caddy)</b></summary>

For an instance anyone on the internet can open. The setup's **A public domain** choice
(`--network domain --domain chat.example.com`) does what follows, owner account first. By hand:

Create the owner account first, over localhost or the SSH tunnel (This machine only, below): the
first sign-up becomes the owner, so it has to happen before the domain answers. Then point a DNS
record at the server, open ports 80 and 443, and add to `.env`:

```sh
DOMAIN=chat.example.com
PUBLIC_URL=https://chat.example.com
COMPOSE_PROFILES=https
```

and run `docker compose up -d`. The `caddy` service gets a Let's Encrypt certificate for `DOMAIN` and
renews it, redirects http to https, and passes everything to the app, WebSockets included. Its
certificates are kept in the `caddy-data` volume. Caddy sends the client's address as the only value
of `X-Forwarded-For`, which the app trusts as is, so leave `TRUSTED_PROXIES` empty.

</details>

<details>
<summary><b>Behind your own reverse proxy (nginx)</b></summary>

Create the owner account first, as for Caddy above. Keep the app on loopback (the default) and
point the proxy at `127.0.0.1:3000`. The proxy must:

- upgrade WebSockets on `/api/ws` (browsers), `/api/machines/connect` (connected computers), and
  `/api/desktop`, `/api/terminal` and `/api/machines/stream` (agents' screens and terminals);
- accept uploads up to 50 MB, the Drive's limit per file;
- keep sockets open: the app and its clients exchange a ping at least every 30 s, so a read timeout
  of 60 s (nginx's default) or more works;
- send the client's address in `X-Forwarded-For`.

`/etc/nginx/conf.d/agentes.conf`:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      close;
}

server {
    listen 80;
    server_name chat.example.com;

    client_max_body_size 60m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 300s;
    }
}
```

TLS and the http → https redirect in one line:

```sh
sudo certbot --nginx --redirect -d chat.example.com
```

Then set `PUBLIC_URL=https://chat.example.com` in `.env` and run `docker compose up -d`.

Sign-in rate limits count per client address, read from `X-Forwarded-For`. A single value, as above,
is trusted as is, and the client can't forge it (nginx replaces whatever the client sent). With
another proxy or a CDN in front of nginx, send the chain instead (`$proxy_add_x_forwarded_for`) and
list those proxies' addresses or ranges in `TRUSTED_PROXIES`, comma-separated: the chain is read from
the right past every trusted hop, and the first other address is the client.

</details>

<details>
<summary><b>This machine only, and by hand</b></summary>

The setup's **This machine only** choice runs agentes.chat at http://localhost:3000, to try it on a
laptop. By hand, in an empty directory:

```sh
curl -fsSLO https://raw.githubusercontent.com/agentes-chat/agentes-chat/main/docker-compose.yml
(umask 077 && printf 'AGENTES_SECRET=%s\nPOSTGRES_PASSWORD=%s\nPUBLIC_URL=http://localhost:3000\n' "$(openssl rand -base64 48)" "$(openssl rand -hex 24)" > .env)
docker compose up -d
```

The `umask` in parentheses makes `.env` readable by you alone without changing your shell's. Then
open http://localhost:3000 and create the owner account.

`.env` holds three values:

- `AGENTES_SECRET` signs sessions and encrypts every key organizations store (model providers,
  connectors, mailboxes, databases). Back it up apart from the database: a database restored without
  it has all of those keys unreadable.
- `POSTGRES_PASSWORD` goes into the database URL the compose file builds, so it stays hex.
- `PUBLIC_URL`, as above.

Tailscale by hand: add `COMPOSE_PROFILES=tailscale` and `TS_AUTHKEY=<the key>` to `.env`, and run
`docker compose up -d tailscale`. Once it has joined, this prints the server's address; put it in
`PUBLIC_URL` with `https://` in front, empty `TS_AUTHKEY`, and run `docker compose up -d`:

```sh
docker compose exec -T tailscale tailscale status --json | grep -A1 '"CertDomains"'
```

The app is published on `127.0.0.1:3000` only; `HOST_PORT` changes the port. To use it from other
machines, use Tailscale or put it behind HTTPS, or try it through an SSH tunnel first:
`ssh -L 3000:localhost:3000 your-server`. Don't serve it over plain http to other machines
(`BIND_ADDRESS=0.0.0.0`), not even on a LAN. Browsers treat http as a secure context only on
localhost, and parts of the web app need one. With no proxy in front, nothing sets
`X-Forwarded-For`, so the sign-in rate limits can't tell clients apart. And Docker opens a published
port past the host's firewall.

</details>

<details>
<summary><b>What needs a public URL</b></summary>

On Tailscale, only devices in your tailnet reach the instance. Everything people do in the apps works
that way, and so do sign-in with Google, GitHub or Apple, connector sign-ins and connected computers:
they go through a browser or a device in the tailnet. A few services call the instance from the
internet instead, and need it public:

- Routines started by a GitHub or Sentry webhook (the address the routine shows, `/api/webhooks/…`).
- A GitHub App's events (`/api/github-app/webhook`, with `GITHUB_APP_*`).
- Composio's mail events (`/api/webhooks/composio`, with `COMPOSIO_API_KEY`).
- Daytona cloud computers (`DAYTONA_API_KEY`), which use the git proxy and send files back at
  `PUBLIC_URL`.

**Tailscale Funnel** opens the same address to the internet, still with no domain and no open port.
The whole instance becomes public, as on a domain: sign-up stays closed (the default), and the owner
account must exist first.

1. On https://console.tailscale.com/admin/acls, expand the **Funnel** section and click
   **Add Funnel to policy**. It covers your members' devices. A server added with an OAuth client
   secret is tagged: add its tag to the rule's `"target"`, as in
   `{ "target": ["autogroup:member", "tag:agentes"], "attr": ["funnel"] }`.
2. Set `TAILSCALE_FUNNEL=true` in `.env` (exactly `true` or `false`: Compose refuses any other
   value) and run `docker compose up -d`.

Check it from outside the tailnet, a phone on mobile data with Tailscale off for example:
`https://agentes.<your-tailnet>.ts.net/api/health` answers `{"status":"ok",…}`. Public DNS for the
address can take up to 10 minutes. Without the policy rule, the address stays private with no error
anywhere, so that check is the one to trust. `TAILSCALE_FUNNEL=false` and `docker compose up -d`
make it private again.

</details>

<details>
<summary><b>Configuration</b></summary>

Settings are environment variables in `.env`; the compose file hands the whole file to the app. After
a change, `docker compose up -d` recreates the app with it. Every variable is documented in
[`.env.example`](https://github.com/agentes-chat/agentes-chat/blob/main/.env.example). These are the
ones a self-hosted instance usually touches:

| Variable | Default | What it does |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:3000` | The exact address people open. |
| `AGENTES_SECRET` | required | Master secret, at least 32 characters. Never change it on an instance in use. |
| `POSTGRES_PASSWORD` | required | Database password. Read by the compose file only. |
| `AGENTES_IMAGE` | `ghcr.io/agentes-chat/agentes:latest` | The image to run. A version tag or a digest holds a version. |
| `BIND_ADDRESS`, `HOST_PORT` | `127.0.0.1`, `3000` | Where the compose file publishes the app. |
| `COMPOSE_PROFILES` | | How people reach it: `tailscale` (the setup's default), `https` (Caddy for `DOMAIN`), or neither (this machine only). Comma-separated, with other optional services: `backup` (Backups and restore). |
| `DOMAIN` | | The public domain Caddy gets a certificate for. |
| `TS_AUTHKEY` | | The auth key or OAuth client secret the server joins your tailnet with, read only until it has joined. The setup empties it then. |
| `TS_HOSTNAME` | `agentes` | The server's name in your tailnet: `https://<TS_HOSTNAME>.<tailnet>.ts.net`. After changing it, run the setup again to update `PUBLIC_URL`. |
| `TS_EXTRA_ARGS` | | More `tailscale up` flags. The setup puts `--advertise-tags` here for an OAuth client secret. |
| `TAILSCALE_FUNNEL` | `false` | `true` opens the instance to the internet at the same address (What needs a public URL). Only `true` or `false`. |
| `ALLOW_SIGNUP` | `false` | `true` lets anyone create an account. |
| `TRUSTED_PROXIES` | | Proxies in front of your proxy (see nginx above). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | | "Sign in with Google", redirect URI `{PUBLIC_URL}/api/auth/callback/google`. `GITHUB_*` and `APPLE_*` work the same way. |
| `TERMS_URL`, `PRIVACY_URL` | | Your terms and privacy policy, linked on the sign-in and sign-up screens when both are set. |
| `LANDING_PAGE` | `false` | The agentes.chat marketing page at `/`, with its waiting list and analytics. Leave it off. |
| `SMTP_URL` | | Email through your SMTP server: `smtps://user:password@smtp.example.com:465`, or `smtp://` for STARTTLS on 587, which is then required (`?requireTLS=false` at the end allows a relay without TLS on a trusted network). |
| `MILLIONSEND_API_KEY`, `MILLIONSEND_API_URL` | `https://api.millionsend.com` for the URL | Email through a Resend-compatible API instead: MillionSend, your own MillionSend, or Resend (`https://api.resend.com`). |
| `EMAIL_FROM`, `EMAIL_REPLY_TO` | `agentes <ola@HOST>`, HOST being the host of `PUBLIC_URL` | Sender of the app's emails. Its domain must be verified with your email provider. |
| `FILES_DIR` | `/data/files`, set by the compose file | Folder for uploaded files, on the `files` volume. |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | | Files in an S3-compatible bucket instead, when all four are set. `S3_REGION` (default `auto`); `S3_PATH_STYLE=true` for MinIO and Garage. |
| `RUN_MIGRATIONS_ON_BOOT` | `true` | `false` only if you run `docker compose run --rm agentes migrate` yourself before each start. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

**Model keys.** Each organization adds its own Anthropic or OpenAI keys in **Settings → API keys**,
and each agent uses one of them. Usage and cost are recorded per agent.

**Sign-up.** The first account is always allowed. After it, with `ALLOW_SIGNUP=false` (the default),
only invited people get in: invited by email from **Settings → Members and invitations**, or through
an invite link, which works without email. Keep sign-up closed on an instance reachable from the
internet.

**Email.** Without `SMTP_URL` or `MILLIONSEND_API_KEY`, the app writes each email to its log instead
of sending it (`docker compose logs agentes | grep 'email (not sent'`), so an invitation link can
still be copied from there; email verification and password reset stay off. With either set, it
sends invitations, email verification, password reset links, and budget and approval alerts.
`MILLIONSEND_API_KEY` wins when both are set.

**Password reset** needs email, so it shows only with `SMTP_URL` or `MILLIONSEND_API_KEY` set: "Forgot
my password" on the sign-in page emails a link to the web app's reset page (`/reset-password`).

**Files.** The compose file stores uploaded files (Drive files, attachments, photos) in the `files`
volume. With all four `S3_*` variables set they go to that bucket instead, and with neither, into
Postgres. Choose before the first upload: a file stays in the store it was written to. An
organization can also keep its files in a bucket of its own (**Settings → Storage**).

</details>

<details>
<summary><b>Optional services and what they receive</b></summary>

Nothing on the instance contacts agentes.chat on its own. Besides the model providers each
organization chooses, it talks to a third party only when you turn that service on:

| Service | Turned on by | What it receives |
| --- | --- | --- |
| Anthropic, OpenAI | An organization's key | What an agent reads to answer: its instructions, the organization's context, recent messages, and the files and tool results it opens. Summaries and memory upkeep use the same key. |
| TypeSafe Jev | `TYPESAFE_API_KEY` | To pick which agent answers a message nobody @mentioned: the channel's name and topic, the message (up to 4,000 characters), recent messages (up to 800 each), and the name, role and description of the channel's agents. Also the messages and memory items it is asked to judge (a request to stop, a hand-off, a permission change, whether to archive a memory). Without it, the organization's own model does this. |
| Voyage AI | `EMBEDDINGS_PROVIDER=voyage` and `VOYAGE_API_KEY` | The text of messages and memory items as they are indexed (up to 8,000 characters each), and search queries. Without it, search is full-text only. |
| Composio | `COMPOSIO_API_KEY` | Gmail and Outlook for agents: Composio holds the mailbox connection, and the mail agents read or send passes through it. IMAP mailboxes connect directly. |
| Daytona | `DAYTONA_API_KEY` | Cloud computers for agents: the commands and code agents run, the files they put there and the output, on Daytona's cloud (or your own Daytona, `DAYTONA_API_URL`). |
| MillionSend or Resend | `MILLIONSEND_API_KEY` | Each email the app sends: recipients, subject and body, links included. `SMTP_URL` uses your own mail server instead. |
| Expo | A phone signed in to the instance | For each push to that phone: its push token, a title (up to 80 characters) and a line of text (up to 180), through Expo's push service. |
| Tailscale | `COMPOSE_PROFILES=tailscale` | Its coordination server keeps the server's name, tailnet addresses and public keys, as for any device in your tailnet. Connections are encrypted end to end (WireGuard), through Tailscale's relays when no direct path exists; with Funnel, visitors' connections pass through Tailscale's servers, still encrypted to this server. The HTTPS certificate comes from Let's Encrypt, which publishes the server's name in the public Certificate Transparency log. |

Connectors (MCP servers, GitHub, Linear and the others) receive what agents send them, within the
scopes you grant each agent.

</details>

<details>
<summary><b>Agent computers</b></summary>

Agents run commands and code, drive a browser, and can think with Claude Code or Codex on a
computer. Connect your own: a server, a VM or a laptop. Cloud computers need `DAYTONA_API_KEY`
(Daytona's cloud, or your own Daytona at `DAYTONA_API_URL`); without it, agents use connected
computers only.

**Settings → Computers → Connect a computer** shows the command for this instance:

```sh
curl -fsSL https://chat.example.com/api/machines/install.sh | sh
```

The computer needs Node.js 22 or newer (or Bun) and must reach `PUBLIC_URL`: it downloads the runner
from there and sends files back through it. On Tailscale, install Tailscale on it and sign in to the
same tailnet first. The installer prints a code and a link; open it signed in, confirm, and the
computer joins your organization. Then it installs a background service
(a systemd user unit or a launchd agent) where it can; otherwise run
`~/.agentes-runner/bin/agentes-runner start` and keep it running. Options go after `sh -s --`:
`--dir <folder>` (where agents work, default `~/agentes`), `--name <name>`, `--no-exec` (files only,
no commands) and `--no-service`.

That computer runs the commands agents execute, the browser they drive (Chrome for Testing, installed
on first use), and Claude Code or Codex when an agent thinks with a subscription signed in there.
Commands run as the user that runs the runner, so give it a dedicated user or a VM.
`agentes-runner tools disable commands` (or `claude`, or `codex`) turns a capability off on that
computer, and `agentes-runner folders allow <path>` shares a folder besides the agents' own.

Use HTTPS with a certificate from a public authority (Tailscale and the Caddy profile get one). Over
plain http the computer's token travels unencrypted, and the runner's background service doesn't
load extra CA certificates.

**Agents using apps on their desktops (Linux).** Besides being watched and controlled, an agent's
desktop is one it can use itself: open an app, click, type and read the screen, for apps with no API or
web version (web pages stay in its browser). It reads the screen through the desktop's accessibility
tree, so most elements have a name and a number, and finds the rest on a screenshot. Driving a desktop
runs anything as the agent, so it needs:

- each agent working as its own user on that computer (the installer's `--system` option, as root),
  never a desktop shared with the runner's user or with another agent;
- these packages (Debian and Ubuntu names), besides the desktops':

  ```sh
  sudo apt install --no-install-recommends python3 python3-gi python3-xlib xdotool scrot at-spi2-core
  ```

- the desktop and commands turned on at that computer (`agentes-runner tools enable desktop`, then
  `agentes-runner tools enable commands`);
- the agent's **Use its desktop** and **Run code** permissions, and the organization's code environment on.

The agents' desktops start with `ACCESSIBILITY_ENABLED=1` and `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`, so
GTK, Chromium and Electron apps show their buttons and fields; Qt apps, games and canvases are found on
the screenshot only. The computer's page in the app (**Apps on the agents' desktops**) says whether
agents can use their desktops there and, if not, what is missing and the command to run;
`agentes-runner desktop-check --agent <handle>` (with the runner stopped) times a look, an action, a
screenshot and a close-up on that agent's desktop.

With `TYPESAFE_API_KEY` (Jev), agents name targets in words, small ones are looked at again up close on
the screenshot, and checks can look at the screen's image. Without it they act by the numbers on the
screen and exact names, checks use the organization's cheap model on the screen's text, and nothing is
found on images. Each step an agent takes shows on its message, and every app or file it opens is in
the organization's audit log. Programs on one desktop aren't isolated from each other: code the agent
runs there can see its screen and keys, so agents never type passwords into desktop apps; a person signs
in with take control, and the sign-in stays in the agent's home. Mac and Windows computers have no
desktop use.

</details>

<details>
<summary><b>Upgrades</b></summary>

Download the compose file again with each release, since a release can change it, then pull and
restart:

```sh
curl -fsSLO https://raw.githubusercontent.com/agentes-chat/agentes-chat/main/docker-compose.yml
docker compose pull
docker compose up -d
```

Keep your settings in `.env` and never edit `docker-compose.yml`, so replacing it loses nothing.
Anything a variable can't set goes in a `docker-compose.override.yml` beside it, which Compose merges
on its own.

Migrations run when the new version starts, so that is the whole upgrade for a small instance. The
compose file runs `ghcr.io/agentes-chat/agentes:latest`, the latest release, for amd64 and arm64;
`:1.2.3` and `:1.2` tags exist alongside it, and `:edge` follows `main`. To hold a version, set
`AGENTES_IMAGE` in `.env` to a version tag or a digest (`ghcr.io/agentes-chat/agentes@sha256:…`),
and download the compose file of that version's tag (`…/agentes-chat/v1.2.3/docker-compose.yml`)
instead of `main`'s. This prints the digest you have:

```sh
docker image inspect --format '{{index .RepoDigests 0}}' ghcr.io/agentes-chat/agentes:latest
```

For a big jump, migrate first from a throwaway container. If a migration fails, the running version
keeps serving instead of a new one that won't start:

```sh
docker compose pull
docker compose run --rm agentes migrate
docker compose up -d
```

Migrations only go forward, and a version refuses to start on a database that a newer one migrated.
Take a dump before a big jump (Backups below): rolling back is the previous pin plus that dump.

The compose file pins the Postgres image too, by version and digest, so the database image changes
only when a release's compose file moves that pin. The new file, `docker compose pull` and
`docker compose up -d` then recreate the `postgres` container on the new image, keeping the `pgdata`
volume. That covers Postgres 18 minor releases and pgvector updates; a new Postgres major version
can't open the old data directory, so moving to one takes a dump and a restore into a new volume.

</details>

<details>
<summary><b>From source</b></summary>

To run your own changes, build the image and point the compose file at it:

```sh
git clone https://github.com/agentes-chat/agentes-chat.git
cd agentes-chat
docker build -t agentes:local .
echo AGENTES_IMAGE=agentes:local >> .env
npx @agenteschat/setup
```

The setup keeps `AGENTES_IMAGE`, so it and every later command run your image. To upgrade,
`git pull`, build again and `docker compose up -d`. Skip `docker compose pull` with a local image: it
looks for `agentes:local` in a registry and fails. `docker compose pull postgres` updates the
database image alone. The build installs every workspace's dependencies and builds the web app, so
it needs more memory than running the image. The image keeps the checkout's file permissions and
runs as an unprivileged user, so on a host whose umask is stricter than 022, clone and pull under
`umask 022` (for example `(umask 022 && git pull)`).

</details>

<details>
<summary><b>Backups and restore</b></summary>

An instance is three things: the database, the `files` volume (uploaded files, with the compose
file's `FILES_DIR`), and `AGENTES_SECRET`. Keep the secret apart from the dumps: a dump restored
without it has every stored key (model providers, connectors, mailboxes, databases) unreadable, and
anyone who holds both can read those keys.

**Every day, to a bucket.** The `backup` service dumps the database at 03:00 UTC to a bucket on
Cloudflare R2 or another S3-compatible store, and deletes dumps older than `BACKUP_RETENTION_DAYS`
(14 by default). Create a private bucket for the dumps alone, since they hold every message, and a
key that can read, write and delete in it. Then add to `.env`:

```sh
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BACKUP_BUCKET=agentes-backups
```

Add `backup` to `COMPOSE_PROFILES` too, comma-separated: `COMPOSE_PROFILES=tailscale,backup` on
Tailscale (the setup's default), `https,backup` with Caddy, or `backup` alone. Running the setup
again keeps it. Run `docker compose up -d`: the first dump runs right away, unless the bucket has one
from the last 26 hours, and `docker compose logs backup` shows each one. These `S3_*` values also
serve file storage when `S3_BUCKET` is set, so the key then needs both buckets. Outside R2, set
`S3_PROVIDER` to rclone's name for the store (`AWS`, `Minio`, `Other` and so on) and `S3_REGION` if it
needs one. The service runs `ghcr.io/agentes-chat/backup`, published with each release under the
app's tags; `AGENTES_BACKUP_IMAGE` holds a version the way `AGENTES_IMAGE` does.

```sh
docker compose run --rm backup now     # a dump right away, before a big upgrade for example
docker compose run --rm backup list    # the dumps in the bucket
```

The dumps cover the database, files kept in Postgres included. Files in an S3 bucket stay there;
files in the `files` volume need the commands below.

**By hand**, on the server:

```sh
(
  umask 077
  docker compose exec -T postgres pg_dump -U agentes -Fc agentes > agentes-$(date +%F).dump
  docker compose run --rm --no-deps -T --entrypoint tar agentes czf - -C /data/files . > files-$(date +%F).tar.gz
)
```

The `umask` makes both files readable by you alone: they hold every message and file. The dump is
consistent while the app runs. Schedule both and copy the results off the server (in a crontab,
start the line with `cd /path/to/compose/dir && umask 077;` and write `\%F`).

**Restore** with the app stopped, so nothing writes in between, into an emptied database: tables that
a newer version added aren't in an older dump and would keep it from replacing the rest. A dump in
the bucket comes down to the server first, under a name from `list`:

```sh
(umask 077 && docker compose run --rm -T backup fetch agentes-20261020-030000.dump > agentes-2026-10-20.dump)
```

Then:

```sh
docker compose stop agentes
docker compose exec -T postgres dropdb -U agentes --force agentes
docker compose exec -T postgres createdb -U agentes agentes
docker compose exec -T postgres pg_restore -U agentes -d agentes --exit-on-error < agentes-2026-10-20.dump
docker compose run --rm --no-deps -T --entrypoint tar agentes xzf - -C /data/files < files-2026-10-20.tar.gz
```

Only when both restores finish without an error, start the app:

```sh
docker compose start agentes
```

On a new server: the compose file and the old `.env`, `docker compose up -d --wait postgres`, the
restore commands above (with the old `.env`, `list` and `fetch` reach the bucket from there too), then
`docker compose up -d`. Restore into the version that took the dump or a newer one.

On Tailscale, the new server needs a key of its own: its login stays in the old server's
`tailscale-state` volume. On https://console.tailscale.com/admin/machines, remove the old server
(its **⋯** menu, **Remove**) so the new one gets the same name, then run the setup in the restored
directory instead of the last `docker compose up -d`. It asks for an auth key (or takes
`--tailscale-key`) and writes `PUBLIC_URL` again if the name changed.

</details>

<details>
<summary><b>Troubleshooting</b></summary>

**"Invalid origin" when signing in, or `bad_origin` ("Cross-origin request refused") when saving.**
`PUBLIC_URL` differs from the address in the browser: scheme, host and port must all match. Fix it in
`.env` and run `docker compose up -d`. In production the log warns at every start while `PUBLIC_URL`
is still `http://localhost:3000`. On Tailscale, open the `ts.net` address the setup printed, not the
server's short name or its `100.x` address.

**The address doesn't open on a device in the tailnet.** Tailscale must be connected on that device,
signed in to the same tailnet. On the server, `docker compose ps` shows `tailscale` as `healthy`, and
`docker compose exec -T tailscale tailscale serve status` lists the address. If your tailnet policy
file limits who reaches what, let that person reach the server on port 443. The setup's checks and
their fixes are in For AI agents, above.

**Messages don't appear live, and the browser's WebSocket closes with code 1006.** A proxy in front
doesn't pass the upgrade. It needs the `Upgrade` and `Connection` headers for `/api/ws` (and
`/api/machines/connect` for computers), HTTP/1.1 to the app, and a read timeout of at least 60 s (see
the nginx section). A 403 "Cross-origin WebSocket refused" is the `PUBLIC_URL` mismatch above.

**`extension "vector" is not available` at the first start.** The database is a Postgres without
pgvector. Use the compose file's `pgvector/pgvector` image; on a database of your own, install
pgvector for its Postgres version (15 or newer).

**`refusing to migrate: the database's migrations don't match this build`, then the app exits.** The
`reason` in that log line says which case. "It was migrated by a newer version": the image is older
than the database, after a rollback; run that version or a newer one, or restore the dump taken
before the upgrade. "Migration … was changed after it was applied": the image was built from edited
migrations, and committed migrations never change.

**`Invalid configuration`, then restarts.** A required value is missing or malformed in `.env`; the
log lists each one.

**Emails don't arrive.** At every start the log line `transactional email` names the sender in use.
`log` means none is configured, and each email is only written to the log. With `smtp` or
`millionsend`, check that the domain of `EMAIL_FROM` is verified with your provider.

**"This address points to an internal network".** Connectors, databases, mailboxes and an
organization's own bucket must be reachable at public addresses: private, loopback and link-local
addresses are refused, so nobody can turn the server against its own network. Reach internal services
through a connected computer instead.

</details>
