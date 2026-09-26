import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, type Tx } from "@/server/db";
import * as s from "@/server/db/schema";
import { applyWrite } from "@/server/db/write";
import { AppError, invariant } from "@/server/errors";
import { agentApprovals, world, type AgentIdentity } from "./adapter";
import { sessionRpContext, verifySessionProof, worldProofIssuer } from "./live";
import { digest } from "./requests";
import type { ApprovalAction, ApprovalDTO } from "@/lib/types";

/**
 * Every action that puts a member in a room with someone (or publishes where they are) runs only
 * as the executor of an approval the member answered with a fresh World ID authentication.
 *
 *   pending -> approved -> consumed     the member authenticated, the executor ran, done
 *   pending -> denied                   the member declined (OIDC access_denied)
 *   pending -> expired                  two minutes passed (ten for the one-time link)
 *
 * A consumed row rejects a second callback and leaves an audit trail. The executor runs inside
 * the same transaction that marks the row consumed, so an action never happens twice and never
 * happens without a row that says who approved it and when.
 */
export type ApprovalExecutor = (
  tx: Tx,
  approval: s.ApprovalRow,
  user: s.UserRow,
) => Promise<string | null>;
const executors = new Map<ApprovalAction, ApprovalExecutor>();
export function registerApprovalExecutor(action: ApprovalAction, executor: ApprovalExecutor) {
  executors.set(action, executor);
}
// Linking has no downstream effect beyond storing the pairwise subject, which finishApproval does itself.
registerApprovalExecutor("agent.link", async () => null);

export const APPROVAL_TTL_MS = 2 * 60000;
export const LINK_TTL_MS = 10 * 60000;
const base64url = (buffer: Buffer) =>
  buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** RFC 7636: a 43-character verifier and its S256 challenge. */
