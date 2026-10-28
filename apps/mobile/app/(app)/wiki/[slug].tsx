import { Redirect, useLocalSearchParams } from "expo-router";
import { WikiPageScreen, wikiSlugOf } from "@/features/wiki/WikiScreen";

/** One page of the wiki (`/wiki/<slug>`): from the wiki's home or a link on another page. */
export default function WikiPageRoute() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const page = wikiSlugOf(slug);
  if (page === null) return <Redirect href="/wiki" />;
  return <WikiPageScreen key={page} slug={page} />;
}
