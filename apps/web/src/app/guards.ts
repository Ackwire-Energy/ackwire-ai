import { redirect } from "@tanstack/react-router";
import { meQuery } from "@/api/queries";
import type { Me } from "@/api/types";
import type { RouterContext } from "./router-context";

/** Route guard: the signed-in person, or a redirect to /login that comes back afterwards. */
export async function requireUser(context: RouterContext, href: string): Promise<Me> {
  const me = await context.queryClient.ensureQueryData(meQuery(context.api));
  if (!me) throw redirect({ to: "/login", search: { redirect: href } });
  return me;
}

/**
 * The signed-in person, sure to include `orgId` when they belong to it: the
 * cached list can predate a workspace just created or joined, so a miss asks
 * the server again before saying "you're not part of this organization".
 */
export async function requireUserIn(context: RouterContext, href: string, orgId: string): Promise<Me> {
  const me = await requireUser(context, href);
  if (me.organizations.some((o) => o.id === orgId)) return me;
  const fresh = await context.queryClient.fetchQuery({ ...meQuery(context.api), staleTime: 0 });
  if (!fresh) throw redirect({ to: "/login", search: { redirect: href } });
  return fresh;
}
