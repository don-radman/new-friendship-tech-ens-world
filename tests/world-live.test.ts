import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { hashSignal } from "@worldcoin/idkit/hashing";
import { getDb, closeDb, type Database } from "@/server/db";
import { DEMO_IDS, seedDemo } from "@/server/db/seed";
import * as s from "@/server/db/schema";
import * as adapter from "@/server/world/adapter";
import { LiveWorld } from "@/server/world/live";
import {
  finishApproval,
  loadApproval,
  registerApprovalExecutor,
  requestApproval,
} from "@/server/world/approvals";
import {
  createTripProofRequest,
  tripProofRequest,
  consumeTripProofRequest,
} from "@/server/world/requests";
import { api, bootSessions } from "./helpers";
import { resetSimulatedChain } from "@/server/ens-v2/chain";
import { activeTripFor, expireTrips } from "@/server/ens-world/trips";

let db: Database;
const live = new LiveWorld();
const proof = (action: string, signal: string, nonce = "request-nonce", nullifier = "0x01") => ({
  protocol_version: "4.0",
  action,
  nonce,
  environment: "production",
  user_presence_completed: true,
  responses: [
    {
      identifier: "proof_of_human",
      issuer_schema_id: 1,
      nullifier,
      signal_hash: hashSignal(signal),
      expires_at_min: Math.floor(Date.now() / 1000) + 3600,
      proof: ["0x01"],
    },
  ],
});
/** World ID session proof (concierge link and approvals): no action, a stable session_id. */
const sessionProof = (signal: string, nonce: string, sessionId = "session_ab01") => ({
  protocol_version: "4.0",
  nonce,
  session_id: sessionId,
  environment: "production",
  user_presence_completed: true,
  responses: [
    {
      identifier: "proof_of_human",
      issuer_schema_id: 1,
      session_nullifier: ["0x05", "0x06"],
      signal_hash: hashSignal(signal),
      expires_at_min: Math.floor(Date.now() / 1000) + 3600,
      proof: ["0x01"],
    },
  ],
});
const verified = (payload: {
  action?: string;
  session_id?: string;
  responses: { nullifier?: string }[];
}) =>
  payload.session_id
    ? {
        success: true,
        environment: "production",
        session_id: payload.session_id,
        results: [{ identifier: "proof_of_human", success: true }],
      }
    : {
        success: true,
        environment: "production",
        action: payload.action,
        results: [
          {
            identifier: "proof_of_human",
            success: true,
            nullifier: payload.responses[0].nullifier,
          },
        ],
      };
