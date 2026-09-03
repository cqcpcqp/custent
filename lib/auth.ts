import { getEnv } from "@/lib/env";

/**
 * MVP identity boundary. Replace this function with a real authenticated
 * session without changing repositories or the agent runtime.
 */
export function getCurrentUserId(): string {
  return getEnv().DEMO_USER_ID;
}
