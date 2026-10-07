import { createHash } from "crypto";
import mongoose from "mongoose";
import {setTimeout, clearTimeout} from "timers";
import db from "../db";

// Hash encrypted recovery records plus the retained account mutation generation.
// Transport ordering and unrelated Mongoose metadata do not affect the token.
const canonical = (value: any): string => {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};
export class InvalidBackupRequest extends Error {}
export class BackupUpgradeRequired extends Error {
  constructor() { super("Update the app before replacing this backup"); }
}
export class BackupConflict extends Error {
  constructor() { super("Backup changed; check it again before updating"); }
}

async function accountVaultImages(appId: string, vaultIds: string[], session: mongoose.ClientSession) {
  const scoped = await db.getAppVaultImageModel().find({ appId, vaultId: { $in:vaultIds } }).session(session).lean() as any[];
  const resolved = new Map(scoped.map(v => [v.vaultId, v]));
  const missing = Array.from(new Set(vaultIds)).filter(id => !resolved.has(id));
  // Never return a collaborator's encrypted image as another account's backup.
  const legacy = await db.getVaultImageModel().find({ appId, vaultId: { $in:missing } }).session(session).lean() as any[];
  for (const image of legacy) resolved.set(image.vaultId, image);
  return {
    allVaultImages: scoped.concat(legacy),
    unavailableVaultIds: missing.filter(id => !resolved.has(id)).sort(),
  };
}

async function snapshot(appId: string, session: mongoose.ClientSession) {
  const app = await db.getAppImageModel().findOne({ appId }).session(session).lean() as any;
  const uniqueIds = (ids: string[]) => {
    if (!Array.isArray(ids)) return ids;
    const seen = new Set<string>();
    return ids.filter(id => {if (seen.has(id)) return false; seen.add(id); return true;});
  };
  // Mongoose's default minimization can omit valid empty maps. Normalize only
  // absent fields; malformed stored values remain visible to validation.
  const appImage = app ? {...app,
    wallets:app.wallets === undefined ? {} : app.wallets,
    signers:app.signers === undefined ? {} : app.signers,
    nodes:app.nodes === undefined ? [] : app.nodes,
    vaults:uniqueIds(app.vaults === undefined ? [] : app.vaults),
    labels:uniqueIds(app.labels === undefined ? [] : app.labels),
  } : { appId, wallets: {}, signers: {}, nodes: [], vaults: [], labels: [] };
  const vaultIds = appImage.vaults || [];
  const labelIds = appImage.labels || [];
  const { allVaultImages, unavailableVaultIds } = await accountVaultImages(appId, vaultIds, session);
  const labels = await db.getLabelModel().find({ id: { $in: labelIds } }).session(session).lean() as any[];
  if (new Set(labelIds).size !== labels.length) {
    throw new Error("Incomplete backup; no replacement was made");
  }
  const records = {
    appId, generation: app ? {identity:String(app._id),version:app.backupGeneration || 0} : null,
    wallets: appImage.wallets || {}, signers: appImage.signers || {}, nodes: appImage.nodes || [],
    vaults: allVaultImages.map(v => ({ vaultId: v.vaultId, vault: v.vault, appId: v.appId, isArchived: !!v.isArchived })).sort((a,b) => a.vaultId.localeCompare(b.vaultId)),
    unavailableVaultIds,
    labels: labels.map(l => ({ id:l.id, content:l.content })).sort((a,b) => a.id.localeCompare(b.id)),
  };
  const revision = createHash("sha256").update(canonical(records)).digest("hex");
  return { appImage, allVaultImages, unavailableVaultIds, labels, revision, exists: !!app };
}

let scopedVaultInitialization: Promise<unknown>;
let retryScopedVaultIndex = false;
async function initializeScopedVaults() {
  if (!scopedVaultInitialization) {
    const model = db.getAppVaultImageModel();
    // Mongoose 5 caches a rejected init promise. Retry the required unique index
    // through the public collection API after an initialization failure.
    scopedVaultInitialization = Promise.resolve().then(async () => {
      if (!retryScopedVaultIndex) await model.init();
      // Explicitly require uniqueness even when autoIndex is disabled.
      await model.collection.createIndex({appId:1,vaultId:1}, {unique:true,maxTimeMS:15000} as any);
    });
  }
  const attempt = scopedVaultInitialization;
  let deadline: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([attempt, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("Backup storage initialization unavailable")), 15000);
    })]);
  } catch (error) {
    if (scopedVaultInitialization === attempt) {
      scopedVaultInitialization = undefined;
      retryScopedVaultIndex = true;
    }
    throw error;
  } finally {clearTimeout(deadline);}
}

