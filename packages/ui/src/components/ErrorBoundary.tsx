import { Component, type ReactNode } from "react";

/**
 * Keeps a render error inside what it wraps: `fallback` takes its place and the rest of the page keeps working.
 * It stays in place until remounted. React hands each error a boundary catches to the root's `onCaughtError` once
 * (console.error by default, the app's error reports when set), so this one logs nothing itself.
 */
export class ErrorBoundary extends Component<{ fallback: ReactNode; children?: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
