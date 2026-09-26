import { z } from "zod";
import type { UserRow } from "@/server/db/schema";
import { config, isDemo, uuid } from "@/server/config";
import { AppError, invariant } from "@/server/errors";
import { jsonBody } from "@/server/http";
import { world, WORLD_ACTION_TRIP } from "@/server/world/adapter";
import { createTripProofRequest } from "@/server/world/requests";
import { simulatedIdentity } from "@/server/world/simulated";
import { parentName } from "@/server/ens-v2/addresses";
import * as approvals from "@/server/world/approvals";
import * as trips from "./trips";
import * as gatherings from "./gatherings";
import * as split from "./split";
import * as agent from "./concierge/agent";
import "./handlers";

export interface RouteContext {
  path: string;
  method: string;
  request: Request;
  url: URL;
  actor: UserRow | null;
  correlationId: string;
  ok: (data: unknown, status?: number, extra?: Record<string, string>) => Response;
}
/** Routes reachable without a session: the OIDC redirect and the public name lookup. */
export function isPublicPath(path: string, method: string) {
  if (method !== "GET") return false;
  if (path === "world/agent/callback") return true;
  return /^trips\/[^/]+$/.test(path) && path !== "trips/me" && path.slice(6).includes(".");
}
const simulateSchema = z
  .object({
    approvalId: uuid,
    decision: z.enum(["approve", "deny"]),
    human: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
/** The simulated World ID identity for a demo account: stable per account so link and step-ups match. */
export const simulatedHumanFor = (user: UserRow) => "user-" + user.id.slice(-6);

export async function handle(ctx: RouteContext): Promise<Response | null> {
  const { path, method, request, url, ok } = ctx;
  const auth = () => {
    invariant(ctx.actor, "UNAUTHENTICATED", "Sign in to continue.", 401);
    return ctx.actor;
  };
  if (path === "world/rp-context" && method === "POST") {
    const user = auth();
    const body = trips.activateSchema
      .omit({ proof: true, requestId: true })
      .parse(await jsonBody(request));
    // Already proven human: World ID 4.0 will not issue a second proof, so none is needed.
    if (world().kind === "live" && (await trips.priorHumanProof(user.id)))
      return ok({ verified: true });
    return ok(await createTripProofRequest(user, body));
  }
  if (path === "world/verify" && method === "POST") {
    const user = auth();
    return ok(
      await trips.activateTrip(user, trips.activateSchema.parse(await jsonBody(request))),
      201,
    );
  }
  if (path === "world/agent/link" && method === "POST") {
    const user = auth();
    return ok(
      await approvals.requestApproval(user, {
        action: "agent.link",
        payload: {},
        summary: "Let the concierge act for you",
      }),
      201,
    );
  }
  if (path === "world/agent/callback" && method === "GET") {
    invariant(isDemo(), "NOT_FOUND", "OIDC callbacks are not used for production approvals.", 404);
    const state = url.searchParams.get("state");
    invariant(state && uuid.safeParse(state).success, "VALIDATION", "Missing state.", 422);
    let error = "";
    try {
      await approvals.finishApproval({
        approvalId: state,
        code: url.searchParams.get("code") ?? undefined,
        error: url.searchParams.get("error") ?? undefined,
      });
    } catch (caught) {
      error = caught instanceof AppError ? caught.code : "INTERNAL";
    }
    await trips.tickEnsWorld();
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/approvals/" + state + (error ? "?error=" + encodeURIComponent(error) : ""),
        "Cache-Control": "no-store",
        "X-Correlation-ID": ctx.correlationId,
      },
    });
  }
  if (path === "world/agent/verify" && method === "POST") {
    const user = auth();
    const body = z
      .object({ approvalId: uuid, proof: z.unknown() })
      .strict()
      .parse(await jsonBody(request));
    return ok(
      await approvals.finishApproval({
        approvalId: body.approvalId,
        userId: user.id,
        proof: body.proof,
      }),
    );
  }
  if (path === "world/agent/deny" && method === "POST") {
    const user = auth();
    const body = z
      .object({ approvalId: uuid })
      .strict()
      .parse(await jsonBody(request));
    return ok(
      await approvals.finishApproval({
        approvalId: body.approvalId,
        userId: user.id,
        error: "access_denied",
      }),
    );
  }
  if (path === "world/agent/simulate" && method === "POST") {
    invariant(isDemo(), "NOT_FOUND", "Not found.", 404);
    const user = auth();
    const body = simulateSchema.parse(await jsonBody(request));
    const row = await approvals.loadApproval(body.approvalId, user.id);
    if (body.decision === "deny")
      return ok(await approvals.finishApproval({ approvalId: row.id, error: "access_denied" }));
    const finished = await approvals.finishApproval({
      approvalId: row.id,
      identity: simulatedIdentity(body.human ?? simulatedHumanFor(user), row.nonce),
    });
    // Executors enqueue chain writes; demo mode has no worker, so run them before answering.
    await trips.tickEnsWorld();
    return ok(finished);
  }
  if (path === "trips/me" && method === "GET") {
    const user = auth();
    return ok({ trip: await trips.myTrip(user, url.searchParams.get("city") ?? "tokyo") });
  }
  if (path === "trips/extend" && method === "POST") {
    const user = auth();
    return ok(await trips.extendTrip(user, trips.extendSchema.parse(await jsonBody(request))));
  }
  if (path === "trips/end" && method === "POST") {
    const user = auth();
    return ok(await trips.endTrip(user, trips.citySchema.parse(await jsonBody(request)).city));
  }
  if (path === "trips/pay-record" && method === "POST") {
    const user = auth();
    return ok(await trips.setPayRecord(user, trips.payRecordSchema.parse(await jsonBody(request))));
  }
  if (isPublicPath(path, method) && path.startsWith("trips/"))
    return ok(await trips.tripByName(decodeURIComponent(path.slice(6))));
  if (path === "gatherings" && method === "GET") {
    const user = auth();
    return ok({
      items: await gatherings.listGatherings(user, url.searchParams.get("city") ?? "tokyo"),
    });
  }
  if (path === "gatherings" && method === "POST") {
    const user = auth();
    return ok(
      await gatherings.createGathering(
        user,
        gatherings.createGatheringSchema.parse(await jsonBody(request)),
      ),
      201,
    );
  }
  const table = path.match(/^gatherings\/([^/]+)(?:\/([a-z/]+))?$/);
  if (table) {
    const user = auth(),
      id = uuid.parse(table[1]),
      sub = table[2] ?? "";
    if (!sub && method === "GET") return ok(await gatherings.gatheringDetail(user, id));
    if (method === "POST") {
      const body = () => jsonBody(request);
      if (sub === "request")
        return ok(
          await gatherings.requestSeat(user, id, gatherings.seatRequestSchema.parse(await body())),
          201,
        );
      if (sub === "approve")
        return ok(
          await gatherings.approveSeat(user, id, gatherings.attendeeSchema.parse(await body())),
          201,
        );
      if (sub === "decline")
        return ok(
          await gatherings.declineSeat(user, id, gatherings.attendeeSchema.parse(await body())),
        );
      if (sub === "leave") return ok(await gatherings.leaveGathering(user, id));
      if (sub === "cancel") return ok(await gatherings.cancelGathering(user, id));
      if (sub === "close") return ok(await gatherings.closeGathering(user, id));
      if (sub === "split")
        return ok(await split.startSplit(user, id, split.splitSchema.parse(await body())));
      if (sub === "split/prepare")
        return ok(
          await split.preparePayment(user, id, split.preparePaymentSchema.parse(await body())),
        );
      if (sub === "split/paid")
        return ok(await split.reportPayment(user, id, split.paidSchema.parse(await body())));
      if (sub === "split/simulate") return ok(await split.simulatePayment(user, id));
    }
  }
  if (path === "concierge/chat" && method === "POST") {
    const user = auth();
    return ok(await agent.turn(user, agent.chatSchema.parse(await jsonBody(request))));
  }
  if (path === "concierge/now" && method === "POST") {
    const user = auth();
    return ok(await agent.publishNow(user, agent.nowSchema.parse(await jsonBody(request))), 201);
  }
  const approval = path.match(/^approvals\/([^/]+)$/);
  if (approval && method === "GET") {
    const user = auth();
    return ok(await approvals.approvalStatus(user, uuid.parse(approval[1])));
  }
  return null;
}
/** Safe runtime flags for the browser: never a secret, never a key. */
export function publicConfig() {
  const simulated = isDemo();
  const worldEnabled = !!(
    process.env.WORLD_APP_ID &&
    process.env.WORLD_RP_ID &&
    process.env.WORLD_RP_SIGNING_KEY
  );
  return {
    world: {
      enabled: simulated || worldEnabled,
      appId: simulated ? "app_simulated" : (process.env.WORLD_APP_ID ?? null),
      rpId: simulated ? "rp_simulated" : (process.env.WORLD_RP_ID ?? null),
      environment: simulated ? "simulated" : (process.env.WORLD_ENVIRONMENT ?? "production"),
      action: WORLD_ACTION_TRIP,
      agentsEnabled: simulated || worldEnabled,
      simulated,
    },
    ensParent: (() => {
      try {
        return parentName();
      } catch {
        return null;
      }
    })(),
    origin: config().origin,
  };
}
