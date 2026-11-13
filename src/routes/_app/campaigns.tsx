import { createFileRoute } from "@tanstack/react-router";
import { EmptyState, PageHeader } from "@/components/ui";

export const Route = createFileRoute("/_app/campaigns")({ component: Page });

function Page() {
  return (
    <>
      <PageHeader title="Campaigns" description="Who to look for, where, and with what budget." />
      <EmptyState title="No campaigns yet">The first campaign (East Tennessee, BWE's industries) is set up with discovery in Phase 2.</EmptyState>
    </>
  );
}
