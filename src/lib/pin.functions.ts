import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSession } from "./auth-middleware";
import { readPinHash } from "./bwe-source.server";
import { verifyPinFor } from "./pipeline/pin.server";
import { serviceClient } from "./supabase.server";

/** The last step of sign-in: checks the 6-digit BWE back-office PIN for the signed-in password session. */
export const verifyPin = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator((d: unknown) => z.object({ pin: z.string().max(20) }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const { env, userId, sessionId } = context;
    if (!env.MESSAGE_ENCRYPTION_KEY) throw new Error("Server configuration is incomplete: MESSAGE_ENCRYPTION_KEY (missing)");
    if (!sessionId) throw new Error("Unauthorized: Please sign in again.");
    const result = await verifyPinFor(
      { db: serviceClient(env, env.GIE_DB_SCHEMA), readHash: (id) => readPinHash(env, id), key: env.MESSAGE_ENCRYPTION_KEY },
      userId,
      sessionId,
      data.pin,
    );
    if (!result.ok) throw new Error(`Invalid: ${result.reason}`);
    return { ok: true };
  });
