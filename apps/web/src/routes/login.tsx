import { createFileRoute, redirect } from "@tanstack/react-router";
import { authConfigQuery, meQuery } from "@/api/queries";
import { safeRedirect } from "@/lib/guards";
import { LoginPage } from "@/pages/LoginPage";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string; email?: string } => ({
    redirect: safeRedirect(search.redirect),
    email: typeof search.email === "string" ? search.email : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    const [me, config] = await Promise.all([
      context.queryClient.ensureQueryData(meQuery(context.api)),
      context.queryClient.ensureQueryData(authConfigQuery(context.api)),
    ]);
    if (me) throw redirect({ to: search.redirect ?? "/" });
    // A brand-new instance has nobody to sign in: go straight to the first account.
    if (config.firstRun) throw redirect({ to: "/signup", search: { redirect: search.redirect } });
  },
  component: function Login() {
    const search = Route.useSearch();
    return <LoginPage redirect={search.redirect} email={search.email} />;
  },
});
