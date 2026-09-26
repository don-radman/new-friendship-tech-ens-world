"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { BadgeCheck, ShieldAlert, Clock } from "lucide-react";
import { ApiError, useResource, useSession } from "./session";
import { Arrow, ErrorBox, Modal } from "./ui";
import type { ApprovalDTO } from "@/lib/types";
const IdkitWidget = dynamic(() => import("./idkit-widget"), { ssr: false });

const TERMINAL: Record<string, { title: string; body: string }> = {
  consumed: { title: "Approved.", body: "The concierge did it. Nothing else was touched." },
  approved: { title: "Approved.", body: "The concierge is doing it now." },
  denied: { title: "You declined.", body: "Nothing was written." },
  expired: { title: "This approval expired.", body: "Two minutes passed. Nothing was written." },
};
const ERROR_COPY: Record<string, string> = {
  APPROVAL_CONSUMED: "This approval was already used once. Nothing happened twice.",
  APPROVAL_EXPIRED: "This approval expired after two minutes. Nothing was written.",
  APPROVAL_CLOSED: "This approval is closed. Start a new one.",
  APPROVAL_SUBJECT: "A different World ID answered. Nothing was written.",
  APPROVAL_STALE: "That authentication was not fresh enough. Nothing was written.",
  APPROVAL_NONCE: "That authorization does not belong to this approval.",
  TABLE_FULL: "The table filled up while you were approving. Nothing was written.",
  TABLE_CLOSED: "The table closed while you were approving. Nothing was written.",
};
export function approvalErrorCopy(error: unknown) {
  if (error instanceof ApiError) return ERROR_COPY[error.code] ?? error.message;
  return error instanceof Error ? error.message : "Something went wrong.";
}
/**
 * One approval, end to end: the summary of what will happen, the World ID step (a link to the
 * World App in production, an approve/deny panel in the demo), a poll while pending, and a plain
 * terminal state. The action only happens server-side, after the backend validated the identity.
 */
