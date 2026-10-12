import {
  backupLegacyApp,
  deleteAppBackup,
  deleteBackupEntities,
  saveBackupVault,
  createBackupVaultMap,
  archiveBackupVault,
  deleteBackupVaults,
  getBackupSnapshot,
  withBackupMutation,
  BackupConflict,
  BackupUpgradeRequired,
  InvalidBackupRequest,
} from "./backupSnapshot";
import { AppImage, AppSubscription } from "../interface";
import db from "../db";
import { getAppSubscriptionDetails } from "./app";
import { getPlans } from "../utils/plans";

export const updateAppImage = async (
  appId,
  publicId,
  walletObject,
  subscription,
  version,
  signersObject,
  nodes,
  replaceNodes = false,
  expectedRevision?: string
): Promise<{ updated: boolean; error?: string }> => {
  if (typeof appId !== "string" || !appId) return {updated:false,error:"Invalid backup account"};
  const appImageModel: any = db.getAppImageModel();
  try {
    return await withBackupMutation(appId, async session => {
      if (replaceNodes === true && (!Array.isArray(nodes) || nodes.some(node => typeof node !== "string" || !node))) {
        return { updated: false, error: "Invalid encrypted nodes" };
      }
      const appImage = await appImageModel.findOne({ appId }).session(session);
      if (appImage && walletObject) {
        const appSubscription = await getAppSubscriptionDetails(appId);
        if (appSubscription && !isAllowedToUpdate(appSubscription, appImage, walletObject)) {
          return { updated: false, error: "Your current subscription plan does not allow to add more wallets" };
        }
      }
      // Set individual records atomically. A delayed incremental save must not
      // replace wallets/signers added by a concurrent repair or another device.
      const changes: any = {};
      if (publicId) changes.publicId = publicId;
      if (subscription) changes.subscription = subscription;
      if (version) changes.version = version;
      // Legacy clients attach [] to unrelated wallet/key updates. Only explicit
      // node replacement may clear the list; preserve legacy nonempty updates.
      if (Array.isArray(nodes) && (replaceNodes === true || nodes.length)) changes.nodes = nodes;
      for (const [kind, records] of [["wallets", walletObject], ["signers", signersObject]] as any[]) {
        for (const [id, value] of Object.entries(records || {})) {
          if (!id || /[.$]/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) {
            return { updated:false, error:"Invalid backup record ID" };
          }
          changes[`${kind}.${id}`] = value;
        }
      }
      const defaults: any = { appId };
      if (!walletObject || !Object.keys(walletObject).length) defaults.wallets = {};
      if (!signersObject || !Object.keys(signersObject).length) defaults.signers = {};
      if (!changes.nodes) defaults.nodes = [];
      if (!appImage && (!publicId || !version)) return { updated:false, error:"Backup account missing" };
      // Old createNewApp records used [] for empty maps. Convert only empty
      // containers in this transaction before setting a per-record dotted path.
      const emptyLegacyMaps: any = {};
      for (const kind of ["wallets", "signers"]) {
        if (Array.isArray(appImage?.[kind]) && appImage[kind].length === 0) emptyLegacyMaps[kind] = {};
      }
      if (Object.keys(emptyLegacyMaps).length) await appImageModel.updateOne({appId}, {$set:emptyLegacyMaps}, {session});
      if (Object.keys(changes).length) {
        await appImageModel.updateOne({ appId }, { $set:changes, $setOnInsert:defaults }, { upsert:true,runValidators:true,session });
      }
      return { updated:true,error:"" };
    }, expectedRevision, true);
  } catch (error) {
    if (error instanceof BackupConflict || (expectedRevision !== undefined && error instanceof BackupUpgradeRequired)) throw error;
    return { updated:false,error:"Backup update failed" };
  }
};

export const deleteAppImageEntity = async (
  appId,
  wallets,
  signers,
  expectedRevision?: string
): Promise<{ updated: boolean; error?: string }> => {
  try {
    return await deleteBackupEntities(appId, wallets, signers, expectedRevision);
  } catch (error) {
    if (error instanceof BackupConflict || (expectedRevision !== undefined && error instanceof BackupUpgradeRequired)) throw error;
    return { updated: false, error: "Backup deletion failed" };
  }
};

export const deleteVaults = async (appId, vaults, expectedRevision?: string) => {
  try {
    return await deleteBackupVaults(appId, vaults, expectedRevision);
  } catch (error) {
    if (error instanceof BackupConflict || (expectedRevision !== undefined && error instanceof BackupUpgradeRequired)) throw error;
    return { updated: false, error: "Vault backup deletion failed" };
  }
};

