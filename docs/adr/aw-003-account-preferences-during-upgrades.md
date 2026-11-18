# AW-003 — Account preferences during upstream upgrades

Date: 2026-11-18

Status: Accepted

## Context

Upstream adds ordered account selection when a Claude or Codex plan reaches its limit.
It also replaces the per-agent paid-extra-usage preference with a decision based on
account ownership. Existing Ackwire agents have a selected account and may have an
explicit paid-usage opt-out.

## Decision

Pin existing agents to their selected account during the upgrade. The account-order
feature remains available through the normal settings, where a person can opt an
existing agent into automatic selection. New agents retain the upstream default.
Migration `0296_ackwire_preserve_account_choice` follows the imported upstream migrations
and performs this transition once.

Keep the stored paid-extra-usage preference effective. An agent whose preference is
off continues waiting when its included plan allowance runs out. Its owner can
change the preference from the web or mobile app, and older clients can continue
using the existing API field. Updates that omit the field preserve its value.

Paid extra usage also requires the upstream eligibility checks and room reported by
the plan. A borrowed plan and the workspace assistant remain ineligible. The
executor, pause/resume logic and account-selection path use the same decision.

Ordinary computer-backed agents adopt upstream's removal of API fallback. Their
waiting state explains the account or computer condition. The workspace assistant
retains its upstream fallback behavior.

## Verification

Exercise both pre-integration and 0285 databases, including agents with paid usage
enabled and disabled, account selection, records created after the migration, and
repeated migrations. Check the API, web and mobile preference controls and the run
paths for own accounts, borrowed accounts and the workspace assistant.

This decision governs Ackwire's account behavior where upstream ADRs 0041, 0059 and
0118 describe different defaults. Upstream migration files remain immutable.