export function ApprovalModal({
  approval,
  onClose,
  onResolved,
}: {
  approval: ApprovalDTO | null;
  onClose: () => void;
  onResolved?: (approval: ApprovalDTO) => void;
}) {
  const { api, config } = useSession();
  const [current, setCurrent] = useState<ApprovalDTO | null>(approval);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [proofOpen, setProofOpen] = useState(false);
  const resolved = useRef(false);
  useEffect(() => {
    setCurrent(approval);
    setError(null);
    setProofOpen(false);
    resolved.current = false;
  }, [approval]);
  useEffect(() => {
    if (!current || current.status !== "pending") return;
    const id = setInterval(() => {
      void api<ApprovalDTO>("approvals/" + current.id)
        .then((next) =>
          setCurrent((previous) => ({ ...next, url: next.url ?? previous?.url ?? null })),
        )
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(id);
  }, [api, current]);
  useEffect(() => {
    if (current && current.status !== "pending" && !resolved.current) {
      resolved.current = true;
      onResolved?.(current);
    }
  }, [current, onResolved]);
  async function simulate(decision: "approve" | "deny") {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      setCurrent(
        await api<ApprovalDTO>("world/agent/simulate", {
          method: "POST",
          body: JSON.stringify({ approvalId: current.id, decision }),
        }),
      );
    } catch (caught) {
      setError(new Error(approvalErrorCopy(caught)));
      try {
        setCurrent(await api<ApprovalDTO>("approvals/" + current.id));
      } catch {
        // keep the last known state
      }
    } finally {
      setBusy(false);
    }
  }
  async function deny() {
    if (!current) return;
    setBusy(true);
    try {
      setCurrent(
        await api<ApprovalDTO>("world/agent/deny", {
          method: "POST",
          body: JSON.stringify({ approvalId: current.id }),
        }),
      );
    } catch (caught) {
      setError(new Error(approvalErrorCopy(caught)));
    } finally {
      setBusy(false);
    }
  }
  const terminal = current ? TERMINAL[current.status] : null;
  return (
    <Modal open={!!approval} title="Approve with World ID" onClose={onClose}>
      {current && (
        <div className="approval-panel">
          <p className="eyebrow">
            {current.action === "agent.link" ? "CONNECT THE CONCIERGE" : "THE CONCIERGE WANTS TO"}
          </p>
          <h3>{current.summary}</h3>
          <p className="muted small">
            {current.action === "agent.link"
              ? "This links your World ID to the concierge once. Every action after this still asks you again."
              : "Nothing happens until you approve it with a fresh World ID authentication. Approvals expire after two minutes."}
          </p>
          <ErrorBox error={error} />
          {current.status === "pending" ? (
            current.simulated ? (
              <div className="sim-panel" role="group" aria-label="Simulated World ID app">
                <p className="eyebrow">SIMULATED WORLD ID APP · LOCAL DEMO</p>
                <p className="muted small">
                  The live flow opens World App for a proof bound to this exact request. Declining
                  cancels the request without executing it.
                </p>
                <div className="button-row">
                  <button
                    className="button lime"
                    disabled={busy}
                    onClick={() => void simulate("approve")}
                  >
                    {busy ? "Working…" : "Approve"} <Arrow />
                  </button>
                  <button
                    className="button ghost"
                    disabled={busy}
                    onClick={() => void simulate("deny")}
                  >
                    Decline
                  </button>
                </div>
              </div>
            ) : (
              <div className="sim-panel">
                <p className="muted small">
                  Confirm this exact request in World App. Your proof is checked before the action
                  runs.
                </p>
                <div className="button-row">
                  {current.proofRequest ? (
                    <button
                      className="button lime"
                      disabled={busy}
                      onClick={() => setProofOpen(true)}
                    >
                      Approve with World ID <Arrow />
                    </button>
                  ) : current.url ? (
                    <a
                      className="button lime"
                      href={current.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Approve with World ID <Arrow />
                    </a>
                  ) : (
                    <span className="muted small">Waiting for World ID…</span>
                  )}
                  <button className="button ghost" disabled={busy} onClick={() => void deny()}>
                    Decline
                  </button>
                  <span className="time-left">
                    <Clock size={14} /> expires {new Date(current.expiresAt).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            )
          ) : (
            <div className={"approval-result " + current.status}>
              {current.status === "consumed" || current.status === "approved" ? (
                <BadgeCheck size={22} />
              ) : (
                <ShieldAlert size={22} />
              )}
              <div>
                <strong>{terminal?.title}</strong>
                <p className="muted small">{terminal?.body}</p>
              </div>
            </div>
          )}
          {current.status === "pending" && current.proofRequest && (
            <IdkitWidget
              open={proofOpen}
              onOpenChange={setProofOpen}
              appId={current.proofRequest.app_id}
              action={current.proofRequest.action}
              rpContext={current.proofRequest}
              environment={
                current.proofRequest.environment === "simulated"
                  ? "staging"
                  : current.proofRequest.environment
              }
              credential="human"
              signal={current.proofRequest.signal}
              requireUserPresence
              session={current.proofRequest.session ?? "prove"}
              sessionId={current.proofRequest.session_id}
              description={current.summary}
              onVerify={async (proof) => {
                setBusy(true);
                try {
                  setCurrent(
                    await api<ApprovalDTO>("world/agent/verify", {
                      method: "POST",
                      body: JSON.stringify({ approvalId: current.id, proof }),
                    }),
                  );
                  setProofOpen(false);
                } catch (caught) {
                  setError(new Error(approvalErrorCopy(caught)));
                  throw caught;
                } finally {
                  setBusy(false);
                }
              }}
              onError={(code) => {
                if (code !== "failed_by_host_app")
                  setError(new Error("World ID could not complete this approval: " + code));
              }}
            />
          )}
          {config?.ensParent && current.action !== "agent.link" && (
            <p className="muted small mono">
              Signed by concierge.{config.ensParent} · may write friendship.now and friendship.table
              only
            </p>
          )}
          <button className="button ghost full" onClick={onClose}>
            {current.status === "pending" ? "Close for now" : "Done"}
          </button>
        </div>
      )}
    </Modal>
  );
}
/** Start an approval from any button, render `flow.modal` once in the tree. */
export function useApprovalFlow(onResolved?: (approval: ApprovalDTO) => void | Promise<void>) {
  const { api, notice } = useSession();
  const [approval, setApproval] = useState<ApprovalDTO | null>(null);
  const [starting, setStarting] = useState(false);
  const start = useCallback(
    async (path: string, body?: unknown) => {
      setStarting(true);
      try {
        setApproval(
          await api<ApprovalDTO>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
        );
      } catch (caught) {
        notice(approvalErrorCopy(caught));
      } finally {
        setStarting(false);
      }
    },
    [api, notice],
  );
  const handleResolved = useCallback(
    (resolvedApproval: ApprovalDTO) => {
      void onResolved?.(resolvedApproval);
    },
    [onResolved],
  );
  const modal: ReactNode = (
    <ApprovalModal
      approval={approval}
      onClose={() => setApproval(null)}
      onResolved={handleResolved}
    />
  );
  return { approval, starting, start, close: () => setApproval(null), modal };
}
/** Landing page after the World ID redirect (/approvals/:id): show the outcome and a way back. */
export function ApprovalResultView({ id }: { id: string }) {
  const { data, error, loading } = useResource<ApprovalDTO>("approvals/" + id);
  const params = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
  const failure = params?.get("error");
  const terminal = data ? TERMINAL[data.status] : null;
  return (
    <div className="approval-page">
      <p className="eyebrow">WORLD ID FOR AGENTS</p>
      <h1>{loading ? "Checking…" : (terminal?.title ?? "Waiting for your approval.")}</h1>
      {failure && (
        <div className="error-box">
          {ERROR_COPY[failure] ?? "World ID reported " + failure + "."}
        </div>
      )}
      {error && <ErrorBox error={error} />}
      {data && (
        <p className="muted">
          {data.summary}
          {terminal ? " · " + terminal.body : ""}
        </p>
      )}
      <Link className="button lime" href="/tokyo/tables">
        Back to tables <Arrow />
      </Link>
    </div>
  );
}
