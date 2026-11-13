import { createFileRoute } from "@tanstack/react-router";
import { EmptyState, PageHeader } from "@/components/ui";

export const Route = createFileRoute("/_app/reports")({ component: Page });

function Page() {
  return (
    <>
      <PageHeader title="Reports" description="Weekly and monthly summaries." />
      <EmptyState title="No reports yet">Weekly and monthly reviews start once there is recorded activity to report on.</EmptyState>
    </>
  );
}
