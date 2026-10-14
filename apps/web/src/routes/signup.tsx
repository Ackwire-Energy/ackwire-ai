import { createFileRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "@/api/queries";
import { safeRedirect } from "@/lib/guards";
import { SignupPage } from "@/pages/SignupPage";

export const Route = createFileRoute("/signup")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: safeRedirect(search.redirect),
  }),
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.ensureQueryData(meQuery(context.api));
    if (me) throw redirect({ to: search.redirect ?? "/" });
  },
  component: function Signup() {
    return <SignupPage redirect={Route.useSearch().redirect} />;
  },
});
