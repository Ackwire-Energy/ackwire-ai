import { MeScreen } from "@/features/me/MeScreen";
import { goBack } from "@/features/shared/parts";

/** Você, a page pushed from the avatar (its own back button and bar; presentation set in `_layout`). */
export default function MeRoute() {
  return <MeScreen onClose={goBack} />;
}
