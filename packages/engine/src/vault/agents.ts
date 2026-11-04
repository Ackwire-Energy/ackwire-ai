/**
 * The Vault for agents (ADR 0142): what a run may list, type, give to a command and change. Every call reads who is
 * behind the run (`vaultPersonOfRun`) and checks each item (`runAccess`); a refusal is a `VaultRefusal` with English
 * words for the model, never a hint that an item hidden from the run exists, and never an item's title or anything
 * else written on it (`named`: its kind, id, a login's site, a key's variable name; ADR 0117).
 *
 * Values leave here only through `releaseVaultLogin` and `releaseVaultKeys`, to the tool that seals them for the
 * agent's own computer at once. A contact's fields are not secret: agents read them and type them.
 */
import {
  isReservedSecretName,
  SECRET_NAME,
  VaultSourceError,
  vaultOrigin,
  vaultRule,
  vaultRuleLabel,
  vaultRuleMatches,
} from "@agenteschat/adapters";
import { and, type Executor, eq, inArray, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { UUID } from "../authority";
import { SealedValueError } from "../crypto";
import { ConflictError, ValidationError } from "../errors";
import { publishVaultChanged } from "../events";
import {
  type ConnectionRow,
  effectiveColumns,
  type ItemRow,
  runAccess,
  type VaultRunPerson,
  vaultPersonOfRun,
} from "./access";
import { assertRoom, cleanContact, cleanText, connectionRow } from "./items";
import { named, refuse, vaultItemName } from "./refusals";
import { readItemValue, sealItemValue } from "./seal";
import {
  VAULT_LIMITS,
  type VaultAgentChange,
  type VaultAgentResult,
  type VaultContactFields,
  type VaultDeps,
  type VaultItemForAgent,
  type VaultItemKind,
  type VaultReleasedLogin,
  type VaultRun,
  vaultNow,
} from "./service";
import { recordAgentChange, recordReads } from "./uses";
import {
  agentView,
  connectionOf,
  contactOf,
  hasValue,
  hostOf,
  loadVault,
  readContact,
  sourceNameOf,
  type VaultState,
} from "./views";

const { vaultConnections, vaultItems } = schema;

/** Most keys one command gets at once. */
export const VAULT_MAX_KEYS = 10;

/** A check's own words as a refusal the agent can act on. */
async function asRefusal<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ValidationError || error instanceof ConflictError) throw refuse.notAllowed(error.message);
    throw error;
  }
}

/** The run may use it now: shared with it for its person, still in its source, and (a login, a key) with a value. */
const usable = (item: ItemRow, connection: ConnectionRow | undefined, person: VaultRunPerson, agentId: string) =>
  !item.missing &&
  (item.kind === "contact" || hasValue(item)) &&
  runAccess(item.ownerUserId, effectiveColumns(item, connection), person, agentId) === "use";

/** Whether a login is for a site the agent named (an address, or part of one). */
function forSite(item: ItemRow, site: string): boolean {
  if (item.kind !== "login" || !item.website) return false;
  const origin = vaultOrigin(site);
  const rule = vaultRule(item.website, item.match === "site" ? "site" : "exact");
  if (origin && rule && vaultRuleMatches(rule, origin)) return true;
  const text = site.trim().toLowerCase();
  return text.length > 0 && hostOf(item.website).toLowerCase().includes(text);
}