function mockVerifier(effect?: () => Promise<void>) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    await effect?.();
    return Response.json(verified(payload));
  });
}
beforeAll(async () => {
  db = await getDb();
  await bootSessions();
}, 30000);
beforeEach(async () => {
  await db.execute(sql.raw("TRUNCATE users, cities, audit_log, rate_limits CASCADE"));
  await seedDemo(db);
  resetSimulatedChain();
  vi.stubEnv("WORLD_APP_ID", "app_test");
  vi.stubEnv("WORLD_RP_ID", "rp_test");
  vi.stubEnv("WORLD_RP_SIGNING_KEY", "11".repeat(32));
  vi.stubEnv("WORLD_ENVIRONMENT", "production");
  vi.stubEnv("WORLD_VERIFY_BASE", "https://developer.world.org");
  vi.stubGlobal("fetch", mockVerifier());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(closeDb);

async function user(id = DEMO_IDS.maya) {
  return (await db.select().from(s.users).where(eq(s.users.id, id)))[0];
}
function enableLive() {
  vi.spyOn(adapter, "world").mockReturnValue(live);
}
function approvalProof(
  row: Awaited<ReturnType<typeof requestApproval>>,
  sessionId = "session_ab01",
) {
  const r = row.proofRequest!;
  return sessionProof(r.signal, r.nonce, sessionId);
}
async function link() {
  enableLive();
  const pending = await requestApproval(await user(), {
    action: "agent.link",
    payload: {},
    summary: "Link World ID",
  });
  await finishApproval({
    approvalId: pending.id,
    userId: DEMO_IDS.maya,
    proof: approvalProof(pending),
  });
  return user();
}

describe("production World proof verification", () => {
  it("verifies the exact v4 human response and preserves the full payload", async () => {
    const payload = proof("trip-activate", "account-bound-signal");
    const result = await live.verifyProof({
      payload,
      action: payload.action,
      signal: "account-bound-signal",
      nonce: payload.nonce,
    });
    expect(result.nullifier).toBe("1");
    expect(result.environment).toBe("production");
    expect(fetch).toHaveBeenCalledWith(
      "https://developer.world.org/api/v4/verify/rp_test",
      expect.objectContaining({ body: JSON.stringify(payload), redirect: "error" }),
    );
  });
  it.each([
    "action",
    "nonce",
    "environment",
    "signal",
    "zero signal",
    "no signal",
    "legacy",
    "credential",
    "expired",
    "presence",
  ])("rejects incorrect %s before contacting the verifier", async (mutation) => {
    const payload = proof("trip-activate", "signal");
    if (mutation === "action") payload.action = "another";
    if (mutation === "nonce") payload.nonce = "another";
    if (mutation === "environment") payload.environment = "staging";
    if (mutation === "signal") payload.responses[0].signal_hash = hashSignal("another");
    if (mutation === "zero signal") payload.responses[0].signal_hash = "0x0";
    if (mutation === "no signal")
      delete (payload.responses[0] as Partial<(typeof payload.responses)[0]>).signal_hash;
    if (mutation === "legacy") payload.protocol_version = "3.0";
    if (mutation === "credential") payload.responses[0].issuer_schema_id = 11;
    if (mutation === "expired") payload.responses[0].expires_at_min = 1;
    if (mutation === "presence") payload.user_presence_completed = false;
    await expect(
      live.verifyProof({
        payload,
        action: "trip-activate",
        signal: "signal",
        nonce: "request-nonce",
        requireUserPresence: true,
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["failed human", "different result", "nullifier", "environment", "action"])(
    "rejects HTTP 200 with %s",
    async (mutation) => {
      const payload = proof("trip-activate", "signal"),
        result = verified(payload) as {
          environment: string;
          action?: string;
          results: { identifier: string; success: boolean; nullifier?: string }[];
        };
      if (mutation === "failed human") result.results[0].success = false;
      if (mutation === "different result") result.results[0].identifier = "selfie";
      if (mutation === "nullifier") result.results[0].nullifier = "0x02";
      if (mutation === "environment") result.environment = "staging";
      if (mutation === "action") result.action = "another";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(result)),
      );
      await expect(
        live.verifyProof({
          payload,
          action: payload.action,
          signal: "signal",
          nonce: payload.nonce,
        }),
      ).rejects.toHaveProperty("code", "WORLD_VERIFY_FAILED");
    },
  );
  it("rejects sandbox in production and untrusted verifier endpoints", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WORLD_ENVIRONMENT", "sandbox");
    await expect(live.rpContext("x")).rejects.toHaveProperty("code", "WORLD_UNAVAILABLE");
    vi.stubEnv("WORLD_ENVIRONMENT", "production");
    vi.stubEnv("WORLD_VERIFY_BASE", "https://example.com");
    await expect(live.rpContext("x")).rejects.toHaveProperty("code", "WORLD_UNAVAILABLE");
  });
});

describe("durable World trip request", () => {
  const trip = {
    city: "tokyo",
    label: "maya",
    arrivesAt: "2026-09-26T00:00:00Z",
    departsAt: "2026-09-28T00:00:00Z",
  };
  it("binds account and exact trip, consumes atomically and rejects replay", async () => {
    enableLive();
    const request = await createTripProofRequest(await user(), trip);
    expect(request.signal).not.toBe(trip.city);
    await expect(tripProofRequest(DEMO_IDS.kenji, request.requestId, trip)).rejects.toHaveProperty(
      "code",
      "WORLD_REQUEST_INVALID",
    );
    await expect(
      tripProofRequest(DEMO_IDS.maya, request.requestId, { ...trip, label: "other" }),
    ).rejects.toThrow();
    expect((await tripProofRequest(DEMO_IDS.maya, request.requestId, trip)).rpContext.nonce).toBe(
      request.nonce,
    );
    await db.transaction((tx) => consumeTripProofRequest(tx, request.requestId, DEMO_IDS.maya));
    await expect(
      db.transaction((tx) => consumeTripProofRequest(tx, request.requestId, DEMO_IDS.maya)),
    ).rejects.toHaveProperty("code", "WORLD_REQUEST_INVALID");
  });
  it("serves signed requests through the API and accepts a matching proof only once", async () => {
    enableLive();
    const body = {
      ...trip,
      arrivesAt: new Date().toISOString(),
      departsAt: new Date(Date.now() + 86400000).toISOString(),
    };
    const created = await api("world/rp-context", "maya", "POST", body);
    expect(created.status).toBe(200);
    const r = created.body as adapter.ProofRequestDTO;
    const input = { ...body, requestId: r.requestId, proof: proof(r.action, r.signal, r.nonce) };
    expect((await api("world/verify", "kenji", "POST", input)).status).toBe(422);
    expect(
      (await api("world/verify", "maya", "POST", { ...input, label: "different" })).status,
    ).toBe(422);
    const activated = await api("world/verify", "maya", "POST", input);
    expect(activated.status).toBe(201);
    expect(activated.body.status).toBe("active");
    expect((await api("world/verify", "maya", "POST", input)).body.error.code).toBe("TRIP_EXISTS");
    expect(
      await db.select().from(s.humanProofs).where(eq(s.humanProofs.userId, DEMO_IDS.maya)),
    ).toHaveLength(1);
  });
  it("rejects an expired API challenge before creating a human proof or trip", async () => {
    enableLive();
    const body = {
      ...trip,
      arrivesAt: new Date().toISOString(),
      departsAt: new Date(Date.now() + 86400000).toISOString(),
    };
    const created = await api("world/rp-context", "maya", "POST", body);
    const r = created.body as adapter.ProofRequestDTO;
    await db
      .update(s.worldProofRequests)
      .set({ expiresAt: new Date(1) })
      .where(eq(s.worldProofRequests.id, r.requestId));
    const result = await api("world/verify", "maya", "POST", {
      ...body,
      requestId: r.requestId,
      proof: proof(r.action, r.signal, r.nonce),
    });
    expect(result.body.error.code).toBe("WORLD_REQUEST_INVALID");
    expect(await db.select().from(s.humanProofs)).toHaveLength(0);
    expect(await db.select().from(s.trips)).toHaveLength(0);
  });
  it("proves a live account human once and reuses it for every later trip", async () => {
    enableLive();
    const body = {
      ...trip,
      arrivesAt: new Date().toISOString(),
      departsAt: new Date(Date.now() + 86400000).toISOString(),
    };
    const r = (await api("world/rp-context", "maya", "POST", body)).body as adapter.ProofRequestDTO;
    const first = await api("world/verify", "maya", "POST", {
      ...body,
      requestId: r.requestId,
      proof: proof(r.action, r.signal, r.nonce),
    });
    expect(first.status).toBe(201);
    await db
      .update(s.trips)
      .set({ arrivesAt: new Date(Date.now() - 7200000), departsAt: new Date(Date.now() - 3600000) })
      .where(eq(s.trips.id, first.body.id));
    // World ID 4.0 will not issue this human a second trip-activate proof, so none is asked for.
    expect((await api("world/rp-context", "maya", "POST", body)).body).toEqual({ verified: true });
    const again = await api("world/verify", "maya", "POST", body);
    expect(again.status).toBe(201);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      await db.select().from(s.humanProofs).where(eq(s.humanProofs.userId, DEMO_IDS.maya)),
    ).toHaveLength(1);
  });
  it("refuses a World ID proof already bound to another account", async () => {
    enableLive();
    const body = {
      ...trip,
      arrivesAt: new Date().toISOString(),
      departsAt: new Date(Date.now() + 86400000).toISOString(),
    };
    for (const [account, label, code] of [
      ["maya", "maya", 201],
      ["kenji", "kenji", 409],
    ] as const) {
      const r = (await api("world/rp-context", account, "POST", { ...body, label }))
        .body as adapter.ProofRequestDTO;
      const result = await api("world/verify", account, "POST", {
        ...body,
        label,
        requestId: r.requestId,
        proof: proof(r.action, r.signal, r.nonce),
      });
      expect(result.status).toBe(code);
    }
  });
  it("revokes stale trips immediately and lets a returning traveler start again", async () => {
    const body = {
      ...trip,
      arrivesAt: new Date().toISOString(),
      departsAt: new Date(Date.now() + 86400000).toISOString(),
      proof: { simulated: true, human: "maya" },
    };
    const first = await api("world/verify", "maya", "POST", body);
    expect(first.status).toBe(201);
    await db
      .update(s.trips)
      .set({ arrivesAt: new Date(Date.now() - 7200000), departsAt: new Date(Date.now() - 3600000) })
      .where(eq(s.trips.id, first.body.id));
    expect(await activeTripFor(DEMO_IDS.maya, "tokyo")).toBeNull();
    const next = await api("world/verify", "maya", "POST", body);
    expect(next.status).toBe(201);
    expect((await db.select().from(s.trips).where(eq(s.trips.id, first.body.id)))[0].status).toBe(
      "expired",
    );
    await db
      .update(s.trips)
      .set({
        status: "pending_chain",
        arrivesAt: new Date(Date.now() - 7200000),
        departsAt: new Date(Date.now() - 3600000),
      })
      .where(eq(s.trips.id, next.body.id));
    expect(await expireTrips()).toBe(1);
  });
});

describe("production IDKit concierge approvals", () => {
  it("links and approves with an account-bound proof, exactly once, with no OIDC configuration", async () => {
    const actor = await link();
    expect(actor.worldAgentSub).toBe("session_ab01");
    expect(actor.worldAgentIssuer).toBe("world-id:rp_test:production");
    let calls = 0;
    registerApprovalExecutor("now.publish", async () => {
      calls++;
      return "published";
    });
    const pending = await requestApproval(actor, {
      action: "now.publish",
      payload: { location: "cafe", message: "Join me" },
      summary: "Post invitation",
    });
    expect(pending.url).toBeNull();
    expect(pending.proofRequest?.session).toBe("prove");
    expect(pending.proofRequest?.session_id).toBe("session_ab01");
    const result = await api("world/agent/verify", "maya", "POST", {
      approvalId: pending.id,
      proof: approvalProof(pending),
    });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("consumed");
    expect(calls).toBe(1);
    expect(
      (
        await api("world/agent/verify", "maya", "POST", {
          approvalId: pending.id,
          proof: approvalProof(pending),
        })
      ).status,
    ).toBe(409);
    expect(calls).toBe(1);
  });
  it("rejects proof transfer, another human, denial and expired approvals without execution", async () => {
    const actor = await link();
    let calls = 0;
    registerApprovalExecutor("now.publish", async () => {
      calls++;
      return null;
    });
    const a = await requestApproval(actor, {
      action: "now.publish",
      payload: { n: 1 },
      summary: "First",
    });
    const b = await requestApproval(actor, {
      action: "now.publish",
      payload: { n: 2 },
      summary: "Second",
    });
    await expect(
      finishApproval({ approvalId: b.id, userId: actor.id, proof: approvalProof(a) }),
    ).rejects.toThrow();
    await expect(
      finishApproval({ approvalId: a.id, userId: DEMO_IDS.kenji, proof: approvalProof(a) }),
    ).rejects.toHaveProperty("code", "NOT_FOUND");
    await expect(
      finishApproval({
        approvalId: a.id,
        userId: actor.id,
        proof: approvalProof(a, "session_ff02"),
      }),
    ).rejects.toHaveProperty("code", "APPROVAL_SUBJECT");
    expect((await api("world/agent/deny", "maya", "POST", { approvalId: a.id })).body.status).toBe(
      "denied",
    );
    await expect(
      finishApproval({ approvalId: a.id, userId: actor.id, proof: approvalProof(a) }),
    ).rejects.toHaveProperty("code", "APPROVAL_CLOSED");
    await db
      .update(s.agentApprovals)
      .set({ expiresAt: new Date(1) })
      .where(eq(s.agentApprovals.id, b.id));
    await expect(
      finishApproval({ approvalId: b.id, userId: actor.id, proof: approvalProof(b) }),
    ).rejects.toHaveProperty("code", "APPROVAL_EXPIRED");
    expect(calls).toBe(0);
  });
  it.each(["expiry", "suspension"])(
    "rechecks %s after remote verification inside the transaction",
    async (condition) => {
      const actor = await link();
      let calls = 0;
      registerApprovalExecutor("now.publish", async () => {
        calls++;
        return null;
      });
      const pending = await requestApproval(actor, {
        action: "now.publish",
        payload: {},
        summary: "Post",
      });
      vi.stubGlobal(
        "fetch",
        mockVerifier(async () => {
          if (condition === "expiry")
            await db
              .update(s.agentApprovals)
              .set({ expiresAt: new Date(1) })
              .where(eq(s.agentApprovals.id, pending.id));
          else await db.update(s.users).set({ suspended: true }).where(eq(s.users.id, actor.id));
        }),
      );
      await expect(
        finishApproval({ approvalId: pending.id, userId: actor.id, proof: approvalProof(pending) }),
      ).rejects.toHaveProperty("code", condition === "expiry" ? "APPROVAL_EXPIRED" : "FORBIDDEN");
      expect(calls).toBe(0);
      expect((await loadApproval(pending.id)).status).toBe("pending");
    },
  );
  it("refuses a one-time uniqueness proof where a session proof is required", async () => {
    const actor = await link();
    const pending = await requestApproval(actor, {
      action: "agent.link",
      payload: {},
      summary: "Relink",
    });
    const r = pending.proofRequest!;
    await expect(
      finishApproval({
        approvalId: pending.id,
        userId: actor.id,
        proof: proof("concierge-approve", r.signal, r.nonce),
      }),
    ).rejects.toHaveProperty("code", "WORLD_VERIFY_FAILED");
  });
  it("refuses linking the same World ID session to a second account", async () => {
    await link();
    const pending = await requestApproval(await user(DEMO_IDS.kenji), {
      action: "agent.link",
      payload: {},
      summary: "Link",
    });
    await expect(
      finishApproval({
        approvalId: pending.id,
        userId: DEMO_IDS.kenji,
        proof: approvalProof(pending),
      }),
    ).rejects.toHaveProperty("code", "APPROVAL_SUBJECT");
  });
});
