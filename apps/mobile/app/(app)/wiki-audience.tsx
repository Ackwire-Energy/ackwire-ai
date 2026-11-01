import { Redirect, useLocalSearchParams } from "expo-router";
import { wikiSlugOf } from "@/features/wiki/logic";
import { WikiAudienceScreen } from "@/features/wiki/WikiAudience";

/** "Quem vê" a wiki page (`?slug=`), from its ⋯ menu. */
export default function WikiAudienceRoute() {
  const page = wikiSlugOf(useLocalSearchParams<{ slug?: string }>().slug);
  if (page === null) return <Redirect href="/wiki" />;
  return <WikiAudienceScreen slug={page} />;
}
