import { createFileRoute } from "@tanstack/react-router";
import { EmptyState, PageHeader } from "@/components/ui";

export const Route = createFileRoute("/_app/prospects")({ component: Page });

function Page() {
  return (
    <>
      <PageHeader title="Prospects" description="Businesses you are working with, from first contact to customer." />
      <EmptyState title="No prospects yet">Prospects are created when you pursue an opportunity or convert a lead (Phase 3). Existing worksheet rows from BWE can be imported then.</EmptyState>
    </>
  );
}
