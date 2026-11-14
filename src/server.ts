// Worker entry: TanStack Start serves requests; the cron trigger runs the dispatcher.
import handler from "@tanstack/react-start/server-entry";
import { dispatch } from "./tasks/dispatch";

type ScheduledController = { scheduledTime: number; cron: string };
type ExecutionContext = { waitUntil(promise: Promise<unknown>): void };

export default {
  fetch: handler.fetch,
  scheduled(controller: ScheduledController, _env: unknown, ctx: ExecutionContext) {
    ctx.waitUntil(
      dispatch(new Date(controller.scheduledTime)).catch((error) => {
        console.error("[dispatch] failed", error instanceof Error ? error.message : error);
      }),
    );
  },
};