async function inTransaction<T>(work: (session: mongoose.ClientSession) => Promise<T>) {
  await initializeScopedVaults();
  const session = await mongoose.startSession();
  let result: T;
  try {
    await session.withTransaction(async () => { result = await work(session); }, {
      readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 15000,
    });
    return result;
  } finally { await session.endSession(); }
}

async function advanceBackupGeneration(appId: string, session: mongoose.ClientSession) {
  await db.getAppImageModel().updateOne({appId}, {$inc:{backupGeneration:1}}, {session});
}

// Legacy incremental writes also share the transaction/generation boundary.
export async function withBackupMutation<T>(appId: string, work: (session: mongoose.ClientSession) => Promise<T>) {
  assertAccountId(appId);
  return inTransaction(async session => {
    const result = await work(session);
    if (result !== false && (!result || (result as any).updated !== false)) await advanceBackupGeneration(appId, session);
    return result;
  });
}

function assertAccountId(appId: unknown): asserts appId is string {
  if (typeof appId !== "string" || !appId) throw new InvalidBackupRequest("Invalid backup account");
}

export async function getBackupSnapshot(appId: string) {
  assertAccountId(appId);
  return inTransaction(session => snapshot(appId, session));
}

// Generic restore must be complete. Only explicit, revisioned local resubmission
// may fill unavailable images reported by getBackupSnapshot.
export async function getAppBackupVaultImages(appId: string, vaultIds: string[]) {
  assertAccountId(appId);
  return inTransaction(async session => {
    const result = await accountVaultImages(appId, vaultIds, session);
    if (result.unavailableVaultIds.length) throw new Error("Incomplete backup; no replacement was made");
    return result.allVaultImages;
  });
}

// Incremental deletion removes only the requested IDs. Never save a previously
// read wallet/key map: a delayed deletion must preserve a newer repair or save.
export async function deleteBackupEntities(appId: string, wallets?: string[], signers?: string[]) {
  if (typeof appId !== "string" || !appId) throw new InvalidBackupRequest("Invalid backup account");
  const safeIds = (ids: unknown) => ids == null || (Array.isArray(ids) && ids.every(id =>
    typeof id === "string" && id.length > 0 && id.length <= 512 && !/[.$]/.test(id) &&
    !["__proto__", "constructor", "prototype"].includes(id)
  ));
  if (!safeIds(wallets) || !safeIds(signers)) throw new InvalidBackupRequest("Invalid backup record IDs");
  return inTransaction(async session => {
    const app = await db.getAppImageModel().findOne({ appId }).session(session).lean();
    if (!app) return { updated: false, error: "No app image" };
    const removals: Record<string, string> = {};
    for (const id of wallets || []) removals[`wallets.${id}`] = "";
    for (const id of signers || []) removals[`signers.${id}`] = "";
    if (Object.keys(removals).length) {
      const result = await db.getAppImageModel().updateOne({ appId }, { $unset: removals }, { session });
      if (result.modifiedCount) await advanceBackupGeneration(appId, session);
    }
    return { updated: true, error: "" };
  });
}

const validRecordId = (id: unknown): id is string => typeof id === "string" && id.length > 0 &&
  id.length <= 512 && !/[.$]/.test(id) && !["__proto__", "constructor", "prototype"].includes(id);

function assertVaultSigners(signers: any[]) {
  if (!Array.isArray(signers) || signers.some(s => !s || !validRecordId(s.signerId) ||
      typeof s.xfpHash !== "string" || !s.xfpHash)) throw new InvalidBackupRequest("Invalid vault signers");
}

async function writeVaultMaps(signers: any[], vaultId: string, session: mongoose.ClientSession) {
  for (const signer of signers) {
    await db.getVaultMapModel().updateOne({ signerId: signer.signerId }, {
      $set: { signerId: signer.signerId, xfpHash: signer.xfpHash, vaultId },
    }, { upsert: true, session });
  }
}

