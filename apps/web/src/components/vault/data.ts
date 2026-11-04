import type {
  VaultConnectInput,
  VaultConnection,
  VaultConnectionPatch,
  VaultImportResult,
  VaultItem,
  VaultItemInput,
  VaultItemPatch,
  VaultScope,
} from "@agenteschat/client";
import {
  useConnectVault,
  useCreateVaultItem,
  useDeleteVaultConnection,
  useDeleteVaultItem,
  useImportVault,
  useSyncVaultConnection,
  useUpdateVaultConnection,
  useUpdateVaultItem,
} from "@agenteschat/client";

/*
 * The Vault's writes as the web's screens call them (ADR 0144), in one place: each resolves to its result, or to
 * null when it failed (the app's toast already said why, in the person's words). The hooks invalidate the Vault's
 * queries themselves.
 */

/** Runs a write; a failure is null (already shown by the toast every failed write gets). */
async function attempt<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}

export function useVaultItemActions(orgId: string) {
  const create = useCreateVaultItem(orgId);
  const update = useUpdateVaultItem(orgId);
  const remove = useDeleteVaultItem(orgId);
  return {
    create: (input: VaultItemInput): Promise<VaultItem | null> => attempt(() => create.mutateAsync(input)),
    update: (itemId: string, patch: VaultItemPatch): Promise<VaultItem | null> =>
      attempt(() => update.mutateAsync({ ...patch, itemId })),
    remove: async (itemId: string): Promise<boolean> =>
      (await attempt(async () => {
        await remove.mutateAsync(itemId);
        return true;
      })) === true,
    creating: create.isPending,
    updating: update.isPending,
    removing: remove.isPending,
  };
}

export function useVaultImport(orgId: string) {
  const run = useImportVault(orgId);
  return {
    run: (input: { csv: string; scope: VaultScope; dryRun: boolean }): Promise<VaultImportResult | null> =>
      attempt(() => run.mutateAsync(input)),
    busy: run.isPending,
  };
}

export function useVaultConnectionActions(orgId: string) {
  const connect = useConnectVault(orgId);
  const update = useUpdateVaultConnection(orgId);
  const sync = useSyncVaultConnection(orgId);
  const remove = useDeleteVaultConnection(orgId);
  return {
    connect: (input: VaultConnectInput): Promise<VaultConnection | null> => attempt(() => connect.mutateAsync(input)),
    update: (connectionId: string, patch: VaultConnectionPatch): Promise<VaultConnection | null> =>
      attempt(() => update.mutateAsync({ ...patch, connectionId })),
    sync: (connectionId: string): Promise<VaultConnection | null> => attempt(() => sync.mutateAsync(connectionId)),
    remove: async (connectionId: string): Promise<boolean> =>
      (await attempt(async () => {
        await remove.mutateAsync(connectionId);
        return true;
      })) === true,
    connecting: connect.isPending,
    updating: update.isPending,
    syncing: sync.isPending,
    removing: remove.isPending,
  };
}
