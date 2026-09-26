import { and, asc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Database, type Tx } from "@/server/db";
import * as s from "@/server/db/schema";
import { applyWrite } from "@/server/db/write";
import { AppError, invariant } from "@/server/errors";
import { config, isDemo } from "@/server/config";
import { requireTripAccess } from "@/server/membership";
import { publishedCity } from "@/server/catalog";
import { chain, ChainRevert, type RecordWrite, type Signer } from "@/server/ens-v2/chain";
import { ETH_COIN_TYPE, OG_COIN_TYPE } from "@/server/ens-v2/addresses";
import { defaultTripRecords, labelSchema, suggestLabel, tripName } from "@/server/ens-v2/names";
import { labelId } from "@/server/ens-v2/names";
import { assertChainWriteProof, observedKey } from "@/server/ens-v2/proof";
import {
  drainEnsJobs,
  enqueueEnsJob,
  registerEnsJobHandler,
  ensJobCheckpoint,
  ensJobSubmission,
} from "@/server/ens-v2/jobs";
import { world, WORLD_ACTION_TRIP, type VerifiedProof } from "@/server/world/adapter";
import { consumeTripProofRequest, tripProofRequest } from "@/server/world/requests";
import { nowRecord, tripDTO } from "./dto";
import type { NowRecord, TripDTO } from "@/lib/types";

export const ACTIVE_STATUSES = ["pending_chain", "active"] as const;
const MIN_TRIP_MS = 60 * 60000,
  MAX_TRIP_MS = 90 * 86400000;
export const activateSchema = z
  .object({
    city: z
      .string()
      .regex(/^[a-z-]+$/)
      .default("tokyo"),
    label: labelSchema.optional(),
    arrivesAt: z.iso.datetime({ offset: true }),
    departsAt: z.iso.datetime({ offset: true }),
    proof: z.unknown().optional(),
    requestId: z.uuid().optional(),
  })
  .strict();
