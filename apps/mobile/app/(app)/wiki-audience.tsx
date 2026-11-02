import { Redirect, useLocalSearchParams } from "expo-router";
import { wikiSlugOf } from "@/features/wiki/logic";
import { WikiAudienceScreen } from "@/features/wiki/WikiAudience";

/** "Quem vê" a wiki page (`?slug=`, from its ⋯ menu) or a folder (`?folder=`, from the folder's screen). */
export default function WikiAudienceRoute() {
  const params = useLocalSearchParams<{ slug?: string; folder?: string }>();
  if (typeof params.folder === "string" && params.folder) return <WikiAudienceScreen folder={params.folder} />;
  const page = wikiSlugOf(params.slug);
  if (page === null) return <Redirect href="/wiki" />;
  return <WikiAudienceScreen slug={page} />;
}
