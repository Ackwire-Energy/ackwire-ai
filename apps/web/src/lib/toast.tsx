import { Icon } from "@agenteschat/ui";
import { createContext, type ReactNode, useCallback, useContext, useSyncExternalStore } from "react";

/**
 * Minimal toasts in the design language (neutral surface, overlay shadow,
 * icon + words). Failed writes show the server's message; confirmations are
 * rare and short.
 */
export interface Toast {
  id: number;
  tone: "error" | "info";
  text: string;
}

interface ToastApi {
  show: (text: string, tone?: Toast["tone"]) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => {} });

let nextId = 1;

/** A tiny store so non-React code (the QueryClient) can raise toasts. */
export function createToastStore() {
  let toasts: Toast[] = [];
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  return {
    show(text: string, tone: Toast["tone"] = "info") {
      const toast = { id: nextId++, tone, text };
      toasts = [...toasts.filter((t) => t.text !== text), toast].slice(-3);
      emit();
      setTimeout(() => {
        toasts = toasts.filter((t) => t.id !== toast.id);
        emit();
      }, 6000);
    },
    dismiss(id: number) {
      toasts = toasts.filter((t) => t.id !== id);
      emit();
    },
    get: () => toasts,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type ToastStore = ReturnType<typeof createToastStore>;

export function ToastProvider({
  store,
  closeLabel,
  children,
}: {
  store: ToastStore;
  closeLabel: string;
  children: ReactNode;
}) {
  const toasts = useSyncExternalStore(store.subscribe, store.get, store.get);
  const show = useCallback((text: string, tone?: Toast["tone"]) => store.show(text, tone), [store]);
  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="ac-toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`ac-toast ac-toast--${toast.tone}`}
            role={toast.tone === "error" ? "alert" : "status"}
          >
            <Icon name={toast.tone === "error" ? "alert" : "check"} />
            <span className="ac-toast__text">{toast.text}</span>
            <button
              type="button"
              className="ac-btn ac-btn--ghost ac-btn--sm ac-btn--icon"
              aria-label={closeLabel}
              onClick={() => store.dismiss(toast.id)}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
