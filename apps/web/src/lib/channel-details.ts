/**
 * "Editar canal" from outside the channel's page (the sidebar's right click): the page opens its details when it
 * shows that channel, now or once it mounts after the navigation.
 */
const EVENT = "agentes:channel-details";
let pending: string | null = null;

export function requestChannelDetails(channelId: string) {
  pending = channelId;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: channelId }));
}

/** True once for the channel asked for (the page then opens its details). */
export function takeChannelDetails(channelId: string) {
  if (pending !== channelId) return false;
  pending = null;
  return true;
}

export function onChannelDetails(cb: () => void) {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