export const extendSchema = z
  .object({
    city: z
      .string()
      .regex(/^[a-z-]+$/)
      .default("tokyo"),
    departsAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export const citySchema = z
  .object({
    city: z
      .string()
      .regex(/^[a-z-]+$/)
      .default("tokyo"),
  })
  .strict();
export const payRecordSchema = citySchema.extend({ enabled: z.boolean() }).strict();

function assertDates(arrivesAt: Date, departsAt: Date, now = new Date()) {
  invariant(
    arrivesAt.getTime() < departsAt.getTime() &&
      departsAt.getTime() > now.getTime() + MIN_TRIP_MS &&
      departsAt.getTime() <= now.getTime() + MAX_TRIP_MS,
    "TRIP_DATES",
    "Departure must be after arrival, at least an hour from now and within ninety days.",
    422,
  );
}
export async function activeTripFor(userId: string, city: string, db?: Tx | Database) {
  const [row] = await (db ?? (await getDb()))
    .select()
    .from(s.trips)
    .where(
      and(
        eq(s.trips.userId, userId),
        eq(s.trips.city, city),
        eq(s.trips.status, "active"),
        gt(s.trips.departsAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}
async function currentTrip(userId: string, city: string, db?: Tx | Database) {
  const [row] = await (db ?? (await getDb()))
    .select()
    .from(s.trips)
    .where(
      and(
        eq(s.trips.userId, userId),
        eq(s.trips.city, city),
        inArray(s.trips.status, [...ACTIVE_STATUSES]),
        gt(s.trips.departsAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}
export async function nowFor(
  userIds: string[],
  db?: Tx | Database,
): Promise<Map<string, NowRecord>> {
  if (!userIds.length) return new Map();
  const rows = await (db ?? (await getDb()))
    .select()
    .from(s.nowPosts)
    .where(
      and(
        inArray(s.nowPosts.userId, userIds),
        eq(s.nowPosts.active, true),
        gt(s.nowPosts.expiresAt, new Date()),
      ),
    );
  const map = new Map<string, NowRecord>();
  for (const row of rows) {
    const record = nowRecord(row);
    if (record) map.set(row.userId, record);
  }
  return map;
}
/** Demo mode has no worker process: expire due trips and run due chain jobs inline. */
export async function tickEnsWorld() {
  if (!isDemo()) return;
  await expireTrips();
  await drainEnsJobs();
}
/** A live account's stored Proof of Human. World ID 4.0 issues one proof per human per action. */
export async function priorHumanProof(userId: string, db?: Tx | Database) {
  const [row] = await (db ?? (await getDb()))
    .select()
    .from(s.humanProofs)
    .where(
      and(
        eq(s.humanProofs.userId, userId),
        eq(s.humanProofs.action, WORLD_ACTION_TRIP),
        ne(s.humanProofs.environment, "simulated"),
      ),
    )
    .orderBy(asc(s.humanProofs.verifiedAt))
    .limit(1);
  return row ?? null;
}
export async function activateTrip(
  user: s.UserRow,
  body: z.infer<typeof activateSchema>,
): Promise<TripDTO> {
  await requireTripAccess(user.id);
  await publishedCity(body.city);
  const arrivesAt = new Date(body.arrivesAt),
    departsAt = new Date(body.departsAt);
  assertDates(arrivesAt, departsAt);
  // Release partial-unique active-trip slots before a returning member starts another trip.
  await expireTrips(new Date(), user.id);
  // World ID 4.0 uniqueness proofs are one-time per (human, action): a live account proves it is
  // human once, and every later trip reuses that stored proof.
  let prior = world().kind === "live" ? await priorHumanProof(user.id) : null;
  let verified: VerifiedProof | null = null;
  if (!prior) {
    const request =
      world().kind === "live" ? await tripProofRequest(user.id, body.requestId, body) : null;
    const proven = await world().verifyProof({
      payload: body.proof,
      action: WORLD_ACTION_TRIP,
      signal: request?.signal ?? body.city,
      nonce: request?.rpContext.nonce,
    });
    verified = proven;
    // Persist before the trip insert: if the trip fails, World will not issue this human another proof.
    if (request)
      prior = await applyWrite(user.id, "human.verify", body.city, async (tx) => {
        await consumeTripProofRequest(tx, request.id, user.id);
        const [other] = await tx
          .select({ id: s.humanProofs.id })
          .from(s.humanProofs)
          .where(
            and(
              eq(s.humanProofs.action, WORLD_ACTION_TRIP),
              eq(s.humanProofs.nullifier, proven.nullifier),
              ne(s.humanProofs.userId, user.id),
            ),
          )
          .limit(1);
        invariant(
          !other,
          "HUMAN_ALREADY_PRESENT",
          "This World ID already verified another account. One human, one account.",
          409,
        );
        return (
          await tx
            .insert(s.humanProofs)
            .values({
              userId: user.id,
              action: WORLD_ACTION_TRIP,
              city: body.city,
              nullifier: proven.nullifier,
              signalHash: proven.signalHash,
              issuerSchemaId: proven.issuerSchemaId,
              expiresAtMin: proven.expiresAtMin,
              environment: proven.environment,
            })
            .returning()
        )[0];
      });
  }
  const nullifier = prior?.nullifier ?? verified!.nullifier;
  const wanted = body.label ?? suggestLabel(user.name);
  const addresses = chain().addresses;
  const trip = await applyWrite(user.id, "trip.activate", body.city, async (tx) => {
    await tx.select({ id: s.users.id }).from(s.users).where(eq(s.users.id, user.id)).for("update");
    // One lock per (city, human): two concurrent activations by the same World ID serialize here.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${body.city + ":" + nullifier}))`);
    invariant(
      !(await currentTrip(user.id, body.city, tx)),
      "TRIP_EXISTS",
      "You already have an active trip in this city. End it before starting another.",
      409,
    );
    const [present] = await tx
      .select({ id: s.trips.id })
      .from(s.trips)
      .innerJoin(s.humanProofs, eq(s.trips.humanProofId, s.humanProofs.id))
      .where(
        and(
          eq(s.trips.city, body.city),
          inArray(s.trips.status, [...ACTIVE_STATUSES]),
          gt(s.trips.departsAt, new Date()),
          eq(s.humanProofs.nullifier, nullifier),
        ),
      )
      .limit(1);
    invariant(
      !present,
      "HUMAN_ALREADY_PRESENT",
      "This World ID already has an active trip in this city. One human, one trip.",
      409,
    );
    const [proof] = prior
      ? [prior]
      : await tx
          .insert(s.humanProofs)
          .values({
            userId: user.id,
            action: WORLD_ACTION_TRIP,
            city: body.city,
            nullifier,
            signalHash: verified!.signalHash,
            issuerSchemaId: verified!.issuerSchemaId,
            expiresAtMin: verified!.expiresAtMin,
            environment: verified!.environment,
          })
          .returning();
    const taken = new Set(
      (
        await tx
          .select({ label: s.trips.label })
          .from(s.trips)
          .where(and(eq(s.trips.city, body.city), inArray(s.trips.status, [...ACTIVE_STATUSES])))
      ).map((row) => row.label),
    );
    let label = wanted;
    for (let n = 2; taken.has(label); n++) label = (wanted.slice(0, 29) + "-" + n).slice(0, 32);
    const [row] = await tx
      .insert(s.trips)
      .values({
        userId: user.id,
        city: body.city,
        label,
        ensName: tripName(body.city, label),
        labelhash: "0x" + labelId(label).toString(16).padStart(64, "0"),
        registry: addresses.cityRegistry,
        resolver: addresses.appResolver,
        arrivesAt,
        departsAt,
        status: "pending_chain",
        humanProofId: proof.id,
      })
      .returning();
    if (!user.verifiedHumanAt)
      await tx
        .update(s.users)
        .set({ verifiedHumanAt: new Date(), updatedAt: new Date() })
        .where(eq(s.users.id, user.id));
    await enqueueEnsJob(tx, { kind: "trip.register", signer: "operator", entityId: row.id });
    return row;
  });
  await tickEnsWorld();
  return (
    (await myTrip({ ...user, verifiedHumanAt: user.verifiedHumanAt ?? new Date() }, body.city)) ??
    tripDTO(trip, { verifiedHumanAt: new Date() })
  );
}
export async function myTrip(user: s.UserRow, city = "tokyo"): Promise<TripDTO | null> {
  await tickEnsWorld();
  const row = await currentTrip(user.id, city);
  if (!row) return null;
  const now = (await nowFor([user.id])).get(user.id) ?? null;
  return tripDTO(row, user, now);
}
export async function extendTrip(
  user: s.UserRow,
  body: z.infer<typeof extendSchema>,
): Promise<TripDTO> {
  const departsAt = new Date(body.departsAt);
  const trip = await applyWrite(user.id, "trip.extend", body.city, async (tx) => {
    const row = await activeTripFor(user.id, body.city, tx);
    invariant(row, "TRIP_REQUIRED", "Activate a trip first.", 404);
    assertDates(row.arrivesAt, departsAt);
    invariant(
      departsAt.getTime() > row.departsAt.getTime(),
      "TRIP_DATES",
      "A trip can only be extended. To leave earlier, end it.",
      422,
    );
    await tx
      .update(s.trips)
      .set({ departsAt, updatedAt: new Date() })
      .where(eq(s.trips.id, row.id));
    await enqueueEnsJob(tx, {
      kind: "trip.renew",
      signer: "operator",
      entityId: row.id,
      payload: { expiry: Math.floor(departsAt.getTime() / 1000) },
    });
    return row;
  });
  await tickEnsWorld();
  return (await myTrip(user, trip.city))!;
}
export async function endTrip(user: s.UserRow, city = "tokyo"): Promise<TripDTO> {
  const row = await applyWrite(user.id, "trip.end", city, async (tx) => {
    const current = await currentTrip(user.id, city, tx);
    invariant(current, "TRIP_REQUIRED", "There is no active trip to end.", 404);
    await tx
      .update(s.trips)
      .set({ status: "ended", updatedAt: new Date() })
      .where(eq(s.trips.id, current.id));
    await tx.update(s.nowPosts).set({ active: false }).where(eq(s.nowPosts.userId, user.id));
    await enqueueEnsJob(tx, { kind: "trip.expire", signer: "operator", entityId: current.id });
    return current;
  });
  await tickEnsWorld();
  const db = await getDb();
  const [fresh] = await db.select().from(s.trips).where(eq(s.trips.id, row.id));
  return tripDTO(fresh, user);
}
/** Public: a name to whether a verified human is present, nothing about the account behind it. */
export async function tripByName(rawName: string) {
  const name = rawName.trim().toLowerCase();
  invariant(/^[a-z0-9.-]{3,255}$/.test(name), "VALIDATION", "Enter a valid name.", 422);
  await tickEnsWorld();
  const db = await getDb();
  const [row] = await db
    .select({ trip: s.trips, user: s.users })
    .from(s.trips)
    .innerJoin(s.users, eq(s.trips.userId, s.users.id))
    .where(eq(s.trips.ensName, name))
    .orderBy(asc(s.trips.createdAt))
    .limit(1);
  invariant(row, "NOT_FOUND", "No trip has this name.", 404);
  const latest = (
    await db
      .select()
      .from(s.trips)
      .where(eq(s.trips.ensName, name))
      .orderBy(sql`${s.trips.createdAt} desc`)
      .limit(1)
  )[0];
  const active = latest.status === "active" && latest.departsAt > new Date();
  return {
    name,
    city: latest.city,
    active,
    departsAt: latest.departsAt.toISOString(),
    verifiedHuman: active && !!row.user.verifiedHumanAt && !row.user.suspended,
    now: active ? ((await nowFor([latest.userId])).get(latest.userId) ?? null) : null,
  };
}
/** Badges for member lists: trip name, verified human, current Right now. Never wallets. */
export async function tripBadges(userIds: string[], city?: string) {
  const result = new Map<
    string,
    { tripName: string; verifiedHuman: boolean; now: NowRecord | null }
  >();
  if (!userIds.length) return result;
  const db = await getDb();
  const rows = await db
    .select({ trip: s.trips, verifiedHumanAt: s.users.verifiedHumanAt })
    .from(s.trips)
    .innerJoin(s.users, eq(s.trips.userId, s.users.id))
    .where(
      and(
        inArray(s.trips.userId, userIds),
        eq(s.trips.status, "active"),
        gt(s.trips.departsAt, new Date()),
        city ? eq(s.trips.city, city) : undefined,
      ),
    );
  const nows = await nowFor(userIds);
  for (const { trip, verifiedHumanAt } of rows)
    result.set(trip.userId, {
      tripName: trip.ensName,
      verifiedHuman: !!verifiedHumanAt,
      now: nows.get(trip.userId) ?? null,
    });
  return result;
}
export async function expireTrips(now = new Date(), userId?: string) {
  const db = await getDb();
  const due = await db
    .select()
    .from(s.trips)
    .where(
      and(
        inArray(s.trips.status, [...ACTIVE_STATUSES]),
        lte(s.trips.departsAt, now),
        userId ? eq(s.trips.userId, userId) : undefined,
      ),
    )
    .limit(100);
  for (const row of due)
    await applyWrite(null, "trip.expire", row.id, async (tx) => {
      const changed = await tx
        .update(s.trips)
        .set({ status: "expired", updatedAt: new Date() })
        .where(and(eq(s.trips.id, row.id), inArray(s.trips.status, [...ACTIVE_STATUSES])))
        .returning({ id: s.trips.id });
      if (!changed.length) return;
      await tx.update(s.nowPosts).set({ active: false }).where(eq(s.nowPosts.userId, row.userId));
      await enqueueEnsJob(tx, { kind: "trip.expire", signer: "operator", entityId: row.id });
    });
  return due.length;
}
export async function setPayRecord(
  user: s.UserRow,
  body: z.infer<typeof payRecordSchema>,
): Promise<TripDTO> {
  const db = await getDb();
  const trip = await activeTripFor(user.id, body.city);
  invariant(trip, "TRIP_REQUIRED", "Activate a trip first.", 404);
  const wallet = await primaryWallet(user.id, db);
  invariant(wallet, "TRIP_NO_WALLET", "Link a verified wallet first.", 409);
  await applyWrite(user.id, "trip.pay_record", trip.id, async (tx) => {
    await enqueueEnsJob(tx, {
      kind: "record.set",
      signer: "operator",
      entityId: trip.id,
      payload: {
        record: { type: "addr", coinType: OG_COIN_TYPE, address: body.enabled ? wallet : "" },
        store: "payTx",
      },
    });
  });
  await tickEnsWorld();
  return (await myTrip(user, body.city))!;
}
async function primaryWallet(userId: string, db: Database | Tx) {
  const [row] = await db
    .select()
    .from(s.walletLinks)
    .where(eq(s.walletLinks.userId, userId))
    .orderBy(asc(s.walletLinks.verifiedAt))
    .limit(1);
  return row?.address ?? null;
}
async function loadTrip(id: string) {
  const [row] = await (await getDb()).select().from(s.trips).where(eq(s.trips.id, id));
  invariant(row, "NOT_FOUND", "Trip not found.", 404);
  return row;
}
async function failTrip(id: string, code: string) {
  await applyWrite(null, "trip.failed", id, async (tx) => {
    await tx
      .update(s.trips)
      .set({ status: "failed", updatedAt: new Date() })
      .where(and(eq(s.trips.id, id), eq(s.trips.status, "pending_chain")));
  });
  return code;
}
/** Write records through a signer, wait for the receipt, re-read every record, compare. */
export async function writeRecordsProven(signer: Signer, name: string, records: RecordWrite[]) {
  const c = chain();
  const prepared = await ensJobCheckpoint("records.intent", async () => ({
    signer,
    name,
    records,
  }));
  const submission = await ensJobSubmission("records.transaction", () =>
    c.setRecords(prepared.signer, prepared.name, prepared.records),
  );
  const receipt = await c.receipt(submission.hash);
  invariant(receipt.status !== "pending", "PENDING", "Record update not mined yet.", 409);
  const observed: Record<string, string | null> = {};
  for (const record of prepared.records)
    observed[observedKey(record)] =
      record.type === "text"
        ? await c.readText(prepared.name, record.key)
        : await c.readAddr(prepared.name, record.coinType);
  assertChainWriteProof({ submission, receipt, expected: { records: prepared.records }, observed });
  return submission;
}
registerEnsJobHandler("trip.register", async (job) => {
  const trip = await loadTrip(job.entityId);
  if (trip.status !== "pending_chain") return { txHash: trip.chainTx };
  const db = await getDb();
  const wallet = await primaryWallet(trip.userId, db);
  if (!wallet)
    throw new AppError(await failTrip(trip.id, "TRIP_NO_WALLET"), "No verified wallet.", 409);
  const c = chain();
  let registered;
  try {
    registered = await ensJobSubmission("trip.registration", () =>
      c.registerTrip({
        city: trip.city,
        label: trip.label,
        owner: wallet,
        expiry: Math.floor(trip.departsAt.getTime() / 1000),
      }),
    );
  } catch (error) {
    if (error instanceof ChainRevert) await failTrip(trip.id, error.code);
    throw error;
  }
  const receipt = await c.receipt(registered.hash);
  invariant(receipt.status !== "pending", "PENDING", "Registration not mined yet.", 409);
  invariant(receipt.status === "success", "ENS_TX_FAILED", "Registration reverted.", 409);
  assertChainWriteProof({
    submission: registered,
    receipt,
    expected: { records: [] },
    observed: {},
  });
  const state = await c.tripState({ city: trip.city, label: trip.label });
  invariant(
    state.status === "registered" &&
      state.owner?.toLowerCase() === wallet.toLowerCase() &&
      state.expiry === Math.floor(trip.departsAt.getTime() / 1000),
    "ENS_RECORD_MISMATCH",
    "The registered trip owner or expiry did not match the approved trip.",
    409,
  );
  const defaults = defaultTripRecords(config().origin);
  const records: RecordWrite[] = [
    { type: "addr", coinType: ETH_COIN_TYPE, address: wallet },
    {
      type: "text",
      key: "friendship.trip",
      value: JSON.stringify({
        city: trip.city,
        arrivesAt: trip.arrivesAt.toISOString(),
        departsAt: trip.departsAt.toISOString(),
        verifiedHuman: true,
      }),
    },
    { type: "text", key: "avatar", value: defaults.avatar },
    { type: "text", key: "url", value: defaults.url },
    { type: "text", key: "description", value: defaults.description },
    // The shared resolver can outlive a registration. Never inherit an old invitation or pay record.
    { type: "text", key: "friendship.now", value: "" },
    { type: "addr", coinType: OG_COIN_TYPE, address: "" },
  ];
  const written = await writeRecordsProven("operator", trip.ensName, records);
  await applyWrite(null, "trip.registered", trip.id, async (tx) => {
    await tx
      .update(s.trips)
      .set({
        status: "active",
        chainTx: registered.hash,
        recordsTx: written.hash,
        chainVerifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(s.trips.id, trip.id), eq(s.trips.status, "pending_chain")));
  });
  return { txHash: registered.hash };
});
registerEnsJobHandler("trip.renew", async (job) => {
  const trip = await loadTrip(job.entityId);
  if (trip.status !== "active" || trip.departsAt <= new Date()) return { txHash: null };
  const expiry = Number(job.payload.expiry);
  invariant(Number.isFinite(expiry) && expiry > 0, "VALIDATION", "Bad expiry.", 422);
  const c = chain();
  const submission = await ensJobSubmission("trip.renewal", () =>
    c.renewTrip({ city: trip.city, label: trip.label, expiry }),
  );
  const receipt = await c.receipt(submission.hash);
  invariant(receipt.status !== "pending", "PENDING", "Renewal not mined yet.", 409);
  invariant(receipt.status === "success", "ENS_TX_FAILED", "Renewal reverted.", 409);
  assertChainWriteProof({ submission, receipt, expected: { records: [] }, observed: {} });
  const state = await c.tripState({ city: trip.city, label: trip.label });
  invariant(state.expiry >= expiry, "ENS_RECORD_MISMATCH", "Expiry did not extend.", 409);
  await applyWrite(null, "trip.renewed", trip.id, async (tx) => {
    await tx
      .update(s.trips)
      .set({ chainVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(s.trips.id, trip.id));
  });
  return { txHash: submission.hash };
});
registerEnsJobHandler("trip.expire", async (job) => {
  const trip = await loadTrip(job.entityId);
  const c = chain();
  const state = await c.tripState({ city: trip.city, label: trip.label });
  // ENS expires naturally. An old cleanup job must never touch a later registration of the label.
  if (state.status !== "registered" || state.expiry !== Math.floor(trip.departsAt.getTime() / 1000))
    return { txHash: null };
  const owner = await primaryWallet(trip.userId, await getDb());
  if (!owner || state.owner?.toLowerCase() !== owner.toLowerCase()) return { txHash: null };
  const clear: RecordWrite[] = [
    { type: "addr", coinType: ETH_COIN_TYPE, address: "" },
    { type: "text", key: "friendship.trip", value: "" },
    { type: "text", key: "friendship.now", value: "" },
  ];
  const submission = await writeRecordsProven("operator", trip.ensName, clear);
  let last = submission.hash;
  if (state.status === "registered") {
    const latest = await c.tripState({ city: trip.city, label: trip.label });
    if (
      latest.status !== "registered" ||
      latest.expiry !== state.expiry ||
      latest.owner !== state.owner
    )
      return { txHash: last };
    const unregistered = await ensJobSubmission("trip.unregister", () =>
      c.unregisterTrip({ city: trip.city, label: trip.label }),
    );
    const receipt = await c.receipt(unregistered.hash);
    assertChainWriteProof({
      submission: unregistered,
      receipt,
      expected: { records: [] },
      observed: {},
    });
    last = unregistered.hash;
  }
  const current = await c.tripState({ city: trip.city, label: trip.label });
  invariant(
    current.status !== "registered",
    "ENS_RECORD_MISMATCH",
    "The trip is still registered on chain.",
    409,
  );
  return { txHash: last };
});
registerEnsJobHandler("record.set", async (job) => {
  const trip = await loadTrip(job.entityId);
  if (trip.status !== "active" || trip.departsAt <= new Date()) return { txHash: null };
  const current = await chain().tripState({ city: trip.city, label: trip.label });
  const wallet = await primaryWallet(trip.userId, await getDb());
  invariant(
    current.status === "registered" && current.owner?.toLowerCase() === wallet?.toLowerCase(),
    "ENS_RECORD_MISMATCH",
    "This trip no longer owns the ENS registration.",
    409,
  );
  const record = job.payload.record as RecordWrite;
  const signer = (job.signer === "concierge" ? "concierge" : "operator") as Signer;
  const submission = await writeRecordsProven(signer, trip.ensName, [record]);
  const store = job.payload.store === "payTx" ? "payTx" : "nowTx";
  await applyWrite(null, "trip.record", trip.id, async (tx) => {
    await tx
      .update(s.trips)
      .set({
        [store]: submission.hash,
        ...(record.type === "addr"
          ? { payAddress: record.address === "" ? null : record.address.toLowerCase() }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(s.trips.id, trip.id));
  });
  return { txHash: submission.hash };
});
