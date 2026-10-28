import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Sheet } from "@/ui";

/**
 * One bottom sheet per screen, opened from anywhere inside it (a card in a
 * list row, a header button): `open(content)` / `close()`. Keeps sheets out
 * of list cells, where they would be clipped or recycled.
 */
interface SheetHost {
  /** `onClose`: called once when this sheet closes (by itself, the scrim, the grabber or `close`). */
  open: (content: ReactNode, options?: { solid?: boolean; onClose?: () => void }) => void;
  close: () => void;
}

const SheetContext = createContext<SheetHost | null>(null);

export function SheetHostProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<ReactNode>(null);
  const [solid, setSolid] = useState(false);
  const [open, setOpen] = useState(false);
  const onClosed = useRef<(() => void) | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    const then = onClosed.current;
    onClosed.current = null;
    then?.();
  }, []);
  const host = useMemo<SheetHost>(
    () => ({
      open: (next, options) => {
        setContent(next);
        setSolid(Boolean(options?.solid));
        onClosed.current = options?.onClose ?? null;
        setOpen(true);
      },
      close,
    }),
    [close],
  );
  return (
    <SheetContext.Provider value={host}>
      {children}
      <Sheet open={open} onClose={close} solid={solid}>
        <View style={styles.in}>{content}</View>
      </Sheet>
    </SheetContext.Provider>
  );
}

export function useSheet(): SheetHost {
  const host = useContext(SheetContext);
  if (!host) throw new Error("useSheet must be used inside SheetHostProvider");
  return host;
}

const styles = StyleSheet.create({
  in: { gap: 12 },
});
