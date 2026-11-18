import { CONNECTOR_MARK } from "@agenteschat/client/lib/connected";

/**
 * The web's connector mark named like the surface (`/connectors/<name>.svg`), or null when its name can't name one.
 * The name is the operator's own, so the file may not exist: load it before showing it.
 */
export function surfaceMarkUrl(name: string): string | null {
  const url = `/connectors/${name.trim().toLowerCase()}.svg`;
  return CONNECTOR_MARK.test(url) ? url : null;
}
