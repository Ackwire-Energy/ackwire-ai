-- AW-003: keep existing agents on their selected account during this upgrade.
-- New agents retain the upstream default (brain_account_pinned = false).
UPDATE "agents" SET "brain_account_pinned" = true;
