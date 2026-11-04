import { useApi } from "@agenteschat/client";
import { type Href, router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { openOwnPage } from "@/features/ai/parts";
import { linkWorkspace, resolveLink, searchHref } from "@/features/links/app-links";
import { takeLink } from "@/features/links/pending";
import { useColors } from "@/features/shared/hooks";
import { SEARCH_IN_BAR } from "@/features/shared/tabHeader";
import { serverUrl } from "@/lib/server";
import { useOrg } from "@/providers/org";

/**
 * A link to the website opened in the app (`app/+native-intent.tsx`): switches to the link's workspace when the
 * person is in it, then opens the screen it names (`resolveLink`), in place of this one. A workspace they aren't in
 * opens the address on the website instead.
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
    web?: string;
  }>();
  const { orgId, orgs, setOrgId } = useOrg();
  const api = useApi();
  const c = useColors();
  const place = linkWorkspace(
    p,
    orgs.map((o) => o.id),
    orgId,
  );
  const wanted = "org" in place ? place.org : orgId;
  const foreign = "web" in place ? place.web : null;
  const { to, thread, agent, person, notification, m } = p;
  useEffect(() => {
    takeLink();
    if (foreign !== null) {
      if (foreign !== "/") openOwnPage(`${serverUrl()}${foreign}`);
      router.replace("/");
      return;
    }
    if (wanted !== orgId) {
      setOrgId(wanted);
      return;
    }
    let alive = true;
    resolveLink(api, orgId, { to, thread, agent, person, notification, m })
      .catch(() => "/")
      .then((href) => {
        // Search opens at `/find` where it isn't a tab (`searchHref`).
        if (alive) router.replace(searchHref(href, SEARCH_IN_BAR) as Href);
      });
    return () => {
      alive = false;
    };
  }, [api, orgId, wanted, foreign, setOrgId, to, thread, agent, person, notification, m]);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bg }}>
      <ActivityIndicator color={c.muted} />
    </View>
  );
}
