import { createFileRoute } from "@tanstack/react-router";
import { EmptyState, PageHeader } from "@/components/ui";

export const Route = createFileRoute("/_app/review")({ component: Page });

function Page() {
  return (
    <>
      <PageHeader title="End-of-Day Review" description="What got done today, what produced results, and what carries over." />
      <EmptyState title="No review yet">The review is prepared each business day at 5:00 PM from your recorded activity (Phase 4).</EmptyState>
    </>
  );
}
