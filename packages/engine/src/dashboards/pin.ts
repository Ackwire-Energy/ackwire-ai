import type { DashboardDeps, PinnableBlockView, PinWidgetInput, WidgetView } from "./types";

/**
 * "Pin" a chart an agent sent in chat (ADR 0134 §3). Placeholder signatures: the dashboards service stage writes the
 * bodies (see the contract).
 */

/**
 * Pins the ```chart block `input.block` of message `input.messageId` to a board the person edits: the person must read
 * the message (its channel or thread), the message must be an agent's and hold that block (`chartBlocksOf`, compared
 * trimmed) that `chartBlockToWidgetSpec` reads. The widget keeps the block's data (`ok`), its agent is the message's,
 * its title the chart's (or `input.title`), its instructions "keep this up to date" with the chart's title, subtitle
 * and the message's text around it, and `source_message_id` the message. A schedule other than `manual` needs the
 * person to be able to talk to the agent and makes its routine.
 */
export async function pinMessageAsWidget(
  _deps: DashboardDeps,
  _actorId: string,
  _orgId: string,
  _dashboardId: string,
  _input: PinWidgetInput,
): Promise<WidgetView> {
  throw new Error("not implemented");
}

/**
 * "Pin from chat": the latest chart blocks agents sent where the person reads (channels and threads they're in, their
 * DMs with agents), last 30 days, newest first, at most `limit` (default 20), each read by `chartBlockToWidgetSpec`.
 */
export async function listPinnableBlocks(
  _deps: DashboardDeps,
  _actorId: string,
  _orgId: string,
  _limit?: number,
): Promise<PinnableBlockView[]> {
  throw new Error("not implemented");
}
