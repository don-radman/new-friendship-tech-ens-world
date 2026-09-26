import { createRemoteJWKSet, jwtVerify } from "jose";
import { AppError, invariant } from "@/server/errors";
import {
  agentApprovals,
  nullifierToDecimal,
  type AgentIdentity,
  type ProofInput,
  type RpContextDTO,
  type VerifiedProof,
  type WorldAdapter,
} from "./adapter";

/** IDKit uses the Developer Portal verifier. WORLD_ALLOW_STAGING opts a build into the simulator. */
function env() {
  const appId = process.env.WORLD_APP_ID;
  const rpId = process.env.WORLD_RP_ID;
  const signingKey = process.env.WORLD_RP_SIGNING_KEY?.replace(/^0x/, "");
  const environment = process.env.WORLD_ENVIRONMENT ?? "production";
  invariant(
    appId &&
      appId.startsWith("app_") &&
      rpId &&
      rpId.startsWith("rp_") &&
      signingKey &&
      /^[a-fA-F0-9]{64}$/.test(signingKey),
    "WORLD_UNAVAILABLE",
    "Configure the World app, relying party and server signing key.",
    503,
  );
  invariant(
    environment === "production" ||
      ((process.env.NODE_ENV !== "production" || process.env.WORLD_ALLOW_STAGING === "true") &&
        ["staging", "sandbox"].includes(environment)),
    "WORLD_UNAVAILABLE",
    "Production deployments require WORLD_ENVIRONMENT=production (or WORLD_ALLOW_STAGING=true).",
    503,
  );
  invariant(
    !process.env.WORLD_VERIFY_BASE ||
      process.env.WORLD_VERIFY_BASE === "https://developer.world.org",
    "WORLD_UNAVAILABLE",
    "World proof verification must use the official Developer Portal.",
    503,
  );
  return {
    appId,
    rpId,
    signingKey,
    environment: environment as "production" | "staging" | "sandbox",
  };
}
export function worldProofIssuer() {
  const e = env();
  return `world-id:${e.rpId}:${e.environment}`;
}
/**
 * World ID 4.0 uniqueness proofs are one-time per (human, action), so recurring checks use
 * sessions: linking creates one, every later approval proves it again. Session requests are
 * signed without an action.
 */
