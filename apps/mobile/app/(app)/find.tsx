import { SearchScreen } from "@/features/search/SearchScreen";

/** Search, pushed from a tab's bar where the tab bar has no room for it (`barTabs`: Android, iOS before 26). */
export default function FindRoute() {
  return <SearchScreen />;
}