/** What a query is looked for in: everything the agent would see of the item. */
function haystack(item: ItemRow, contact: VaultContactFields | null) {
  return [item.title, item.description, item.website, item.username, item.keyName, ...Object.values(contact ?? {})]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

/**
 * The items this run may use, metadata only (contacts with their fields), optionally narrowed by kind, site or a
 * query, in the order a list shows them. `shown`: how many of the first ones the caller shows (`vault_list`'s
 * `VAULT_LIST_MAX`): only those contacts' fields are read, past what a query needs to match, and only those are
 * recorded as read, once per run; the rest come without their fields, to be counted. `given`: who is behind the run,
 * when the caller already read it (`vaultPersonOfRun`).
 */
export async function listUsableVault(
  deps: VaultDeps,
  run: VaultRun,
  filter: { kind?: VaultItemKind; site?: string; query?: string } = {},
  given?: VaultRunPerson,
  shown = Number.POSITIVE_INFINITY,
): Promise<VaultItemForAgent[]> {
  const person = given ?? (await vaultPersonOfRun(deps.db, run));
  const state = await loadVault(deps.db, run.orgId);
  let items = state.items.filter((item) => usable(item, connectionOf(state, item), person, run.agentId));
  if (filter.kind) items = items.filter((item) => item.kind === filter.kind);
  const site = filter.site?.trim();
  if (site) items = items.filter((item) => forSite(item, site));
  const contacts = new Map<string, VaultContactFields | null>();
  const read = async (list: ItemRow[]) => {
    for (const item of list) {
      if (item.kind === "contact" && !contacts.has(item.id)) contacts.set(item.id, await contactOf(deps, item));
    }
  };
  const query = filter.query?.trim().toLowerCase();
  if (query) {
    // Words in a contact's fields find it: every contact left is read to match.
    await read(items);
    items = items.filter((item) => haystack(item, contacts.get(item.id) ?? null).includes(query));
  }
  const listed = items.slice(0, shown);
  await read(listed);
  await recordReads(
    deps,
    run,
    person,
    listed.filter((item) => item.kind === "contact").map((item) => item.id),
  );
  const inList = new Set(listed.map((item) => item.id));
  return items.map((item) => agentView(item, inList.has(item.id) ? (contacts.get(item.id) ?? null) : null));
}

/** An item by id as the run sees it: hidden ones (and ids that aren't ids) are not found. */
async function itemForRun(deps: VaultDeps, run: VaultRun, person: VaultRunPerson, itemId: string, what: string) {
  const missingItem = () => refuse.notFound(`No Vault ${what} with that id is shared with you. Look with vault_list.`);
  if (typeof itemId !== "string" || !UUID.test(itemId)) throw missingItem();
  const [item] = await deps.db
    .select()
    .from(vaultItems)
    .where(and(eq(vaultItems.orgId, run.orgId), eq(vaultItems.id, itemId)));
  if (!item) throw missingItem();
  const connection = await connectionRow(deps.db, run.orgId, item.connectionId);
  const access = runAccess(item.ownerUserId, effectiveColumns(item, connection), person, run.agentId);
  if (access === "hidden") throw missingItem();
  if (access === "not_shared") throw refuse.notShared(item);
  const source = connection ? sourceNameOf(deps.sources, connection.kind) : "the Vault";
  if (item.missing) throw refuse.missing(item, source);
  return { item, connection, source };
}

/** A login's or key's value now, or the refusal that says why not. */
async function valueForRun(deps: VaultDeps, item: ItemRow, connection: ConnectionRow | undefined, source: string) {
  let value: string | null;
  try {
    value = await readItemValue(deps, item, connection);
  } catch (error) {
    if (error instanceof VaultSourceError) throw refuse.sourceError(source, error.message);
    if (error instanceof SealedValueError) throw refuse.noValue(item);
    throw error;
  }
  if (!value) throw refuse.noValue(item);
  return value;
}

/**
 * A shared browser profile a login would be typed in (ADR 0110): its name and every agent granted it, this one
 * included. A session it signs in to there is every one of those agents'.
 */
export interface VaultBrowserProfile {
  name: string;
  agentIds: readonly string[];
}

/**
 * Whether a login may be typed in a shared browser profile (ADR 0142 §2, ADR 0110): the session it opens stays in
 * the profile for every agent granted it, whoever each one works for. So a personal login never is, nor a team login
 * open only to some people (an agent there working for anyone else would act signed in with it); a team login open
 * to everyone, only when it is shared with all agents or with each agent the profile is granted to.
 */
function assertProfileMay(item: ItemRow, connection: ConnectionRow | undefined, profile: VaultBrowserProfile) {
  if (item.ownerUserId) {
    throw refuse.notAllowed(
      `${named(item)} is a personal login, and your browser now is the shared profile "${profile.name}": every agent granted that profile would be signed in as its owner. Switch to your own browser (browser_profile with "own") to sign in with it.`,
    );
  }
  const columns = effectiveColumns(item, connection);
  if (!columns.audienceEveryone) {
    throw refuse.notAllowed(
      `${named(item)} is open only to some people in the workspace, and your browser now is the shared profile "${profile.name}": every agent granted that profile would be signed in with it, whoever they work for. Switch to your own browser (browser_profile with "own") to sign in with it.`,
    );
  }
  if (columns.allAgents || profile.agentIds.every((id) => columns.agentIds.includes(id))) return;
  throw refuse.notAllowed(
    `${named(item)} isn't shared with every agent that uses the browser profile "${profile.name}", so it isn't typed there: they would all be signed in with it. Switch to your own browser (browser_profile with "own"), or ask a person who manages the login to share it with all of them in Settings, Vault.`,
  );
}

/** An id that names a key or a contact where a login was asked for. */
const notALogin = (item: ItemRow) =>
  refuse.notAllowed(`The Vault item ${item.id} is a ${item.kind}, not a login. Use a login's id from vault_list.`);

/**
 * A login the run may type, checked before anything runs: shared with it for the person behind the run, still in its
 * source, with a value, and fit for the shared profile when there is one. Its value isn't read (the source isn't
 * asked): `releaseVaultLogin` checks all of it again at the step that types it.
 */
export async function checkVaultLogin(
  deps: VaultDeps,
  run: VaultRun,
  itemId: string,
  profile: VaultBrowserProfile | null,
): Promise<void> {
  const person = await vaultPersonOfRun(deps.db, run);
  const { item, connection } = await itemForRun(deps, run, person, itemId, "login");
  if (item.kind !== "login") throw notALogin(item);
  if (!hasValue(item)) throw refuse.noValue(item);
  if (profile) assertProfileMay(item, connection, profile);
}

/**
 * A login's password and the rule of where it may be typed, for the tool that seals it for the agent's computer
 * (which checks the rule again against the field's own frame when it types). With `pageOrigin` (the page the agent
 * is on), a page the rule doesn't allow is refused before the value is read; with `profile` (the run's browser is a
 * shared profile), so is a login that profile may not hold. The use is recorded by the caller once the computer
 * typed it (`recordVaultUse`).
 */
export async function releaseVaultLogin(
  deps: VaultDeps,
  run: VaultRun,
  itemId: string,
  pageOrigin: string | null,
  profile: VaultBrowserProfile | null = null,
): Promise<VaultReleasedLogin> {
  const person = await vaultPersonOfRun(deps.db, run);
  const { item, connection, source } = await itemForRun(deps, run, person, itemId, "login");
  if (item.kind !== "login") throw notALogin(item);
  if (profile) assertProfileMay(item, connection, profile);
  const rule = item.website ? vaultRule(item.website, item.match === "site" ? "site" : "exact") : null;
  if (!rule) throw refuse.noWebsite();
  if (pageOrigin && !vaultRuleMatches(rule, pageOrigin))
    throw refuse.wrongSite(vaultRuleLabel(rule), hostOf(pageOrigin));
  const password = await valueForRun(deps, item, connection, source);
  return { item: agentView(item, null), password, rule };
}

/** Prefers the person's own key over the team's, a built-in one over an external one, then the newest. */
const keyOrder = (personId: string | null) => (a: ItemRow, b: ItemRow) => {
  const rank = (item: ItemRow) =>
    (item.ownerUserId && item.ownerUserId === personId ? 0 : 2) + (item.connectionId ? 1 : 0);
  return rank(a) - rank(b) || b.updatedAt.getTime() - a.updatedAt.getTime();
};

/**
 * The workspace's keys with these variable names and their connections: only those rows, never the whole Vault (a
 * command asks for a few names).
 */
async function keysNamed(db: Executor, orgId: string, names: string[]): Promise<VaultState> {
  const items = await db
    .select()
    .from(vaultItems)
    .where(and(eq(vaultItems.orgId, orgId), eq(vaultItems.kind, "key"), inArray(vaultItems.keyName, names)));
  const ids = [...new Set(items.flatMap((item) => (item.connectionId ? [item.connectionId] : [])))];
  const connections =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(vaultConnections)
          .where(and(eq(vaultConnections.orgId, orgId), inArray(vaultConnections.id, ids)));
  return { items, connections: new Map(connections.map((c) => [c.id, c])) };
}

/**
 * The values of the keys a command asked for by variable name, each from a key this run may use. The use of each
 * is recorded by the caller once the command started (`recordVaultUse`, action `key`).
 */
export async function releaseVaultKeys(
  deps: VaultDeps,
  run: VaultRun,
  names: string[],
): Promise<{ name: string; value: string; itemId: string }[]> {
  const wanted = [...new Set(names.map((n) => (typeof n === "string" ? n.trim() : "")))];
  if (wanted.length === 0) return [];
  if (wanted.length > VAULT_MAX_KEYS) throw refuse.notAllowed(`At most ${VAULT_MAX_KEYS} keys in one command.`);
  for (const name of wanted) {
    if (!SECRET_NAME.test(name))
      throw refuse.notAllowed(`${name || "That"} isn't a variable name. Use capital letters, digits and _.`);
    if (isReservedSecretName(name))
      throw refuse.notAllowed(`${name} is reserved for how agents think. No key uses it.`);
  }
  const person = await vaultPersonOfRun(deps.db, run);
  const state = await keysNamed(deps.db, run.orgId, wanted);
  const out: { name: string; value: string; itemId: string }[] = [];
  for (const name of wanted) {
    const keys = state.items.filter((item) => item.keyName === name);
    const access = (item: ItemRow) =>
      runAccess(item.ownerUserId, effectiveColumns(item, connectionOf(state, item)), person, run.agentId);
    const ready = keys.filter((item) => usable(item, connectionOf(state, item), person, run.agentId));
    const item = ready.sort(keyOrder(person.personId))[0];
    if (!item) {
      const known = keys.filter((key) => access(key) !== "hidden");
      const notShared = known.find((key) => access(key) === "not_shared");
      if (notShared) throw refuse.notShared(notShared);
      const gone = known.find((key) => key.missing);
      if (gone) {
        const kind = connectionOf(state, gone)?.kind;
        throw refuse.missing(gone, kind ? sourceNameOf(deps.sources, kind) : "its password manager");
      }
      if (known[0]) throw refuse.noValue(known[0]);
      throw refuse.notFound(
        `No key named ${name} is shared with you in the Vault. Ask the person to save it in Settings, Vault, or use request_secret.`,
      );
    }
    const connection = connectionOf(state, item);
    const source = connection ? sourceNameOf(deps.sources, connection.kind) : "the Vault";
    out.push({ name, value: await valueForRun(deps, item, connection, source), itemId: item.id });
  }
  return out;
}

/** The agent's audit line for an item it changed. */
function auditByAgent(
  db: Executor,
  run: VaultRun,
  person: VaultRunPerson,
  action: string,
  item: Pick<ItemRow, "id" | "kind" | "title" | "ownerUserId">,
  extra: Record<string, unknown> = {},
) {
  return recordAudit(db, {
    orgId: run.orgId,
    actor: { type: "agent", id: run.agentId },
    action,
    target: { type: "vault_item", id: item.id },
    details: { kind: item.kind, title: item.title, scope: item.ownerUserId ? "personal" : "team", ...extra },
    runId: run.runId,
    onBehalfOfUserId: person.personId,
  });
}

/**
 * An agent's change (`vault_save`): a new contact, personal to the person behind the run (none behind it: refused),
 * or, on an item it may use, a contact's title and fields, a login's username or any item's description. A personal
 * item changes for its owner (only their runs see it); a team item only for someone who manages credentials, as in
 * the app (ADR 0142 §2). Only built-in items: an external one changes in its source. A contact whose saved fields
 * don't open here is refused: its fields are only ever changed on top of what was saved.
 */
export async function saveVaultItemByAgent(
  deps: VaultDeps,
  run: VaultRun,
  change: VaultAgentChange,
): Promise<VaultAgentResult> {
  const { db } = deps;
  const person = await vaultPersonOfRun(db, run);
  if (!change.itemId) return createContact(deps, run, person, change);

  const { item, source } = await itemForRun(deps, run, person, change.itemId, "item");
  if (item.connectionId) throw refuse.notAllowed(`${named(item)} comes from ${source}. It changes there, not here.`);
  if (!item.ownerUserId && !(person.personId && person.manages)) {
    throw refuse.notAllowed(
      `${named(item)} is the team's: only someone who manages credentials changes it, and nobody behind this request does. Ask one of them, or a person can change it in Settings, Vault.`,
    );
  }
  const kind = item.kind as VaultItemKind;
  const set: Partial<typeof vaultItems.$inferInsert> = {};
  const fields: string[] = [];
  let contact: VaultContactFields | null = null;
  if (kind === "contact") {
    const saved = await readContact(deps, item);
    // Its fields don't open here: a change would be merged onto nothing and replace them all.
    if (saved.unreadable) {
      throw refuse.notAllowed(
        `${named(item)} can't be read here (its saved fields don't open on this server), so it isn't changed. Ask a person to save it again in Settings, Vault.`,
      );
    }
    contact = saved.contact;
  }
  await asRefusal(async () => {
    if (change.description !== undefined) {
      set.description = cleanText(change.description, VAULT_LIMITS.description, "description");
      fields.push("description");
    }
    if (change.username !== undefined) {
      if (kind !== "login") throw new ValidationError(`${named(item)} is a ${kind}. Only a login has a username.`);
      set.username = cleanText(change.username, VAULT_LIMITS.username, "username") || null;
      fields.push("username");
    }
    if (change.title !== undefined) {
      if (kind !== "contact") throw new ValidationError("Only a contact's name changes here.");
      const title = cleanText(change.title, VAULT_LIMITS.title, "title");
      if (!title) throw new ValidationError("A contact needs a name.");
      set.title = title;
      fields.push("title");
    }
    if (change.contact !== undefined) {
      if (kind !== "contact") throw new ValidationError(`${named(item)} is a ${kind}, not a contact.`);
      contact = cleanContact({ ...(contact ?? {}), ...change.contact });
      fields.push("contact");
    }
  });
  if (fields.length === 0) return { outcome: "updated", item: agentView(item, contact) };
  if (fields.includes("contact") && contact)
    Object.assign(set, await sealItemValue(deps, item, item.secretVersion + 1, JSON.stringify(contact)));
  set.updatedAt = vaultNow(deps);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(vaultItems)
      .set(set)
      .where(and(eq(vaultItems.id, item.id), eq(vaultItems.secretVersion, item.secretVersion)))
      .returning();
    if (!updated) throw refuse.notAllowed("It changed meanwhile. Read it again with vault_list and retry.");
    await recordAgentChange(tx, run, person, item.id, "edit");
    await auditByAgent(tx, run, person, "vault.item_changed", updated, { fields });
    return updated;
  });
  await publishVaultChanged(deps.pubsub, run.orgId);
  return { outcome: "updated", item: agentView(row, contact) };
}

