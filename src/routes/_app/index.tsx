import { createFileRoute } from "@tanstack/react-router";
import { EmptyState, PageHeader, Panel } from "@/components/ui";
import { useWorkspace } from "@/lib/use-workspace";

export const Route = createFileRoute("/_app/")({ component: DailyActionCenter });

// Visual order is fixed by the spec: 30-day growth first and largest, today's
// actions second, the daily effectiveness score last and smallest. No numbers
// are shown until real recorded data exists.
function DailyActionCenter() {
  const { tenant } = useWorkspace();
  const today = new Intl.DateTimeFormat("en-US", { timeZone: tenant.timezone, weekday: "long", month: "long", day: "numeric" }).format(new Date());
  return (
    <>
      <PageHeader title="Daily Action Center" description={`${today}. The most valuable things to do today to win business.`} />
      <div className="space-y-5">
        <Panel kicker="Primary" title="30-Day Growth Performance" emphasis="primary">
          <EmptyState title="No growth data yet">
            Qualified leads, meetings, proposals, new customers and revenue for the last 30 days, compared with the 30 days before,
            appear here once outcomes are being recorded (Phase 6).
          </EmptyState>
        </Panel>
        <Panel kicker="Today" title="Today's priority actions">
          <EmptyState title="No actions prepared for today">
            Up to five verified opportunities and follow-ups will be prepared here each business morning at 8:00 AM ({tenant.timezone})
            once discovery and the morning package are running (Phases 2–3).
          </EmptyState>
        </Panel>
        <Panel kicker="Supporting" title="Daily Effectiveness" emphasis="supporting">
          <p className="text-espresso-soft">Score unavailable — insufficient verified activity data.</p>
        </Panel>
      </div>
    </>
  );
}
