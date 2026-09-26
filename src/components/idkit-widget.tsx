"use client";
import {
  IDKitRequestWidget,
  IDKitSessionWidget,
  CredentialRequest,
  type IDKitResult,
  type RpContext,
} from "@worldcoin/idkit";

/**
 * The real World ID widget, loaded only for live flows through next/dynamic. The backend signs
 * rp_context and verifies the returned proof; the widget
 * itself never sees a secret.
 *
 * `session` switches to a World ID session: uniqueness proofs are one-time per action, so the
 * concierge link creates a session and each approval proves that same session again.
 */
export default function IdkitWidget({
  open,
  onOpenChange,
  appId,
  action,
  rpContext,
  environment,
  credential,
  signal,
  onVerify,
  onError,
  requireUserPresence = false,
  description,
  session,
  sessionId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appId: string;
  action: string;
  rpContext: RpContext;
  environment: "production" | "staging" | "sandbox";
  credential: "human" | "passport";
  signal: string;
  onVerify: (result: IDKitResult) => Promise<void>;
  onError?: (code: string) => void;
  requireUserPresence?: boolean;
  description?: string;
  session?: "create" | "prove";
  sessionId?: string;
}) {
  const constraints = CredentialRequest(credential === "passport" ? "passport" : "proof_of_human", {
    signal,
    expires_at_min: rpContext.expires_at,
  });
  // Only the five signed fields: the DTO carries extras World App does not expect.
  const rp_context: RpContext = {
    rp_id: rpContext.rp_id,
    nonce: rpContext.nonce,
    created_at: rpContext.created_at,
    expires_at: rpContext.expires_at,
    signature: rpContext.signature,
  };
  const shared = {
    open,
    onOpenChange,
    app_id: appId as `app_${string}`,
    rp_context,
    require_user_presence: requireUserPresence,
    action_description: description,
    constraints,
    environment,
    handleVerify: onVerify,
    onSuccess: () => undefined,
    onError: (code: unknown) => onError?.(String(code)),
  };
  if (session)
    return (
      <IDKitSessionWidget
        {...shared}
        existing_session_id={
          session === "prove" && sessionId ? (sessionId as `session_${string}`) : undefined
        }
      />
    );
  return <IDKitRequestWidget {...shared} action={action} allow_legacy_proofs={false} />;
}
