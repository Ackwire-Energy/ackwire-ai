/**
 * Wraps and unwraps data keys for envelope encryption of provider credentials
 * (docs/adr/0007-provider-credentials.md). Core: a key derived from
 * AGENTES_SECRET (`local:v1`, in `@agenteschat/engine`). Cloud: a KMS module.
 * `aad` binds the wrapped key to its owner (org and credential ids).
 */
export interface KeyWrapper {
  /** Stored next to each wrapped key, so old keys stay readable after rotation. */
  readonly id: string;
  wrap(dataKey: Uint8Array, aad: string): Promise<string>;
  unwrap(wrapped: string, aad: string): Promise<Uint8Array>;
}

/**
 * Supplies the platform's own provider key for agents without an org
 * credential. Core has none (self-hosters bring their own key); Cloud resells
 * tokens through this hook.
 */
export interface PlatformCredentials {
  resolve(orgId: string, provider: string): Promise<{ apiKey: string } | null>;
}

export const noPlatformCredentials: PlatformCredentials = { resolve: async () => null };
