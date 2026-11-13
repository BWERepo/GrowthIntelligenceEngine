import { createFileRoute } from "@tanstack/react-router";
import { EmptyState, PageHeader } from "@/components/ui";

export const Route = createFileRoute("/_app/performance")({ component: Page });

function Page() {
  return (
    <>
      <PageHeader title="Growth Performance" description="Rolling 30-day results compared with the previous 30 days." />
      <EmptyState title="No growth data yet">Funnel, revenue and traffic trends appear here once outcomes are recorded (Phase 6). Small samples will be labelled as such.</EmptyState>
    </>
  );
}