function vaultFields(image: any) {
  return { vault:image.vault, signerIds:image.signerIds || [], isArchived:!!image.isArchived,
    ...(image.vaultShellId ? {vaultShellId:image.vaultShellId} : {}),
    ...(image.scheme ? {scheme:image.scheme} : {}),
  };
}

async function writeVaultImage(appId: string, vaultId: string, fields: any, session: mongoose.ClientSession) {
  await db.getAppVaultImageModel().updateOne({ appId, vaultId }, {
    $set:{ appId, vaultId, ...fields },
  }, {upsert:true, session});
  const legacy = await db.getVaultImageModel().findOne({ vaultId }).session(session).lean() as any;
  if (!legacy || !legacy.appId || legacy.appId === appId) {
    await db.getVaultImageModel().updateOne({ vaultId }, {
      $set:{ appId, vaultId, ...fields }, ...(legacy ? {$inc:{__v:1}} : {}),
    }, {upsert:true, session});
  } else {
    // The global image remains a legacy discovery record. Touch its version to
    // serialize shared membership changes without replacing peer ciphertext.
    await db.getVaultImageModel().updateOne({ vaultId }, {$inc:{__v:1}}, {session});
  }
}

async function clearVaultMapsIfUnshared(appId: string, vaultId: string, session: mongoose.ClientSession) {
  const peers = await db.getAppImageModel().find({appId:{$ne:appId},vaults:vaultId}).session(session).lean() as any[];
  for (const peer of peers) {
    const images = await accountVaultImages(peer.appId, [vaultId], session);
    if (images.allVaultImages.some(image => !image.isArchived)) return;
  }
  await db.getVaultMapModel().deleteMany({vaultId}).session(session);
}

async function removeAccountVaults(appId: string, vaultIds: string[], session: mongoose.ClientSession) {
  for (const vaultId of Array.from(new Set(vaultIds))) {
    const legacy = await db.getVaultImageModel().findOne({vaultId}).session(session).lean();
    // A real common-document write makes simultaneous participant unlinks retry
    // before deciding whether the final global lookup/image can be removed.
    if (legacy) await db.getVaultImageModel().updateOne({vaultId}, {$inc:{__v:1}}, {session});
    const other = await db.getAppImageModel().findOne({appId:{$ne:appId},vaults:vaultId}).session(session).lean();
    await clearVaultMapsIfUnshared(appId, vaultId, session);
    if (!other) {
      await db.getVaultImageModel().deleteMany({vaultId}).session(session);
    }
  }
  await db.getAppVaultImageModel().deleteMany({appId,vaultId:{$in:vaultIds}}).session(session);
}

export async function createBackupVaultMap(signers: any[], vaultId: string) {
  if (!validRecordId(vaultId)) throw new InvalidBackupRequest("Invalid vault ID");
  assertVaultSigners(signers);
  return inTransaction(async session => {
    const vault = await db.getVaultImageModel().findOne({ vaultId }).session(session).lean();
    if (!vault) throw new InvalidBackupRequest("No vault image");
    await db.getVaultImageModel().updateOne({vaultId}, {$inc:{__v:1}}, {session});
    await writeVaultMaps(signers, vaultId, session);
    await db.getAppImageModel().updateMany({vaults:vaultId}, {$inc:{backupGeneration:1}}, {session});
  });
}

async function archiveBackupVaultInSession(vaultId: string, session: mongoose.ClientSession, appId?: string) {
  const legacy = await db.getVaultImageModel().findOne({vaultId}).session(session).lean() as any;
  if (!appId) {
    const references = await db.getAppImageModel().find({vaults:vaultId}).session(session).lean() as any[];
    if (!legacy || references.length !== 1 || references[0].appId !== legacy.appId) return false;
  }
  appId = appId || legacy?.appId;
  if (!appId) return false;
  const result = await accountVaultImages(appId, [vaultId], session);
  const existing = result.allVaultImages[0];
  if (!existing) return false;
  await writeVaultImage(appId, vaultId, {...vaultFields(existing),isArchived:true}, session);
  await clearVaultMapsIfUnshared(appId, vaultId, session);
  await advanceBackupGeneration(appId, session);
  return true;
}

