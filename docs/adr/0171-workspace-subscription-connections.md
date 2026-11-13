# 0171 — Connect subscriptions from workspace AI

Date: 2026-11-12

Status: Accepted

## Context

Ackwire already runs Claude Code and Codex on connected computers. However, opening
subscription setup without a computer selected the API-key form. The right hand's
workspace AI settings also listed only accounts already connected, leaving no direct
way to sign in there. This made subscription access look like an API-only feature.

Openbot's CLI sign-in lifecycle is a reference for the experience: the provider's
CLI owns authentication on its host, and the application presents the sign-in flow.
No Openbot source is copied.

## Decision

Keep subscription setup selected when a computer is missing, and show the existing
computer setup step. Explicit API-key requests and key-only administrators retain
their existing defaults.

Add Connect Claude and Connect Codex to the workspace AI settings. Carry the explicit
workspace scope through the brain read, existing-account selection, new-account
assignment and audience changes. Personal AI connections continue using their own
scope. The server continues enforcing permissions and subscription audience rules.
The right hand's picker offers explicit accounts, as required by the server, rather
than the host CLI's implicit sign-in.

For a native self-hosted installation, use the existing HOST_COMPUTER_TOKEN and
runner host service to make the backend machine available to its workspaces. The
runner invokes the installed provider CLIs; subscription credentials stay on that
machine. No subscription token is turned into an API key or sent to the web client.

The existing account sharing, usage limits and unattended-run rules remain in force
(ADRs 0059 and 0137). A workspace connection does not promise unlimited usage or
change the provider's account entitlements.

## Verification

Regression tests cover the missing-computer default and both workspace connection
buttons, including the workspace scope of the account assignment.

References:
- https://github.com/nightly-labs/openbot/blob/main/src/backend/agent/cli-login-flow.ts
- https://developers.openai.com/codex/auth
- https://code.claude.com/docs/en/authentication