export function pkce() {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}
function effectiveStatus(row: s.ApprovalRow) {
  return row.status === "pending" && row.expiresAt <= new Date() ? "expired" : row.status;
}
function approvalSignal(
  row: Pick<s.ApprovalRow, "id" | "userId" | "action" | "payload" | "nonce">,
) {
  return digest({
    purpose: "approval",
    id: row.id,
    userId: row.userId,
    action: row.action,
    payload: row.payload,
    nonce: row.nonce,
  });
}
export function approvalDTO(row: s.ApprovalRow, url: string | null = null): ApprovalDTO {
  const status = effectiveStatus(row);
  return {
    id: row.id,
    action: row.action,
    summary: row.summary,
    status,
    url: status === "pending" ? url : null,
    expiresAt: row.expiresAt.toISOString(),
    resultId: row.resultId,
    simulated: world().kind === "simulated",
    proofRequest:
      status === "pending" && row.rpContext
        ? { ...row.rpContext, requestId: row.id, signal: approvalSignal(row) }
        : null,
  };
}
export async function requestApproval(
  user: s.UserRow,
  input: { action: ApprovalAction; payload: Record<string, unknown>; summary: string },
): Promise<ApprovalDTO> {
  const link = input.action === "agent.link";
  invariant(
    link || user.worldAgentSub,
    "AGENT_NOT_LINKED",
    "Let the concierge act for you first: connect World ID in Settings.",
    409,
  );
  invariant(executors.has(input.action), "APPROVAL_UNHANDLED", "Unknown action.", 500);
  // Link creates a World ID session; every later approval proves that same session again.
  // WORLD_APPROVALS=agents sends approvals through World ID for Agents (OIDC) instead.
  const rp =
    world().kind === "live" && !agentApprovals()
      ? await sessionRpContext(
          link ? { mode: "create" } : { mode: "prove", sessionId: user.worldAgentSub! },
        )
      : null;
  const { verifier, challenge } = pkce(),
    nonce = rp?.nonce ?? randomBytes(16).toString("hex");
  const row = await applyWrite(
    user.id,
    "approval.request",
    input.action,
    async (tx) =>
      (
        await tx
          .insert(s.agentApprovals)
          .values({
            userId: user.id,
            action: input.action,
            payload: input.payload,
            summary: input.summary,
            nonce,
            codeVerifier: verifier,
            rpContext: rp,
            expiresAt: new Date(
              Math.min(
                Date.now() + (link ? LINK_TTL_MS : APPROVAL_TTL_MS),
                rp ? rp.expires_at * 1000 : Infinity,
              ),
            ),
          })
          .returning()
      )[0],
  );
  const url = rp
    ? null
    : await world().agentAuthorizeUrl({
        approvalId: row.id,
        nonce,
        codeChallenge: challenge,
        fresh: !link,
      });
  return approvalDTO(row, url);
}
export async function loadApproval(id: string, userId?: string) {
  const db = await getDb();
  const [row] = await db.select().from(s.agentApprovals).where(eq(s.agentApprovals.id, id));
  invariant(row && (!userId || row.userId === userId), "NOT_FOUND", "Approval not found.", 404);
  return row;
}
export async function approvalStatus(user: s.UserRow, id: string): Promise<ApprovalDTO> {
  const row = await loadApproval(id, user.id);
  if (row.status === "pending" && row.expiresAt <= new Date()) await mark(row.id, "expired");
  return approvalDTO({ ...row, status: effectiveStatus(row) });
}
async function mark(id: string, status: "expired" | "denied") {
  await applyWrite(null, "approval." + status, id, async (tx) => {
    await tx
      .update(s.agentApprovals)
      .set({ status })
      .where(and(eq(s.agentApprovals.id, id), eq(s.agentApprovals.status, "pending")));
  });
}
export async function finishApproval(input: {
  approvalId: string;
  code?: string;
  error?: string;
  identity?: AgentIdentity;
  proof?: unknown;
  userId?: string;
}): Promise<ApprovalDTO> {
  const row = await loadApproval(input.approvalId, input.userId);
  invariant(
    !row.rpContext || input.userId === row.userId,
    "UNAUTHENTICATED",
    "Sign in to answer this approval.",
    401,
  );
  const db = await getDb();
  const [user] = await db.select().from(s.users).where(eq(s.users.id, row.userId));
  invariant(user && !user.suspended, "FORBIDDEN", "This account is unavailable.", 403);
  if (row.status === "consumed" || row.status === "approved") {
    await applyWrite(row.userId, "approval.replay", row.id, async () => undefined);
    throw new AppError("APPROVAL_CONSUMED", "This approval was already used.", 409);
  }
  if (row.status === "denied" || row.status === "expired")
    throw new AppError("APPROVAL_CLOSED", "This approval is closed. Start a new one.", 409);
  if (row.expiresAt <= new Date()) {
    await mark(row.id, "expired");
    throw new AppError(
      "APPROVAL_EXPIRED",
      "This approval expired after two minutes. Nothing was written.",
      409,
    );
  }
  if (input.error) {
    await mark(row.id, "denied");
    return approvalDTO({ ...row, status: "denied" });
  }
  invariant(
    input.identity || input.code || input.proof,
    "APPROVAL_INCOMPLETE",
    "World ID did not return an authorization.",
    422,
  );
  let identity: AgentIdentity;
  if (row.rpContext) {
    invariant(
      input.proof && !input.identity && !input.code,
      "APPROVAL_INCOMPLETE",
      "A World ID proof is required.",
      422,
    );
    const verified = await verifySessionProof({
      payload: input.proof,
      signal: approvalSignal(row),
      nonce: row.nonce,
    });
    identity = {
      issuer: worldProofIssuer(),
      sub: verified.sessionId,
      nonce: row.nonce,
      authTime: new Date(row.rpContext.created_at * 1000),
    };
  } else {
    invariant(
      world().kind === "simulated" || agentApprovals(),
      "APPROVAL_INCOMPLETE",
      "Start a new World ID proof request.",
      409,
    );
    identity =
      input.identity ??
      (await world().agentExchange({ code: input.code!, codeVerifier: row.codeVerifier }));
  }
  invariant(
    identity.nonce === row.nonce,
    "APPROVAL_NONCE",
    "The identity does not belong to this approval.",
    401,
  );
  if (row.action !== "agent.link") {
    invariant(
      user.worldAgentSub &&
        identity.sub === user.worldAgentSub &&
        identity.issuer === user.worldAgentIssuer,
      "APPROVAL_SUBJECT",
      "A different World ID answered this approval.",
      403,
    );
    invariant(
      identity.authTime.getTime() >= row.createdAt.getTime() - 60000,
      "APPROVAL_STALE",
      "A fresh authentication is required for this action.",
      401,
    );
  }
  const executor = executors.get(row.action);
  invariant(executor, "APPROVAL_UNHANDLED", "No executor for " + row.action, 500);
  const updated = await applyWrite(row.userId, "approval." + row.action, row.id, async (tx) => {
    const [locked] = await tx
      .select()
      .from(s.agentApprovals)
      .where(eq(s.agentApprovals.id, row.id))
      .for("update");
    invariant(
      locked.status === "pending",
      "APPROVAL_CONSUMED",
      "This approval was already used.",
      409,
    );
    invariant(
      locked.expiresAt > new Date(),
      "APPROVAL_EXPIRED",
      "This approval expired. No action was executed.",
      409,
    );
    const [freshUser] = await tx
      .select()
      .from(s.users)
      .where(eq(s.users.id, row.userId))
      .for("update");
    invariant(freshUser && !freshUser.suspended, "FORBIDDEN", "This account is unavailable.", 403);
    if (row.action !== "agent.link")
      invariant(
        freshUser.worldAgentSub === identity.sub && freshUser.worldAgentIssuer === identity.issuer,
        "APPROVAL_SUBJECT",
        "The linked World ID changed. Start again.",
        403,
      );
    await tx
      .update(s.agentApprovals)
      .set({ status: "approved", worldSub: identity.sub, authTime: identity.authTime })
      .where(eq(s.agentApprovals.id, row.id));
    let actor = freshUser;
    if (row.action === "agent.link") {
      // A linked account cannot silently replace its human, and one World identity cannot own two accounts.
      invariant(
        !freshUser.worldAgentSub ||
          (freshUser.worldAgentSub === identity.sub &&
            freshUser.worldAgentIssuer === identity.issuer),
        "APPROVAL_SUBJECT",
        "This account is already linked to a different World ID.",
        409,
      );
      const [other] = await tx
        .select({ id: s.users.id })
        .from(s.users)
        .where(
          and(
            eq(s.users.worldAgentIssuer, identity.issuer),
            eq(s.users.worldAgentSub, identity.sub),
          ),
        );
      invariant(
        !other || other.id === row.userId,
        "APPROVAL_SUBJECT",
        "This World ID is already linked to another account.",
        409,
      );
      await tx
        .update(s.users)
        .set({
          worldAgentIssuer: identity.issuer,
          worldAgentSub: identity.sub,
          updatedAt: new Date(),
        })
        .where(eq(s.users.id, row.userId));
      actor = { ...freshUser, worldAgentIssuer: identity.issuer, worldAgentSub: identity.sub };
    }
    const resultId = await executor(
      tx,
      { ...locked, status: "approved", worldSub: identity.sub, authTime: identity.authTime },
      actor,
    );
    return (
      await tx
        .update(s.agentApprovals)
        .set({ status: "consumed", consumedAt: new Date(), resultId })
        .where(eq(s.agentApprovals.id, row.id))
        .returning()
    )[0];
  });
  return approvalDTO(updated);
}