export async function archiveBackupVault(vaultId: string) {
  if (!validRecordId(vaultId)) throw new InvalidBackupRequest("Invalid vault ID");
  return inTransaction(session => archiveBackupVaultInSession(vaultId, session));
}

// Compatible incremental writer: membership, encrypted image, archive change
// and signer lookups commit together. Repeated saves do not duplicate IDs.
export async function saveBackupVault(data: any) {
  if (!validRecordId(data.vaultId)) throw new InvalidBackupRequest("Invalid vault ID");
  if (data.isArchived !== undefined && typeof data.isArchived !== "boolean") throw new InvalidBackupRequest("Invalid archive state");
  if (data.signersData != null) assertVaultSigners(data.signersData);
  if (data.archiveVaultId != null && (!validRecordId(data.archiveVaultId) || data.archiveVaultId === data.vaultId))
    throw new InvalidBackupRequest("Invalid archived vault ID");
  return inTransaction(async session => {
    const legacy = await db.getVaultImageModel().findOne({vaultId:data.vaultId}).session(session).lean() as any;
    if (!data.appId) {
      const references = await db.getAppImageModel().find({vaults:data.vaultId}).session(session).lean() as any[];
      if (!legacy || references.length !== 1 || references[0].appId !== legacy.appId) throw new BackupUpgradeRequired();
    }
    const appId = data.appId || legacy?.appId;
    if (typeof appId !== "string" || !appId) throw new InvalidBackupRequest("Backup account missing");
    const existing = (await accountVaultImages(appId, [data.vaultId], session)).allVaultImages[0];
    if (data.isUpdate && !existing) return {updated:false,error:"No vault image"};
    const app = await db.getAppImageModel().findOne({ appId }).session(session).lean();
    if (!app) return { updated: false, error: "No app image" };
    const encryptedVault = data.vault || existing?.vault;
    if (typeof encryptedVault !== "string" || !encryptedVault) throw new InvalidBackupRequest("Invalid encrypted vault");
    const signersData = data.signersData ?? (existing ? undefined : []);
    if (data.archiveVaultId && !await archiveBackupVaultInSession(data.archiveVaultId, session, appId))
      throw new InvalidBackupRequest("No archived vault image");
    const isArchived = data.isArchived ?? !!existing?.isArchived;
    await writeVaultImage(appId, data.vaultId, {
      ...(existing ? vaultFields(existing) : {}), vault:encryptedVault, isArchived,
      ...(signersData !== undefined ? { signerIds: signersData.map(s => s.signerId) } : {}),
      ...(data.vaultShellId ? { vaultShellId: data.vaultShellId } : {}),
      ...(data.scheme ? { scheme: data.scheme } : {}),
    }, session);
    if (isArchived) await clearVaultMapsIfUnshared(appId, data.vaultId, session);
    else if (signersData !== undefined) await writeVaultMaps(signersData, data.vaultId, session);
    await db.getAppImageModel().updateOne({ appId }, { $addToSet: { vaults: data.vaultId } }, { session });
    await advanceBackupGeneration(appId, session);
    return { updated: true, error: "" };
  });
}

export async function deleteBackupVaults(appId: string, vaultIds: string[]) {
  if (typeof appId !== "string" || !appId || !Array.isArray(vaultIds) || vaultIds.some(id => !validRecordId(id)))
    throw new InvalidBackupRequest("Invalid vault deletion");
  return withBackupMutation(appId, async session => {
    const app = await db.getAppImageModel().findOne({ appId }).session(session).lean() as any;
    if (!app) return { updated: false, error: "No app image" };
    const owned = await db.getAppVaultImageModel().find({ appId, vaultId: { $in: vaultIds } }).session(session).lean() as any[];
    // Unlink the caller's shared membership, retaining global records that
    // another participant still references. Also clean the caller's own orphans.
    const requested = new Set(vaultIds);
    const authorizedIds = Array.from(new Set([
      ...(app.vaults || []).filter((id: string) => requested.has(id)), ...owned.map(v => v.vaultId),
    ])) as string[];
    await removeAccountVaults(appId, authorizedIds, session);
    await db.getAppImageModel().updateOne({ appId }, { $pull: { vaults: { $in: vaultIds } } }, { session });
    return { updated: true };
  });
}