export async function sessionRpContext(
  input: { mode: "create" } | { mode: "prove"; sessionId: string },
): Promise<RpContextDTO> {
  const e = env();
  const { signRequest } = await import("@worldcoin/idkit/signing");
  const signed = signRequest({ signingKeyHex: e.signingKey });
  return {
    rp_id: e.rpId,
    app_id: e.appId,
    action: "",
    nonce: signed.nonce,
    created_at: signed.createdAt,
    expires_at: signed.expiresAt,
    signature: signed.sig,
    environment: e.environment,
    session: input.mode,
    ...(input.mode === "prove" ? { session_id: input.sessionId } : {}),
  };
}
const SESSION_ID = /^session_[A-Za-z0-9]+$/;
export async function verifySessionProof(input: {
  payload: unknown;
  signal: string;
  nonce: string;
}): Promise<{ sessionId: string }> {
  const e = env();
  const payload = input.payload as {
    protocol_version?: string;
    action?: string;
    nonce?: string;
    environment?: string;
    session_id?: string;
    user_presence_completed?: boolean;
    responses?: {
      identifier?: string;
      signal_hash?: string;
      issuer_schema_id?: number;
      expires_at_min?: number;
    }[];
  } | null;
  invariant(
    payload &&
      typeof payload === "object" &&
      payload.protocol_version === "4.0" &&
      payload.action === undefined &&
      payload.environment === e.environment &&
      payload.nonce === input.nonce &&
      typeof payload.session_id === "string" &&
      SESSION_ID.test(payload.session_id) &&
      Array.isArray(payload.responses) &&
      payload.responses.length === 1,
    "WORLD_VERIFY_FAILED",
    "This proof does not match the issued World ID request.",
    422,
  );
  const credential = payload.responses[0];
  invariant(
    credential?.identifier === "proof_of_human" && credential.issuer_schema_id === 1,
    "WORLD_CREDENTIAL_UNAVAILABLE",
    "A World ID Proof of Human credential is required.",
    422,
  );
  const { hashSignal } = await import("@worldcoin/idkit/hashing");
  invariant(
    typeof credential.signal_hash === "string" &&
      /^0x[0-9a-fA-F]{1,64}$/.test(credential.signal_hash) &&
      BigInt(credential.signal_hash) === BigInt(hashSignal(input.signal)),
    "WORLD_SIGNAL_MISMATCH",
    "This proof was made for a different account or request.",
    422,
  );
  invariant(
    payload.user_presence_completed === true,
    "APPROVAL_STALE",
    "Confirm this request in World App to continue.",
    422,
  );
  invariant(
    typeof credential.expires_at_min === "number" && credential.expires_at_min * 1000 > Date.now(),
    "WORLD_VERIFY_FAILED",
    "The World ID credential has expired.",
    422,
  );
  const body = await postToVerifier(e.rpId, payload);
  const result = body.results?.find((item) => item.identifier === credential.identifier);
  // The verifier echoes these for sessions; reject a contradiction, tolerate an omission.
  invariant(
    body.success === true &&
      result?.success === true &&
      (body.session_id === undefined || body.session_id === payload.session_id) &&
      (body.environment === undefined || body.environment === e.environment),
    "WORLD_VERIFY_FAILED",
    "World ID could not verify this session proof.",
    422,
  );
  return { sessionId: payload.session_id };
}
type VerifierBody = {
  success?: boolean;
  environment?: string;
  action?: string;
  session_id?: string;
  results?: { identifier?: string; success?: boolean; nullifier?: string }[];
};
async function postToVerifier(rpId: string, payload: unknown): Promise<VerifierBody> {
  let response: Response;
  try {
    response = await fetch(
      `https://developer.world.org/api/v4/verify/${encodeURIComponent(rpId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      },
    );
  } catch {
    throw new AppError("WORLD_VERIFY_FAILED", "World ID verification is unreachable.", 503, true);
  }
  const body = (await response.json().catch(() => null)) as VerifierBody | null;
  if (response.status === 429 || response.status >= 500)
    throw new AppError(
      "WORLD_VERIFY_FAILED",
      "World ID verification is temporarily unavailable.",
      503,
      true,
    );
  invariant(response.ok && body, "WORLD_VERIFY_FAILED", "World ID rejected this proof.", 422);
  return body;
}
export class LiveWorld implements WorldAdapter {
  readonly kind = "live" as const;
  async rpContext(action: string): Promise<RpContextDTO> {
    const e = env();
    const { signRequest } = await import("@worldcoin/idkit/signing");
    const signed = signRequest({ signingKeyHex: e.signingKey, action });
    return {
      rp_id: e.rpId,
      app_id: e.appId,
      action,
      nonce: signed.nonce,
      created_at: signed.createdAt,
      expires_at: signed.expiresAt,
      signature: signed.sig,
      environment: e.environment,
    };
  }
  async verifyProof(input: ProofInput): Promise<VerifiedProof> {
    const e = env();
    const payload = input.payload as {
      protocol_version?: string;
      action?: string;
      nonce?: string;
      environment?: string;
      user_presence_completed?: boolean;
      responses?: {
        identifier?: string;
        nullifier?: string;
        signal_hash?: string;
        issuer_schema_id?: number;
        expires_at_min?: number;
      }[];
    } | null;
    invariant(
      payload &&
        typeof payload === "object" &&
        payload.protocol_version === "4.0" &&
        payload.action === input.action &&
        payload.environment === e.environment &&
        typeof input.nonce === "string" &&
        payload.nonce === input.nonce &&
        Array.isArray(payload.responses) &&
        payload.responses.length === 1,
      "WORLD_VERIFY_FAILED",
      "This proof does not match the issued World ID request.",
      422,
    );
    const credential = payload.responses[0];
    // No weaker device/selfie credential or legacy nullifier may satisfy Proof of Human.
    invariant(
      credential?.identifier === "proof_of_human" && credential.issuer_schema_id === 1,
      "WORLD_CREDENTIAL_UNAVAILABLE",
      "A World ID Proof of Human credential is required.",
      422,
    );
    const { hashSignal } = await import("@worldcoin/idkit/hashing");
    invariant(
      typeof credential.signal_hash === "string" &&
        /^0x[0-9a-fA-F]{1,64}$/.test(credential.signal_hash) &&
        BigInt(credential.signal_hash) === BigInt(hashSignal(input.signal)),
      "WORLD_SIGNAL_MISMATCH",
      "This proof was made for a different account or request.",
      422,
    );
    invariant(
      !input.requireUserPresence || payload.user_presence_completed === true,
      "APPROVAL_STALE",
      "Confirm this request in World App to continue.",
      422,
    );
    invariant(
      typeof credential.expires_at_min === "number" &&
        Number.isSafeInteger(credential.expires_at_min) &&
        credential.expires_at_min * 1000 > Date.now(),
      "WORLD_VERIFY_FAILED",
      "The World ID credential has expired.",
      422,
    );
    const expectedNullifier = nullifierToDecimal(credential.nullifier);
    let response: Response;
    try {
      response = await fetch(
        `https://developer.world.org/api/v4/verify/${encodeURIComponent(e.rpId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Preserve identifiers and all integrity fields; the server owns the expected context.
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        },
      );
    } catch {
      throw new AppError("WORLD_VERIFY_FAILED", "World ID verification is unreachable.", 503, true);
    }
    const body = (await response.json().catch(() => null)) as {
      success?: boolean;
      environment?: string;
      action?: string;
      results?: { identifier?: string; success?: boolean; nullifier?: string }[];
    } | null;
    if (response.status === 429 || response.status >= 500)
      throw new AppError(
        "WORLD_VERIFY_FAILED",
        "World ID verification is temporarily unavailable.",
        503,
        true,
      );
    const result = body?.results?.find((item) => item.identifier === credential.identifier);
    invariant(
      response.ok &&
        body?.success === true &&
        body.environment === e.environment &&
        body.action === input.action &&
        result?.success === true &&
        nullifierToDecimal(result.nullifier) === expectedNullifier,
      "WORLD_VERIFY_FAILED",
      "World ID could not verify the required Proof of Human.",
      422,
    );
    return {
      nullifier: expectedNullifier,
      signalHash: credential.signal_hash,
      issuerSchemaId: String(credential.issuer_schema_id),
      expiresAtMin: new Date(credential.expires_at_min * 1000),
      environment: e.environment,
    };
  }
  private discovery?: Promise<Discovery>;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  /** World ID for Agents: OIDC authorization code + PKCE S256, pairwise sub, RS256 ID tokens. */
  private agents() {
    const issuer = process.env.WORLD_AGENTS_ISSUER?.replace(/\/$/, ""),
      clientId = process.env.WORLD_AGENTS_CLIENT_ID,
      clientSecret = process.env.WORLD_AGENTS_CLIENT_SECRET,
      redirectUri = process.env.WORLD_AGENTS_REDIRECT_URI;
    invariant(
      agentApprovals() && issuer && clientId && clientSecret && redirectUri,
      "WORLD_AGENTS_UNAVAILABLE",
      "World ID for Agents is not configured: set WORLD_APPROVALS=agents and the WORLD_AGENTS_* client.",
      503,
    );
    return { issuer, clientId, clientSecret, redirectUri };
  }
  private async discover(): Promise<Discovery> {
    const a = this.agents();
    return (this.discovery ??= (async () => {
      const response = await fetch(a.issuer + "/.well-known/openid-configuration", {
        signal: AbortSignal.timeout(10000),
      });
      invariant(response.ok, "WORLD_AGENTS_UNAVAILABLE", "OIDC discovery failed.", 503);
      const doc = (await response.json()) as Discovery;
      invariant(
        doc.issuer === a.issuer && doc.authorization_endpoint && doc.token_endpoint && doc.jwks_uri,
        "WORLD_AGENTS_UNAVAILABLE",
        "OIDC discovery document is incomplete.",
        503,
      );
      return doc;
    })().catch((error) => {
      this.discovery = undefined;
      throw error;
    }));
  }
  async agentAuthorizeUrl(input: {
    approvalId: string;
    nonce: string;
    codeChallenge: string;
    fresh: boolean;
  }): Promise<string> {
    const a = this.agents(),
      doc = await this.discover();
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", a.clientId);
    url.searchParams.set("redirect_uri", a.redirectUri);
    url.searchParams.set("scope", "openid");
    url.searchParams.set("state", input.approvalId);
    url.searchParams.set("nonce", input.nonce);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    // RFC 9470 step-up: every protected action needs a fresh authentication, not a remembered one.
    if (input.fresh) {
      url.searchParams.set("prompt", "login");
      url.searchParams.set("max_age", "0");
    }
    return url.toString();
  }
  async agentExchange(input: { code: string; codeVerifier: string }): Promise<AgentIdentity> {
    const a = this.agents(),
      doc = await this.discover();
    let response: Response;
    try {
      response = await fetch(doc.token_endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization:
            "Basic " + Buffer.from(a.clientId + ":" + a.clientSecret).toString("base64"),
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: a.redirectUri,
          code_verifier: input.codeVerifier,
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new AppError("WORLD_AGENT_TOKEN", "World ID for Agents is unreachable.", 503, true);
    }
    const body = (await response.json().catch(() => null)) as { id_token?: string } | null;
    invariant(
      response.ok && body?.id_token,
      "WORLD_AGENT_TOKEN",
      "World ID did not issue an identity for this approval.",
      401,
    );
    this.jwks ??= createRemoteJWKSet(new URL(doc.jwks_uri));
    let payload;
    try {
      payload = (
        await jwtVerify(body.id_token, this.jwks, {
          issuer: doc.issuer,
          audience: a.clientId,
          algorithms: ["RS256"],
        })
      ).payload;
    } catch {
      throw new AppError("WORLD_AGENT_TOKEN", "The identity token failed validation.", 401);
    }
    invariant(
      typeof payload.sub === "string" && typeof payload.nonce === "string",
      "WORLD_AGENT_TOKEN",
      "The identity token is missing its subject or nonce.",
      401,
    );
    const authTime = typeof payload.auth_time === "number" ? payload.auth_time : payload.iat;
    return {
      issuer: doc.issuer,
      sub: payload.sub,
      nonce: payload.nonce,
      authTime: new Date((authTime ?? 0) * 1000),
      acr: typeof payload.acr === "string" ? payload.acr : undefined,
    };
  }
}
interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}
let instance: LiveWorld | undefined;
export function liveWorld(): WorldAdapter {
  return (instance ??= new LiveWorld());
}
