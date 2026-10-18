import { Icon, type IconName } from "@agenteschat/ui";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

type Show = (message: string, icon?: IconName) => void;
const ToastContext = createContext<Show>(() => {});

/** One short confirmation at a time at the bottom of the window ("Pasta removida"). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; icon: IconName; key: number } | null>(null);
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback<Show>((message, icon = "check") => {
    setToast({ message, icon, key: Date.now() });
    setOn(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), 2600);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <ToastContext.Provider value={show}>
      {children}
      <output className="dk-toast" data-on={on || undefined} aria-live="polite">
        {toast && (
          <>
            <Icon name={toast.icon} size={14} />
            {toast.message}
          </>
        )}
      </output>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
