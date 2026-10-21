/**
 * Test fake — the agent browser (ADR 0040), same shapes as the server's
 * `…/agents/{id}/browser` and `…/browser/handoffs/*` routes. Agents start
 * without a browser (their computer is the cloud one); tests put handoffs in
 * `fake.handoffs` and settings in `fake.settings`.
 */
import type { AgentBrowserSettings, ApiClient, BrowserHandoff } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";

export interface FakeBrowser {
  client: ApiClient["browser"];
  settings: Map<string, AgentBrowserSettings>;
  handoffs: Map<string, BrowserHandoff>;
}

const NONE: AgentBrowserSettings = {
  allowedDomains: null,
  available: false,
  reason: "no_machine",
  detail: null,
  machine: null,
};

export function createFakeBrowser(
  log: (method: string, ...args: unknown[]) => void,
  now: () => Date,
  /** Who the session is: the person who takes control. */
  me = "u-walter",
): FakeBrowser {
  const settings = new Map<string, AgentBrowserSettings>();
  const handoffs = new Map<string, BrowserHandoff>();
  const find = (id: string) => {
    const h = handoffs.get(id);
    if (!h) throw new ApiError(404, "not_found", "Not found");
    return h;
  };
  const end = (id: string, status: BrowserHandoff["status"], note: string | null = null) => {
    const h = { ...find(id), status, note, expiresAt: null, resolvedAt: now().toISOString() };
    handoffs.set(id, h);
    return h;
  };
  const client: ApiClient["browser"] = {
    settings: async (orgId, agentId) => {
      log("browser.settings", orgId, agentId);
      return settings.get(agentId) ?? NONE;
    },
    setDomains: async (orgId, agentId, allowedDomains) => {
      log("browser.setDomains", orgId, agentId, allowedDomains);
      const next = {
        ...(settings.get(agentId) ?? NONE),
        allowedDomains: allowedDomains?.length ? allowedDomains : null,
      };
      settings.set(agentId, next);
      return next;
    },
    agentHandoff: async (orgId, agentId) => {
      log("browser.agentHandoff", orgId, agentId);
      return (
        [...handoffs.values()].find(
          (h) => h.agentId === agentId && (h.status === "pending" || h.status === "active"),
        ) ?? null
      );
    },
    handoff: async (_orgId, handoffId) => find(handoffId),
    takeControl: async (orgId, handoffId) => {
      log("browser.takeControl", orgId, handoffId);
      const h = { ...find(handoffId), status: "active" as const, controllerUserId: me, expiresAt: null };
      handoffs.set(handoffId, h);
      return h;
    },
    done: async (orgId, handoffId, note) => {
      log("browser.done", orgId, handoffId, ...(note ? [note] : []));
      return end(handoffId, "done", note ?? null);
    },
    failed: async (orgId, handoffId, note) => {
      log("browser.failed", orgId, handoffId, note);
      return end(handoffId, "failed", note ?? null);
    },
    cancel: async (orgId, handoffId) => {
      log("browser.cancel", orgId, handoffId);
      return end(handoffId, "cancelled");
    },
    takeover: async (orgId, agentId, runId) => {
      log("browser.takeover", orgId, agentId, ...(runId ? [runId] : []));
      const h: BrowserHandoff = {
        id: `takeover-${handoffs.size + 1}`,
        agentId,
        runId: runId ?? null,
        machineId: "machine-1",
        kind: "takeover",
        instructions: "",
        status: "active",
        requestedForUserId: null,
        controllerUserId: me,
        note: null,
        expiresAt: null,
        createdAt: now().toISOString(),
        resolvedAt: null,
      };
      handoffs.set(h.id, h);
      return h;
    },
    // Like the server: only the person in control, web addresses only, the agent's sites when it has a list.
    open: async (orgId, agentId, url) => {
      log("browser.open", orgId, agentId, url);
      const held = [...handoffs.values()].find((h) => h.agentId === agentId && h.status === "active");
      if (held?.controllerUserId !== me) {
        throw new ApiError(409, "browser.not_in_control", "Take control of the browser first");
      }
      let host: string;
      try {
        const u = new URL(url.includes("://") ? url : `https://${url}`);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not a web page");
        host = u.hostname;
      } catch {
        throw new ApiError(400, "browser.bad_address", "Type a web address (https://…)");
      }
      const sites = settings.get(agentId)?.allowedDomains;
      const listed = (d: string) =>
        host === d.replace(/^\*\./, "") || (d.startsWith("*.") && host.endsWith(d.slice(1)));
      if (sites && !sites.some(listed)) {
        throw new ApiError(403, "browser.not_allowed", `${host} is outside the sites this agent may use`);
      }
    },
    stop: async (orgId, agentId) => {
      log("browser.stop", orgId, agentId);
    },
  };
  return { client, settings, handoffs };
}
