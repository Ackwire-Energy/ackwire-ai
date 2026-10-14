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