const isAllowedToUpdate = (
  appSubscription: AppSubscription,
  appImage: AppImage,
  walletObject: object
): boolean => {
  // if (isCreatingNewWallet(walletObject, appImage)) {
  //   if (appSubscription.level === AppSubscriptionLevel.ONE) {
  //     if (Object.keys(appImage.wallets).length >= 3) {
  //       return false;
  //     }
  //   }
  // }
  return true;
};

const isCreatingNewWallet = (
  walletObject: object,
  appImage: AppImage
): boolean => {
  let isCreatingNewWallet = true;
  Object.keys(walletObject).forEach((wallet) => {
    if (appImage.wallets && appImage.wallets[wallet]) {
      isCreatingNewWallet = false;
    }
  });
  return isCreatingNewWallet;
};

export const createVaultMap = createBackupVaultMap;

export const addVaultImage = async (
  appId,
  vaultShellId,
  vaultId,
  scheme,
  vault,
  signersData,
  subscription,
  archiveVaultId?,
  isArchived?,
  expectedRevision?: string
) => {
  try {
    return await saveBackupVault({
      appId,
      vaultShellId,
      vaultId,
      scheme,
      vault,
      signersData,
      subscription,
      archiveVaultId,
      isArchived,
      expectedRevision,
    });
  } catch (error) {
    if (error instanceof BackupConflict || (expectedRevision !== undefined && error instanceof BackupUpgradeRequired)) throw error;
    return { updated: false, error: "Vault backup update failed" };
  }
};

export const archiveVault = async (vaultId) => {
  try {
    return await archiveBackupVault(vaultId);
  } catch {
    return false;
  }
};

export const updateVault = async (vaultId, vault, appId?, isArchived?, signersData?, expectedRevision?: string) => {
  try {
    const result = await saveBackupVault({
      appId,
      vaultId,
      vault,
      isArchived,
      signersData,
      isUpdate: true,
      expectedRevision,
    });
    return result?.updated ? {} : false;
  } catch (error) {
    if (error instanceof BackupConflict || (expectedRevision !== undefined && error instanceof BackupUpgradeRequired)) throw error;
    return false;
  }
};

const isLookupIdentifier = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const getSignerIdInfo = async (signerId) => {
  if (!isLookupIdentifier(signerId)) return false;
  const vaultMapModel: any = db.getVaultMapModel();
  const [vaultMap] = await vaultMapModel.find({ signerId });
  if (!vaultMap) {
    console.log("no vaultMap for signer id");
    return false;
  } else {
    return true;
  }
};

export const getVaultMetaData = async (xfpHash, signerId) => {
  if (
    !isLookupIdentifier(xfpHash) ||
    (signerId !== undefined && !isLookupIdentifier(signerId))
  ) {
    return { error: "No Vault for this signer Id" };
  }
  const vaultMapModel: any = db.getVaultMapModel();
  let vault;
  if (signerId) {
    const [vaultMap] = await vaultMapModel.find({ xfpHash });
    vault = vaultMap;
  } else {
    const [vaultMap] = await vaultMapModel.find({ xfpHash });
    vault = vaultMap;
  }
  if (!vault) {
    return {
      error: "No Vault for this signer Id",
    };
  } else {
    const vaultMetaData = await getVaultImage(vault.vaultId);
    return {
      appId: vaultMetaData.appId,
      vaultShellId: vaultMetaData.vaultShellId,
    };
  }
};

export const getVaultImage = async (vaultId) => {
  if (!isLookupIdentifier(vaultId)) return;
  const vaultImageModel: any = db.getVaultImageModel();
  const [vaultImage] = await vaultImageModel.find({ vaultId });
  if (!vaultImage) {
    console.log("no vaultImage");
    return;
  } else {
    return vaultImage;
  }
};

export const getAppImage = async (appId, appversion) => {
  const snapshot = await getBackupSnapshot(appId);
  if (snapshot.unavailableVaultIds.length) throw new Error("Recovery data unavailable");
  const appImage = snapshot.exists
    ? snapshot.appImage
    : { ...snapshot.appImage, version: appversion };
  let vaultImage;
  const vaultIds = appImage.vaults || [];
  const availableVaultImages = snapshot.allVaultImages;
  const vaultsById = new Map<string, any>();
  for (const image of availableVaultImages) vaultsById.set(image.vaultId, image);
  const allVaultImages = [];
  for (const vaultId of vaultIds) {
    const image = vaultsById.get(vaultId);
    if (!image) throw new Error("Recovery data unavailable");
    if (!image.isArchived) vaultImage = image;
    allVaultImages.push(image);
  }
  const subscription = await getAppSubscriptionDetails(appId, true);
  const plan = getPlans().find((plan) => plan.level === subscription.level);
  return {
    appImage,
    vaultImage,
    labels: snapshot.labels,
    subscription: {
      level: subscription.level,
      name: plan.name,
      productId: subscription.productId,
      receipt: subscription.transactionReceipt,
      icon: plan.icon,
      isValid: !subscription.isCancelled,
      isCancelled: subscription.isCancelled,
    },
    allVaultImages,
  };
};

