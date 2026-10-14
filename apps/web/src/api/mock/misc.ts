/**
 * MOCK — small gaps.
 * - Org-wide invite link. Waiting for: POST /api/app/organizations/{orgId}/invite-links
 *   (today only per-email invitations exist). The mock link opens the
 *   "invalid invitation" state.
 * - "Pedir um novo convite" on an expired invitation. Waiting for:
 *   POST /api/app/invitations/{token}/request-new (notifies the inviter).
 */
import type { MockedApi } from "../client";
import { type MockContext, mockId } from "./context";

export function createMockInvites(ctx: MockContext, origin: () => string): MockedApi["invites"] {
  return {
    createLink: async () => ({
      url: `${origin()}/invite/${mockId("link")}`,
      expiresAt: new Date(ctx.now().getTime() + 7 * 86_400_000).toISOString(),
    }),
    requestNew: async () => {},
  };
}
