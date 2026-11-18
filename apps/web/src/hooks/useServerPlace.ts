import { instanceQuery } from "@agenteschat/client";
import { type ServerPlace, serverPlace } from "@agenteschat/client/lib/server";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/api/context";
import { inDesktopApp, thisMac } from "@/lib/desktop";

/** Where this page's workspace lives (`serverPlace`); null until the server said whether it is the Cloud. */
export function useServerPlace(): ServerPlace | null {
  const api = useApi();
  const instance = useQuery(instanceQuery(api));
  const desktop = inDesktopApp();
  // The same query as the workspace menu's: whether the app runs this server here.
  const mac = useQuery({
    queryKey: ["desktop", "thisMac"],
    queryFn: () => thisMac.status(),
    enabled: desktop,
    staleTime: 60_000,
  });
  const cloud = instance.data?.cloud;
  if (cloud === undefined) return null;
  return serverPlace(cloud, mac.data?.local === true);
}
