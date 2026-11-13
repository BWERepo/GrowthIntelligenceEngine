import { createFileRoute } from "@tanstack/react-router";
import { EmptyState, PageHeader } from "@/components/ui";

export const Route = createFileRoute("/_app/follow-ups")({ component: Page });

function Page() {
  return (
    <>
      <PageHeader title="Follow-Ups" description="Who is waiting on you, and who you are waiting on." />
      <EmptyState title="No follow-ups due">Follow-ups are scheduled when you contact a prospect (Phase 3).</EmptyState>
    </>
  );
}
