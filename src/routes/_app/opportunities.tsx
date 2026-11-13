import { createFileRoute } from "@tanstack/react-router";
import { EmptyState, PageHeader } from "@/components/ui";

export const Route = createFileRoute("/_app/opportunities")({ component: Page });

function Page() {
  return (
    <>
      <PageHeader title="Opportunities" description="Discovered businesses, their evidence and their Opportunity Score." />
      <EmptyState title="No opportunities yet">Discovery runs overnight once a campaign is set up (Phase 2). Every opportunity will show its source, evidence and score breakdown.</EmptyState>
    </>
  );
}
