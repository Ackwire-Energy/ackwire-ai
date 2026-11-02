import { useApi } from "@agenteschat/client";
import { type Href, router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { resolveLink } from "@/features/links/app-links";
import { takeLink } from "@/features/links/pending";
import { useColors } from "@/features/shared/hooks";
import { isSafeId } from "@/features/shared/logic";
import { useOrg } from "@/providers/org";

/**
 * A link to the website opened in the app (`app/+native-intent.tsx`): switches to the link's workspace when the
 * person is in it, then opens the screen it names (`resolveLink`), in place of this one.
 */
export default function LinkRoute() {
  const p = useLocalSearchParams<{
    org?: string;
    to?: string;
    thread?: string;
    agent?: string;
    person?: string;
    notification?: string;
    m?: string;
  }>();
  const { orgId, orgs, setOrgId } = useOrg();
  const api = useApi();
  const c = useColors();
  const wanted = isSafeId(p.org) && orgs.some((o) => o.id === p.org) ? p.org : orgId;
  const { to, thread, agent, person, notification, m } = p;
  useEffect(() => {
    takeLink();
    if (wanted !== orgId) {
      setOrgId(wanted);
      return;
    }
    let alive = true;
    resolveLink(api, orgId, { to, thread, agent, person, notification, m })
      .catch(() => "/")
      .then((href) => {
        if (alive) router.replace(href as Href);
      });
    return () => {
      alive = false;
    };
  }, [api, orgId, wanted, setOrgId, to, thread, agent, person, notification, m]);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bg }}>
      <ActivityIndicator color={c.muted} />
    </View>
  );
}