async function createContact(
  deps: VaultDeps,
  run: VaultRun,
  person: VaultRunPerson,
  change: VaultAgentChange,
): Promise<VaultAgentResult> {
  const ownerUserId = person.personId;
  if (!ownerUserId) throw refuse.noPerson();
  if (change.username !== undefined) throw refuse.notAllowed("A contact has no username. Save its fields instead.");
  const { contact, title, description } = await asRefusal(() => {
    const contact = cleanContact(change.contact);
    const given = cleanText(change.title, VAULT_LIMITS.title, "title");
    const title = given || contact.fullName || contact.company || contact.email || "";
    if (!title) throw new ValidationError("A contact needs a name.");
    return {
      contact,
      title: title.slice(0, VAULT_LIMITS.title),
      description: cleanText(change.description, VAULT_LIMITS.description, "description"),
    };
  });
  await asRefusal(() => assertRoom(deps.db, run.orgId));
  const id = Bun.randomUUIDv7();
  const sealed = await sealItemValue(deps, { orgId: run.orgId, id, ownerUserId }, 1, JSON.stringify(contact));
  const row = await deps.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(vaultItems)
      .values({
        id,
        orgId: run.orgId,
        kind: "contact",
        ownerUserId,
        title,
        description,
        ...sealed,
        // A personal item: any agent its owner asks may use it (ADR 0142).
        allAgents: true,
        createdByAgentId: run.agentId,
      })
      .returning();
    if (!created) throw new Error("vault item insert returned nothing");
    await recordAgentChange(tx, run, person, id, "create");
    await auditByAgent(tx, run, person, "vault.item_created", created);
    return created;
  });
  await publishVaultChanged(deps.pubsub, run.orgId);
  return { outcome: "created", item: agentView(row, contact) };
}

