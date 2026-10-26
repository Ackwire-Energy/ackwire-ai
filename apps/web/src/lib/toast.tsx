import { Icon } from "@agenteschat/ui";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * Minimal toasts in the design language (neutral surface, overlay shadow,
 * icon + words). Failed writes show the server's message; confirmations are
 * rare and short.
 */
export interface Toast {
  id: number;
  tone: "error" | "info";
  text: string;
  /** A second, smaller line ("Salvo" → "Autonomia: Pergunta sempre"). */
  detail?: string;
  /** Quick actions ("Ajustar", "Desfazer"); usually one. */
  actions?: ToastAction[];
}

export interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastApi {
  show: (text: string, tone?: Toast["tone"], action?: ToastAction | ToastAction[], detail?: string) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => {} });

/** How long a toast stays; a word said in a toast's place (`useSaid`) stays as long. */
const TOAST_MS = 6000;

let nextId = 1;

/** A tiny store so non-React code (the QueryClient) can raise toasts. */
export function createToastStore() {
  let toasts: Toast[] = [];
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  return {
    show(text: string, tone: Toast["tone"] = "info", action?: ToastAction | ToastAction[], detail?: string) {
      const actions = action ? (Array.isArray(action) ? action : [action]) : [];
      const toast = {
        id: nextId++,
        tone,
        text,
        ...(detail ? { detail } : {}),
        ...(actions.length > 0 ? { actions } : {}),
      };
      // The same words replace the older one ("Salvo" after "Salvo": the newest detail and Desfazer).
      toasts = [...toasts.filter((t) => t.text !== text), toast].slice(-3);
      emit();
      setTimeout(() => {
        toasts = toasts.filter((t) => t.id !== toast.id);
        emit();
      }, TOAST_MS);
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
  const show = useCallback(
    (text: string, tone?: Toast["tone"], action?: ToastAction | ToastAction[], detail?: string) =>
      store.show(text, tone, action, detail),
    [store],
  );
  // Stable: a toast appearing must not re-render everything that can show one.
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="ac-toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`ac-toast ac-toast--${toast.tone}`}
            role={toast.tone === "error" ? "alert" : "status"}
          >
            <Icon name={toast.tone === "error" ? "alert" : "check"} />
            <span className="ac-toast__text">
              {toast.detail ? (
                <>
                  <b className="ac-toast__title">{toast.text}</b>
                  <small className="ac-toast__detail">{toast.detail}</small>
                </>
              ) : (
                toast.text
              )}
            </span>
            {toast.actions?.map((action) => (
              <button
                key={action.label}
                type="button"
                className="ac-btn ac-btn--ghost ac-btn--sm"
                onClick={() => {
                  action.run();
                  store.dismiss(toast.id);
                }}
              >
                {action.label}
              </button>
            ))}
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

/**
 * A word said in a toast's place, for as long as a toast would stay: a window that fills the page says it in a line
 * of its own, where a toast would land on its corner. `at` makes the same words said again new.
 */
export function useSaid() {
  const [said, setSaid] = useState<{ text: string; error: boolean; at: number } | null>(null);
  useEffect(() => {
    if (!said) return;
    const id = setTimeout(() => setSaid(null), TOAST_MS);
    return () => clearTimeout(id);
  }, [said]);
  const say = useCallback((text: string, error = false) => setSaid({ text, error, at: Date.now() }), []);
  const unsay = useCallback(() => setSaid(null), []);
  return { said, say, unsay };
}
