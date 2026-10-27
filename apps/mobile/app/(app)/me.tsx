import { MeSheet } from "@/features/me/MeSheet";
import { goBack } from "@/features/shared/parts";
import { SheetSurface } from "@/ui";

/** Você, as a native form sheet over whatever is on screen (presentation set in `_layout`). */
export default function MeRoute() {
  return (
    <SheetSurface>
      <MeSheet onClose={goBack} />
    </SheetSurface>
  );
}
