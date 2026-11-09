import type { ComputerDeviceInput, DeviceAudience, PhoneDeviceInput } from "@agenteschat/client";
import { keys, useApi } from "@agenteschat/client";
import { LINK_POLL_MS, linkPhase, linkPolls } from "@agenteschat/client/lib/devices";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * The devices list (`GET /devices`) and what changes it. `devices.changed` refetches it (its key sits under
 * `machines`, which every computer event refreshes); `pollMs` also asks on a timer, while a dialog waits for a
 * phone or a computer to show up.
 */
export const useDevices = (orgId: string, pollMs: number | false = false) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.devices(orgId),
    queryFn: () => api.devices.list(orgId),
    retry: false,
    refetchInterval: pollMs,
    meta: { quiet: true },
  });
};

function useDevicesMutation<I, O>(orgId: string, run: (input: I) => Promise<O>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    meta: { silent: true },
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.machines(orgId) }),
  });
}

export function useUpdateComputer(orgId: string) {
  const api = useApi();
  return useDevicesMutation(orgId, ({ id, ...input }: ComputerDeviceInput & { id: string }) =>
    api.devices.updateComputer(orgId, id, input),
  );
}

export function useUpdatePhone(orgId: string) {
  const api = useApi();
  return useDevicesMutation(orgId, ({ id, ...input }: PhoneDeviceInput & { id: string }) =>
    api.devices.updatePhone(orgId, id, input),
  );
}

export function useRemoveComputer(orgId: string) {
  const api = useApi();
  return useDevicesMutation(orgId, (id: string) => api.devices.removeComputer(orgId, id));
}

export function useForgetPhone(orgId: string) {
  const api = useApi();
  return useDevicesMutation(orgId, (id: string) => api.devices.forgetPhone(orgId, id));
}

export function useStopPhone(orgId: string) {
  const api = useApi();
  return useDevicesMutation(orgId, (id: string) => api.devices.stopPhone(orgId, id));
}

export function useApproveRequest(orgId: string) {
  const api = useApi();
  return useDevicesMutation(orgId, ({ id, ...input }: { id: string; name?: string; audience?: DeviceAudience }) =>
    api.devices.approveRequest(orgId, id, input),
  );
}

export function useDenyRequest(orgId: string) {
  const api = useApi();
  return useDevicesMutation(orgId, (id: string) => api.devices.denyRequest(orgId, id));
}

export function useDecideAccess(orgId: string) {
  const api = useApi();
  return useDevicesMutation(orgId, ({ id, decision }: { id: string; decision: "once" | "always" | "no" }) =>
    api.devices.decideAccess(orgId, id, decision),
  );
}

export function useDeviceWait(orgId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: ({ runId, action }: { runId: string; action: "retry" | "stop" }) =>
      api.devices.deviceWait(orgId, runId, action),
    meta: { silent: true },
  });
}

/**
 * A one-line install link, made fresh for each dialog that shows one (never served from the cache). Its key sits
 * outside the workspace's keys: an event or a reconnect refetches those, and a refetch here would make a new line under
 * the person.
 */
export function useConnectLink(orgId: string, kind: "server" | "computer", enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ["device-link", orgId, kind],
    queryFn: () => api.devices.createLink(orgId, kind),
    enabled,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** Where a link stands: asked every 2 s while a computer may still run it or ask to join (and on every devices event). */
export function useLinkState(orgId: string, link: { id: string; expiresAt: string } | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.connectLink(orgId, link?.id ?? ""),
    queryFn: () => api.devices.link(orgId, link?.id ?? ""),
    enabled: Boolean(link),
    retry: false,
    refetchInterval: (q) => (link && linkPolls(linkPhase(q.state.data, link.expiresAt)) ? LINK_POLL_MS : false),
    meta: { quiet: true },
  });
}
