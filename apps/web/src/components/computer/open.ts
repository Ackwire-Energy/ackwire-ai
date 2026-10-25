import { createContext, useContext } from "react";

/** Opens an agent's computer in the workspace's one dialog (`ComputerDialogProvider`). */
export const OpenComputerContext = createContext<((agentId: string) => void) | null>(null);

const noop = () => {};

/** Opens an agent's computer in place; does nothing outside a workspace's pages. */
export const useOpenComputer = (): ((agentId: string) => void) => useContext(OpenComputerContext) ?? noop;
