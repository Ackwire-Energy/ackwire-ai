# 0111. The Drive's trash and who can see a file

- Status: Accepted (built)
- Date: 2026-11-01
- Code: `packages/engine/src/artifacts.ts` (`withPersonFacts`, `ArtifactAudience`, `deletableIds`, `purgeArtifactNow`), `apps/server/src/routes/app/artifacts.ts`, `packages/client/src/lib/drive.ts` (`driveSections`, `artifactPlace`), `apps/web/src/components/drive/*`, `apps/web/src/pages/DrivePage.tsx`

## Context

The Drive already had a trash: deleting a file sets `artifacts.deleted_at`, the file leaves the lists, search (the `file` document builder returns nothing for it) and every agent tool (`loadArtifact` and `listArtifacts` skip it), it can be restored for 30 days, and the `artifactPurge` worker removes its versions' blobs and rows after that, leaving the row as a tombstone so old messages can say "Arquivo removido". Three things were missing in the app:

- The server never sent `canDelete`, so the web hid "Mover para a lixeira" from everyone, the owner included.
- A file from a DM linked to `/c/<dm id>`, a channel page that doesn't exist for a DM.
- Nothing told a person who can see a file.

## Decision

1. **`canDelete` and `audience` on every file a person reads** (list, get, create, new version), computed in one batch by `withPersonFacts`. Agents' views don't carry them.
2. **Who may delete and restore** (unchanged rule, now batched in `deletableIds`): the creator; for a file an agent made, the agent's owner and the person whose message started the run that made its first version; admins (`configure`). Everyone else doesn't see the action, and the API answers 403.
3. **Delete for good** from the trash (`DELETE …/artifacts-trash/{id}`, same people): the versions go at once, as the purge would take them. The row is backdated past the trash window instead of a new column: a tombstone is exactly a row deleted longer ago than the trash keeps it, so it leaves the trash and can't be restored. No migration.
4. **Who can see a file** follows the conversation it came from, the same rule the engine already applies:
   - no conversation: the whole workspace;
   - a public channel: the whole workspace (anyone may open a public channel's files);
   - a private channel: its members;
   - a DM: its two participants, nobody else, admins included.
   Agents follow the same rule, narrower: the run's own conversation, public channels they belong to, and the conversations they share with the person who asked (`agentSearchChannels`, `requesterSharedChannels`). That is what they list, change and copy elsewhere. By id they also read whatever the person behind the run may see, while that person is still in the workspace, and what a teammate made for that person in the agents' DM (amended 2026-11-06): an id reaches an agent through an attachment from another conversation, from the agent that asked it for that person, or in a consulted agent's answer. Without a person behind the run the listing's rule is the whole rule. So an agent sees a DM's file only from inside that DM or on behalf of the person it shares that DM with.
   `audience` is `{ kind: "workspace" }`, `{ kind: "channel", name, private }` or `{ kind: "dm", with }` (the other side, from the viewer's side).
5. **The app says it**: one line under the details' actions ("Só você e Atlas podem ver: veio de uma mensagem direta", "Só os membros de #x podem ver", "Todo o workspace pode ver: está no canal público #eng"), and the Drive puts DM and private-channel files in a "Privado" section of their own, last, whatever the grouping.
6. **Where it opens** (`artifactPlace`): its thread when it has one, else its DM (by the other side: `/dm/agent/…` or `/dm/person/…`) or channel. A Drive-only file has no such button. Only people who can open the conversation ever see the file, so the link never lands on a page they can't open.
7. **The trash doesn't count toward storage** (unchanged): `storedBytes` leaves trashed files out and a restore checks for room again. The trash view says so.

## Consequences

- Live files had no leak: people read a channel's file only as members or when the channel is public, and a DM's file only as one of its two sides. The trash had one: its list, restore and delete for good checked only who may delete, so an admin or an agent's owner saw (and could restore or destroy) a trashed file from a DM they aren't in. The trash now applies the same read rule (`personReadableChannels`, `personCanRead`); outside it, restore and delete for good answer 404.
- Restore and delete for good both write only while the file is still in the trash (a conditional update), so when they race the first to commit wins and a restored file keeps its contents.
- A DM whose other side is an archived agent or a person who left (or was blocked) can't be opened (`openDm` refuses it): its files carry `audience.gone`, and the app shows no way into it.
- The chat file card's right click (desktop app) offers "Mover para a lixeira" to the same people.
- Moving a file between conversations isn't possible, so `audience` never changes after creation; a DM's file that someone re-attaches elsewhere stays readable only by the DM's two sides.
- If the trash should count toward storage, that's `storedBytesQueries` dropping the `deleted_at` filter and `restoreArtifact` dropping its room check; it stays a product decision.
