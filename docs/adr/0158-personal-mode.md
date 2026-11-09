# 0158. Personal mode: the same workspace, shaped for one person

- Status: Proposed (being built)
- Date: 2026-11-09
- Amends: ADR 0137 §6 (the onboarding asks what the workspace is for; the right hand's first run has a personal set of
  rows), ADR 0155 §6 (the first-run checklist), ADR 0147 (a conversation's default look follows the mode)

## Context

agentes.chat is built for teams: channels, people, roles, approvals, audit, a sidebar and a settings page sized for a
company. People who want agents for themselves (their calendar, bills, training, studies) meet all of that on the first
screen, and most of it means nothing to them. The features are still useful to them, so nothing should go away; what
they see first, and the words, should fit one person.

## Decision

### 1. One switch per workspace

`organization_settings.mode` is `team` (the default) or `personal`. It changes defaults, words and what is in sight,
never what exists or who may do what: every route, permission, table and tool works the same in both modes. Anyone with
`configure` changes it in Settings, both ways, at any time; the change is audited. A personal workspace may have other
members (a family): the mode is for the whole workspace, so everyone in it sees the personal shape.

### 2. Onboarding

The first question is what the workspace is for: "For me" or "For my company or team". "For me" asks no name or logo:
the workspace is created as personal, named in the person's language ("Personal"), with the browser's time zone. "For
my company" shows today's name, logo and time zone.

The right hand's first-run card (ADR 0155 §6) has four rows in personal mode: what the person wants help with (areas of
life, saved as the workspace's context), their agents, an AI, their apps. The people row is left out.

### 3. The web app in personal mode

- **Sidebar:** the person's face and name on top (their menu: account, settings, switch workspace, sign out), with
  notifications and collapse beside it; "Go to…" is a row of the list; no footer. In sight: Home, Routines, Drive and
  More; Calendar, Tasks, Threads, Team and the rest start in More (the sidebar's existing per-person choices still
  win). Agents come first; channels show as "Group conversations" only once there is one; people are not listed.
- **Chat:** every conversation opens in bubbles (DMs already did); a person's own choice still wins.
- **Settings:** six sections in one list (Your account, About you, AI and apps, Plan and usage, Vault, Computers) and
  the rest under Advanced, collapsed. Every section still opens from ⌘K and from the right hand's cards.

### 4. Switching

Settings shows the mode with a button to switch. Personal → team asks only for the workspace's name and says what
appears (channels and people, invitations and roles, delegated approvals and audit) and that nothing else changes.
Team → personal says what changes and that nothing is lost; when other people are members it says they will see the
personal shape too. Inviting someone in personal mode asks whether to stay personal or switch to team.

## Consequences

- One code path: components read `isPersonal(org)` and pick defaults or words; there is no second app.
- The phone app follows in a later change; until then it shows a personal workspace as it shows any other.
- Strings are i18n keys in every language, personal variants included.

## Alternatives considered

- **A mode per person:** two people in one workspace would see different apps for the same data. Rejected: the
  workspace is the unit people set up and talk about.
- **A separate personal product:** two apps to keep in step for the same features. Rejected.
- **Hiding features in personal mode:** the user asked to keep every feature; only what is in sight changes.
