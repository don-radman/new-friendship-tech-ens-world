import { z } from "zod";
import { isDemo, previewEns } from "@/server/config";
import { AppError } from "@/server/errors";
import { simulatedWorld } from "./simulated";
import { liveWorld } from "./live";

export interface RpContextDTO {
  rp_id: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  signature: string;
  app_id: string;
  action: string;
  environment: "production" | "staging" | "sandbox" | "simulated";
  /** Concierge approvals use World ID sessions: uniqueness proofs are one-time per action. */
  session?: "create" | "prove";
  session_id?: string;
}
export interface ProofRequestDTO extends RpContextDTO {
  requestId: string;
  signal: string;
}
export interface ProofInput {
  payload: unknown;
  action: string;
  signal: string;
  nonce?: string;
  requireUserPresence?: boolean;
}
export interface VerifiedProof {
  /** Decimal string of the 256-bit nullifier, ready for NUMERIC(78,0). */
  nullifier: string;
  signalHash: string | null;
  issuerSchemaId: string | null;
  expiresAtMin: Date | null;
  environment: string;
}
export interface AgentIdentity {
  issuer: string;
  sub: string;
  nonce: string;
  authTime: Date;
  acr?: string;
}
/**
 * World ID in two shapes: IDKit proof-of-human at trip activation (verified server-side against
 * the Developer Portal) and World ID for Agents (an OIDC identity provider used for the one-time
 * link and for fresh step-up authentication before every protected action).
 */
export interface WorldAdapter {
  readonly kind: "simulated" | "live";
  rpContext(action: string): Promise<RpContextDTO>;
  verifyProof(input: ProofInput): Promise<VerifiedProof>;
  agentAuthorizeUrl(input: {
    approvalId: string;
    nonce: string;
    codeChallenge: string;
    fresh: boolean;
  }): Promise<string>;
  agentExchange(input: { code: string; codeVerifier: string }): Promise<AgentIdentity>;
}
export function world(): WorldAdapter {
  return isDemo() || previewEns() ? simulatedWorld() : liveWorld();
}
/**
 * Concierge approvals through the official World ID for Agents dev environment (OIDC, pairwise
 * sub, fresh step-up), as the ETHGlobal prize requires. Otherwise approvals use IDKit sessions.
 */
export function agentApprovals() {
  return process.env.WORLD_APPROVALS === "agents";
}
export const WORLD_ACTION_TRIP = process.env.WORLD_ACTION_TRIP || "trip-activate";
export const WORLD_ACTION_APPROVAL = process.env.WORLD_ACTION_APPROVAL || "concierge-approve";
export function nullifierToDecimal(hex: unknown): string {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(hex))
    throw new AppError("WORLD_VERIFY_FAILED", "The proof did not include a nullifier.", 422);
  return BigInt(hex).toString();
}
/** The payload the simulated World produces and accepts. Never valid outside demo mode. */
export const simulatedProofSchema = z
  .object({
    simulated: z.literal(true),
    human: z.string().trim().min(1).max(80),
    unavailable: z.boolean().optional(),
  })
  .strict();
