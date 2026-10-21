import { Logo } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { AuthHorizon } from "@/components/Sky";

/**
 * Sign in, sign up and new password: one calm question at a time in a narrow
 * column, the logo on top and the sky's horizon at the bottom.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <AuthHorizon />
      <span className="auth__logo">
        <Logo size={24} />
      </span>
      <main className="auth__col">{children}</main>
    </div>
  );
}

/** Centered card of the invitation and onboarding pages. */
export function CenteredLayout({ narrow, children }: { narrow?: boolean; children: ReactNode }) {
  return (
    <div className="center">
      <Logo size={24} />
      <main className={narrow ? "center__card center__card--narrow" : "center__card"}>{children}</main>
    </div>
  );
}