export const vaultCheck = async (vaultId) => {
  if (!isLookupIdentifier(vaultId)) return { isVault: false };
  try {
    const vaultImageModel: any = db.getVaultImageModel();
    const [vaultImage] = await vaultImageModel.find({ vaultId });
    if (vaultImage) {
      if (!vaultImage.isArchived) {
        return {
          isVault: true,
        };
      } else {
        return {
          isVault: false,
        };
      }
    } else {
      return {
        isVault: false,
      };
    }
  } catch (err) {
    return {
      isVault: false,
    };
  }
};

interface SignerChange {
  oldSignerId: string;
  newSignerId: string;
  newSignerDetails: string;
}

export const migrateXfp = async (
  appId: string,
  signerChanges: SignerChange[],
  expectedRevision?: string
) => {
  try {
    return await withBackupMutation(appId, async session => {
      const appImageModel: any = db.getAppImageModel();
      const [appImage] = await appImageModel.find({ appId }).session(session);
      let signersObject = { ...appImage?.signers };
      if (appImage) {
        for (const change of signerChanges) {
          if (signersObject[change.oldSignerId] !== undefined) {
            delete signersObject[change.oldSignerId];
          }
          signersObject[change.newSignerId] = change.newSignerDetails;
        }
        appImage.signers = signersObject;
        await appImage.save({session});
        return true;
      } else {
        return false;
      }
    }, expectedRevision, true);
  } catch (err) {
    if (err instanceof BackupConflict || (expectedRevision !== undefined && err instanceof BackupUpgradeRequired)) throw err;
    console.log(err);
    return false;
  }
};

export const modifyLabels = async (appId, addLabels, deleteLabels, expectedRevision?: string) => {
  try {
    return await withBackupMutation(appId, async session => {
      const appImageModel: any = db.getAppImageModel();
      const labelModel: any = db.getLabelModel();
      let appImage = await appImageModel.findOne({ appId }).session(session);

      if (!appImage) {
        throw new Error("App not found");
      }

      if (addLabels && addLabels.length > 0) {
        const newLabels = [];
        for (const label of addLabels) {
          if (!label || typeof label.id !== "string" || !label.id || /[.$]/.test(label.id) ||
              typeof label.content !== "string" || !label.content)
            throw new InvalidBackupRequest("Invalid encrypted label");
          const otherOwner = await appImageModel.findOne({
            appId: {$ne:appId}, labels:label.id,
          }).session(session).lean();
          if (otherOwner) throw new BackupConflict();
          const existingLabel = await labelModel.findOne({ id: label.id }).session(session);
          if (existingLabel) {
            await labelModel.updateOne({id:label.id}, {$set:{content:label.content}}, {session});
            newLabels.push(existingLabel.id);
          } else {
            const createdLabels = await labelModel.create([label], {session});
            newLabels.push(createdLabels[0].id);
          }
        }

        appImage.labels = appImage.labels || [];
        for (const id of newLabels) if (!appImage.labels.includes(id)) appImage.labels.push(id);
        await appImage.save({session});
      }

      if (deleteLabels && deleteLabels.length > 0) {
        if (!Array.isArray(deleteLabels) || deleteLabels.some(id =>
            typeof id !== "string" || !id || /[.$]/.test(id)))
          throw new InvalidBackupRequest("Invalid encrypted label IDs");
        const owned = new Set((appImage.labels || []).map(id => id.toString()));
        const removed = deleteLabels.filter(id => owned.has(id));
        if (removed.length) {
          appImage.labels = appImage.labels.filter(labelId => !removed.includes(labelId.toString()));
          await appImage.save({session});
          for (const id of removed) {
            const otherOwner = await appImageModel.findOne({
              appId: {$ne:appId}, labels:id,
            }).session(session).lean();
            if (!otherOwner) await labelModel.deleteOne({id}).session(session);
          }
        }
      }

      return { updated: true };
    }, expectedRevision, true);
  } catch (error) {
    if (error instanceof BackupConflict || (expectedRevision !== undefined && error instanceof BackupUpgradeRequired)) throw error;
    console.error("Error modifying labels:", error);
    throw new Error("An error occurred while modifying labels");
  }
};

// Keep the legacy route, but never perform an unversioned destructive save.
export const backupAllSignersAndVaults = backupLegacyApp;

export const deleteBackup = deleteAppBackup;