// The user's explicit "Delete" choice clears the encrypted backup while
// retaining the app identity and subscription record. All related records
// change together, so a failed delete cannot leave a partial backup behind.
export async function deleteAppBackup(appId: string) {
  if (typeof appId !== "string" || !appId) throw new InvalidBackupRequest("Invalid backup account");
  return withBackupMutation(appId, async session => {
    const app = await db.getAppImageModel().findOne({ appId }).session(session).lean() as any;
    if (!app) throw new InvalidBackupRequest("No backup found");
    const vaultIds: string[] = app.vaults || [];
    const labelIds: string[] = app.labels || [];
    await removeAccountVaults(appId, vaultIds, session);
    await db.getAppVaultImageModel().deleteMany({appId}).session(session);
    for (const id of labelIds) {
      const otherOwner = await db.getAppImageModel().findOne({
        appId: { $ne: appId }, labels: id,
      }).session(session).lean();
      if (!otherOwner) await db.getLabelModel().deleteOne({ id }).session(session);
    }
    await db.getAppImageModel().updateOne({ appId }, { $set: {
      wallets: {}, signers: {}, nodes: [], vaults: [], labels: [],
    } }, { session });
    return { updated: true, error: "" };
  });
}

function assertPayload(data: any) {
  const map = (value: any) => value && typeof value === "object" && !Array.isArray(value);
  const safeId = (id: string) => id.length > 0 && id.length <= 512 && !/[.$]/.test(id) && !["__proto__", "constructor", "prototype"].includes(id);
  if (!data || typeof data.appId !== "string" || !data.appId || typeof data.publicId !== "string" || !data.publicId || typeof data.version !== "string" ||
      !/^[a-f0-9]{64}$/.test(data.expectedRevision) || !map(data.walletObject) || !map(data.signersObject) ||
      !map(data.vaultObject) || !Array.isArray(data.nodes) || !Array.isArray(data.labels) ||
      (data.replaceCurrentState !== undefined && typeof data.replaceCurrentState !== "boolean")) throw new InvalidBackupRequest("Invalid backup request");
  for (const records of [data.walletObject,data.signersObject]) {
    if (Object.entries(records).some(([id,value]) => !safeId(id) || typeof value !== "string" || !value)) throw new InvalidBackupRequest("Invalid encrypted record");
  }
  if (data.nodes.some(n => typeof n !== "string" || !n)) throw new InvalidBackupRequest("Invalid encrypted node");
  if (data.labels.some(l => !l || typeof l.id !== "string" || !safeId(l.id) || typeof l.content !== "string" || !l.content) ||
      new Set(data.labels.map(l => l.id)).size !== data.labels.length) throw new InvalidBackupRequest("Invalid encrypted labels");
  for (const [id,v] of Object.entries(data.vaultObject) as [string,any][]) {
    if (!safeId(id) || !v || typeof v !== "object" || Array.isArray(v) || v.vaultId !== id || typeof v.vault !== "string" || !v.vault || typeof v.isArchived !== "boolean" ||
        !Array.isArray(v.signersData) || v.signersData.some(s => !s || typeof s.signerId !== "string" || !safeId(s.signerId) || (typeof s.xfpHash !== "string" || !s.xfpHash))) throw new InvalidBackupRequest("Invalid encrypted vault");
  }
}

// This endpoint never silently falls back to the legacy destructive replacement.
// Transactions atomically update the referenced records and app image. On a
// concurrent-write retry, the token is checked again against the new snapshot.
export async function repairAppBackup(data: any) {
  return writeBackup(data, false);
}

