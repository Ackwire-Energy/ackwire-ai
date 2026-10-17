import { MeSheet } from "@/features/me/MeSheet";
import { useClosingSheet } from "@/features/shared/parts";

/** Você, as a sheet over whatever is on screen. */
export default function MeRoute() {
  const sheet = useClosingSheet();
  return <MeSheet open={sheet.open} onClose={sheet.close} />;
}
