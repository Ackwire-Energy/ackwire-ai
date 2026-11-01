import { channelsQuery } from "@agenteschat/client";
import { noAnswer } from "@agenteschat/client/lib/errors";
import { startPlace } from "@agenteschat/client/lib/home";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { channelOfPath, lastPlace, opensWorkspace } from "@/lib/start";

/**
 * `/org/$orgId`: opening the workspace lands where the person chose (ADR 0108), Início by default. A move inside the
 * workspace, or a link that carries a request (`?connect=ai`), goes to Início, the request with it.
 */
export const Route = createFileRoute("/org/$orgId/")({
  beforeLoad: async ({ context, params, search }) => {
    const home = { to: "/org/$orgId/home" as const, params, search };
    const choice = context.membership?.start;
    if (!opensWorkspace(params.orgId) || Object.keys(search).length > 0 || !choice || choice.page === "home")
      throw redirect(home);
    const channels = await context.queryClient
      .ensureQueryData(channelsQuery(context.api, params.orgId))
      // A list the server didn't answer for is the can't-reach screen (ErrorScreen), never a place it can't check.
      .catch((error: unknown) => {
        if (noAnswer(error)) throw error;
        return [];
      });
    const inChannel = (id: string) => channels.some((c) => c.id === id && c.isMember);
    const last = lastPlace(params.orgId);
    const lastChannel = last ? channelOfPath(last) : null;
    const place = startPlace(choice, { last: lastChannel && !inChannel(lastChannel) ? null : last, inChannel });
    if (place.kind === "channel")
      throw redirect({ to: "/org/$orgId/c/$channelId", params: { orgId: params.orgId, channelId: place.channelId } });
    if (place.kind === "last") throw redirect({ href: place.place });
    throw redirect(home);
  },
});
