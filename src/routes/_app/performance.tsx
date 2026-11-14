import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, Panel } from "@/components/ui";
import { GrowthDetail } from "@/components/growth";

export const Route = createFileRoute("/_app/performance")({ component: Page });

function Page() {
  return (
    <>
      <PageHeader title="Growth Performance" description="Rolling 30-day results compared with the previous 30 days." />
      <Panel kicker="Primary" title="30-Day Growth Performance" emphasis="primary">
        <GrowthDetail />
      </Panel>
    </>
  );
}
