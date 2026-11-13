import { createContext, useContext } from "react";
import type { Membership } from "./roles";

export type WorkspaceContextValue = { tenant: Membership; email: string | null; isPlatformAdmin: boolean };
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside the app layout");
  return value;
}