/**
 * An agent deletes an item it may use (`vault_delete`), only one it saved itself (ADR 0142 §2): anything people saved,
 * personal or the team's, is deleted by people in the app, where they see what goes. Only built-in items.
 */
export async function deleteVaultItemByAgent(
  deps: VaultDeps,
  run: VaultRun,
  itemId: string,
): Promise<VaultAgentResult> {
  const person = await vaultPersonOfRun(deps.db, run);
  const { item, source } = await itemForRun(deps, run, person, itemId, "item");
  if (item.connectionId) throw refuse.notAllowed(`${named(item)} comes from ${source}. It goes from there, not here.`);
  if (item.createdByAgentId !== run.agentId) {
    throw refuse.notAllowed(
      `You didn't save ${vaultItemName(item)}, so you can't delete it. Someone who manages it can, in Settings, Vault.`,
    );
  }
  const contact = item.kind === "contact" ? await contactOf(deps, item) : null;
  await deps.db.transaction(async (tx) => {
    await tx.delete(vaultItems).where(and(eq(vaultItems.orgId, run.orgId), eq(vaultItems.id, item.id)));
    await auditByAgent(tx, run, person, "vault.item_deleted", item);
  });
  await publishVaultChanged(deps.pubsub, run.orgId);
  return { outcome: "deleted", item: agentView(item, contact) };
}