async function writeBackup(data: any, legacy: boolean) {
  assertPayload(data);
  return withBackupMutation(data.appId, async session => {
    const current = await snapshot(data.appId, session);
    if (legacy && current.appImage.backupRevisionRequired) throw new BackupUpgradeRequired();
    if (current.revision !== data.expectedRevision) throw new BackupConflict();
    const includesAll = (oldIds: string[], newIds: string[]) => oldIds.every(id => newIds.includes(id));
    // Only an explicit, revisioned repair may remove records. Old full writers
    // still fail closed, including transaction retries after a newer repair.
    if ((legacy || data.replaceCurrentState !== true) &&
       (!includesAll(Object.keys(current.appImage.wallets || {}), Object.keys(data.walletObject)) ||
        !includesAll(Object.keys(current.appImage.signers || {}), Object.keys(data.signersObject)) ||
        !includesAll(current.appImage.vaults || [], Object.keys(data.vaultObject)) ||
        !includesAll(current.appImage.labels || [], data.labels.map(l => l.id)))) throw new BackupConflict();
    const removedVaultIds = (current.appImage.vaults || []).filter((id: string) => !data.vaultObject[id]);
    const newLabelIds = new Set(data.labels.map((l: any) => l.id));
    const removedLabelIds = (current.appImage.labels || []).filter((id: string) => !newLabelIds.has(id));
    if (removedVaultIds.length) {
      await removeAccountVaults(data.appId, removedVaultIds, session);
    }
    for (const id of removedLabelIds) {
      const otherOwner = await db.getAppImageModel().findOne({
        appId: { $ne:data.appId }, labels:id,
      }).session(session).lean();
      if (!otherOwner) await db.getLabelModel().deleteOne({ id }).session(session);
    }
    for (const [vaultId,v] of Object.entries(data.vaultObject) as [string,any][]) {
      await writeVaultImage(data.appId, vaultId, {
        vault:v.vault, signerIds:v.signersData.map(s => s.signerId), isArchived:v.isArchived,
        ...(v.scheme ? {scheme:v.scheme} : {}),
        ...(typeof v.vaultShellId === "string" ? {vaultShellId:v.vaultShellId} : {}),
      }, session);
      if (v.isArchived) await clearVaultMapsIfUnshared(data.appId, vaultId, session);
    }
    // Write active maps after archived-map removal so iteration order cannot
    // erase the replacement wallet's lookup entries.
    for (const [vaultId,v] of Object.entries(data.vaultObject) as [string,any][]) {
      if (!v.isArchived) for (const signer of v.signersData) {
        await db.getVaultMapModel().updateOne({ signerId:signer.signerId }, { $set:{ ...signer,vaultId } }, {upsert:true,session});
      }
    }
    for (const label of data.labels) {
      const otherOwner = await db.getAppImageModel().findOne({
        appId: { $ne:data.appId }, labels:label.id,
      }).session(session).lean();
      if (otherOwner) throw new BackupConflict();
      await db.getLabelModel().updateOne({ id:label.id }, { $set:{ content:label.content } }, {upsert:true,session});
    }
    // Updating this document also makes concurrent membership edits conflict
    // with the transaction instead of being lost in a full-snapshot write.
    await db.getAppImageModel().updateOne({ appId:data.appId }, { $set:{
      wallets:data.walletObject, signers:data.signersObject, nodes:data.nodes,
      vaults:Object.keys(data.vaultObject), labels:data.labels.map(l => l.id), version:data.version,
      ...(!legacy ? { backupRevisionRequired:true } : {}),
    }, $setOnInsert:{ appId:data.appId, publicId:data.publicId, subscription:data.subscription } }, {upsert:true,session});
    return { updated:true };
  });
}

// Old clients have no revision token. Read their starting state, preserve archive
// metadata they do not send, then use the same atomic writer. The writer checks
// the upgrade marker inside the transaction, including concurrent-write retries.
// Omitting server-only records fails closed instead of deleting recoverable data.
export async function backupLegacyApp(data: any) {
  if (!data || typeof data.appId !== "string" || !data.appId) throw new InvalidBackupRequest("Invalid backup account");
  const current = await getBackupSnapshot(data.appId);
  if (current.appImage.backupRevisionRequired) throw new BackupUpgradeRequired();
  if (current.unavailableVaultIds.length) throw new BackupConflict();
  const vaultObject = Object.create(null);
  for (const [id, value] of Object.entries(data.vaultObject || {}) as [string, any][]) {
    vaultObject[id] = { ...value, vaultId:id,
      isArchived: !!current.allVaultImages.find(v => v.vaultId === id)?.isArchived };
  }
  return writeBackup({ ...data, expectedRevision:current.revision, vaultObject,
    publicId:data.publicId || current.appImage.publicId,
    version:data.version || current.appImage.version,
    walletObject:data.walletObject || current.appImage.wallets || {},
    signersObject:data.signersObject || current.appImage.signers || {},
    nodes:data.nodes || current.appImage.nodes || [], labels:data.labels || [],
  }, true);
}
