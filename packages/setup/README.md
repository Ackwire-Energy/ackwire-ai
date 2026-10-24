# @agenteschat/setup

The self-host setup for [agentes.chat](https://github.com/agentes-chat/agentes-chat), the open-source
workspace for people and AI agents. One command in an empty directory takes you to a running
instance: by default on your Tailscale network, at `https://agentes.<your-tailnet>.ts.net` with a
real certificate, no domain and no open port.

```sh
npx @agenteschat/setup            # asks for what it needs
npx @agenteschat/setup --dry-run  # prints the plan, changes nothing
npx @agenteschat/setup --help     # every option
```

It needs Node.js 18 or newer, and Docker with Compose 2.23.1 or newer. No Node.js on the server?
The same setup ships in the app's image:

```sh
docker run --rm -it --user "$(id -u):$(id -g)" -v "$PWD":/work -w /work ghcr.io/agentes-chat/agentes:latest setup
```

## What it does

It looks at the current directory first and fills in only what's missing, so running it again is
safe. A `PUBLIC_URL` of your own (nginx, a tunnel) stays as it is, and choosing another way in
removes the old one's container.

1. **Docker:** checks Docker and Compose, and says how to install what's missing.
2. **How people reach it:** Tailscale (private HTTPS on your tailnet, recommended), a public domain
   (Caddy with a Let's Encrypt certificate, on ports 80 and 443), or this machine only.
3. **Tailscale:** shows the admin console steps, with their links (MagicDNS and HTTPS on, an auth
   key), and checks the key you paste. An OAuth client secret works too, for installs with nobody at
   the console.
4. **`.env`:** writes it readable by you only, with every secret generated, and keeps what's
   already there.
5. **Email** for invitations and password resets, optional: an SMTP server or a Resend-compatible
   API.
6. **Start:** downloads `docker-compose.yml` when the directory has none, runs `docker compose up -d`,
   waits for Tailscale, the HTTPS certificate and `/api/health`, and writes `PUBLIC_URL` from the
   address Tailscale gives the server.
7. **The end:** the address, a QR code for the phone app, and what to do next.

## For scripts and AI agents

Every answer is a flag or an `AGENTES_SETUP_<OPTION>` variable (`--tailscale-key` is
`AGENTES_SETUP_TAILSCALE_KEY`). With `--json` nothing is asked, stdout gets one JSON object (the
address, health and next steps, or the failed check and its fix), and progress goes to stderr.
Without a terminal, answers are read from stdin one per line, and an empty line or the end of the
input takes the default.

```sh
AGENTES_SETUP_TAILSCALE_KEY='tskey-client-…' npx -y @agenteschat/setup --network tailscale --email skip --json
```

Exit code 0: done; 1: a check failed; 2: a wrong option.

The full guide, with the phone app, a runbook for agents and troubleshooting:
[SELF_HOSTING.md](https://github.com/agentes-chat/agentes-chat/blob/main/SELF_HOSTING.md).

## License

MIT. agentes.chat itself is AGPL-3.0-only.
