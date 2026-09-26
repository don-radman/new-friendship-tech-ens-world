import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
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
import { api, bootSessions } from "./helpers";

/** World ID for Agents (sandbox OIDC) against a fake IdP that signs real RS256 ID tokens. */
const ISSUER = "https://sandbox.auth.world.org";
let db: Database;
let privateKey: CryptoKey;
let jwk: JWK;
let answer: { sub: string; nonce: string; authTime: number } | null = null;

function fakeIdp() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === ISSUER + "/.well-known/openid-configuration")
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: ISSUER + "/api/v1/authorize",
        token_endpoint: ISSUER + "/api/v1/token",
        jwks_uri: ISSUER + "/.well-known/jwks.json",
      });
    if (url === ISSUER + "/.well-known/jwks.json")
      return Response.json({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] });
    if (url === ISSUER + "/api/v1/token") {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const id_token = await new SignJWT({ nonce: answer!.nonce, auth_time: answer!.authTime })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(ISSUER)
        .setAudience("client_test")
        .setSubject(answer!.sub)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return Response.json({ id_token });
    }
    throw new Error("Unexpected fetch " + url);
  });
}
beforeAll(async () => {
  db = await getDb();
  await bootSessions();
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  jwk = await exportJWK(pair.publicKey);
}, 30000);
beforeEach(async () => {
  await db.execute(sql.raw("TRUNCATE users, cities, audit_log, rate_limits CASCADE"));
  await seedDemo(db);
  vi.stubEnv("WORLD_APPROVALS", "agents");
  vi.stubEnv("WORLD_AGENTS_ISSUER", ISSUER);
  vi.stubEnv("WORLD_AGENTS_CLIENT_ID", "client_test");
  vi.stubEnv("WORLD_AGENTS_CLIENT_SECRET", "secret_test");
  vi.stubEnv("WORLD_AGENTS_REDIRECT_URI", "https://app.test/api/world/agent/callback");
  vi.stubGlobal("fetch", fakeIdp());
  vi.spyOn(adapter, "world").mockReturnValue(new LiveWorld());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(closeDb);

const user = async (id = DEMO_IDS.maya) =>
  (await db.select().from(s.users).where(eq(s.users.id, id)))[0];
const now = () => Math.floor(Date.now() / 1000);
async function answerWith(approvalId: string, sub: string, authTime = now()) {
  answer = { sub, nonce: (await loadApproval(approvalId)).nonce, authTime };
}
async function link() {
  const pending = await requestApproval(await user(), {
    action: "agent.link",
    payload: {},
    summary: "Link",
  });
  await answerWith(pending.id, "pairwise-maya");
  await finishApproval({ approvalId: pending.id, code: "code-link" });
  return user();
}

describe("World ID for Agents approvals (WORLD_APPROVALS=agents)", () => {
  it("links once, then runs each action only after a fresh World ID login", async () => {
    const pending = await requestApproval(await user(), {
      action: "agent.link",
      payload: {},
      summary: "Link",
    });
    const authorize = new URL(pending.url!);
    expect(authorize.origin + authorize.pathname).toBe(ISSUER + "/api/v1/authorize");
    expect(authorize.searchParams.get("state")).toBe(pending.id);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(pending.proofRequest).toBeNull();
    await answerWith(pending.id, "pairwise-maya");
    expect((await finishApproval({ approvalId: pending.id, code: "c1" })).status).toBe("consumed");
    const actor = await user();
    expect([actor.worldAgentIssuer, actor.worldAgentSub]).toEqual([ISSUER, "pairwise-maya"]);

    let calls = 0;
    registerApprovalExecutor("now.publish", async () => {
      calls++;
      return "published";
    });
    const action = await requestApproval(actor, {
      action: "now.publish",
      payload: { location: "cafe" },
      summary: "Post invitation",
    });
    const stepUp = new URL(action.url!);
    expect(stepUp.searchParams.get("prompt")).toBe("login");
    expect(stepUp.searchParams.get("max_age")).toBe("0");
    await answerWith(action.id, "pairwise-maya");
    const callback = await api(`world/agent/callback?state=${action.id}&code=c2`);
    expect(callback.status).toBe(302);
    expect((await loadApproval(action.id)).status).toBe("consumed");
    expect(calls).toBe(1);
  });
  it("never runs the action when denied, stale, or answered by another human", async () => {
    const actor = await link();
    let calls = 0;
    registerApprovalExecutor("now.publish", async () => {
      calls++;
      return null;
    });
    const ask = () =>
      requestApproval(actor, { action: "now.publish", payload: {}, summary: "Post" });

    const denied = await ask();
    await api(`world/agent/callback?state=${denied.id}&error=access_denied`);
    expect((await loadApproval(denied.id)).status).toBe("denied");

    const stale = await ask();
    await answerWith(stale.id, "pairwise-maya", now() - 3600);
    await expect(finishApproval({ approvalId: stale.id, code: "c" })).rejects.toHaveProperty(
      "code",
      "APPROVAL_STALE",
    );

    const other = await ask();
    await answerWith(other.id, "pairwise-someone-else");
    await expect(finishApproval({ approvalId: other.id, code: "c" })).rejects.toHaveProperty(
      "code",
      "APPROVAL_SUBJECT",
    );
    expect(calls).toBe(0);
  });
});
