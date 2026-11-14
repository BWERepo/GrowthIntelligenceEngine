// Agency readiness rules that need no database: send limits, new workspace input.
import { z } from "zod";

/** The app-wide cap always applies; a workspace can only be set lower. */
export function effectiveSendCap(appCap: number, quotaCap: number | null | undefined): number {
  return quotaCap === null || quotaCap === undefined ? appCap : Math.max(0, Math.min(appCap, quotaCap));
}

export const WorkspaceInput = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "Use 2 to 40 lowercase letters, digits or dashes."),
  timezone: z.string().trim().min(3).max(60),
  ownerEmail: z.string().trim().toLowerCase().email().max(254),
  monthlyBudgetUsd: z.number().min(1).max(500).default(20),
});
export type WorkspaceInput = z.infer<typeof WorkspaceInput>;

export const QuotaInput = z.object({
  maxActiveCampaigns: z.number().int().min(0).max(100),
  maxMembers: z.number().int().min(1).max(200),
  dailySendCap: z.number().int().min(0).max(200).nullable(),
});
export type QuotaInput = z.infer<typeof QuotaInput>;

/** Slugs that would be confusing or collide with routes and the owner's own workspace. */
export const RESERVED_SLUGS = ["bwe", "admin", "api", "app", "sign-in", "workspaces", "settings"];
