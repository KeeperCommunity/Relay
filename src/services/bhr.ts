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
  nodes
): Promise<{ updated: boolean; error?: string }> => {
  const appImageModel: any = db.getAppImageModel();
  const [appImage] = await appImageModel.find({ appId });
  try {
    //new App Image
    if (!appImage) {
      const appImageInstance = new appImageModel({
        appId,
        publicId,
        wallets: walletObject,
        subscription,
        version,
        nodes,
      });
      await appImageInstance.save();
      return { updated: true, error: "" };
    }
    //update App Image
    else {
      if (publicId) appImage.public = publicId;
      if (subscription) appImage.subscription = subscription;
      if (version) appImage.version = version;
      if (nodes.length) appImage.nodes = nodes;
      if (walletObject) {
        //wallets condition check based on subscription beofre adding
        const appSubscription = await getAppSubscriptionDetails(appId);
        if (appSubscription) {
          const isValid = isAllowedToUpdate(
            appSubscription,
            appImage,
            walletObject
          );
          if (isValid) {
            const updatedWallets = {
              ...appImage.wallets,
              ...walletObject,
            };
            appImage.wallets = updatedWallets;
          } else {
            return {
              updated: false,
              error:
                "Your current subscription plan does not allow to add more wallets",
            };
          }
        } else {
          // todo add this return { updated: false, error: "App not found" };
          const updatedWallets = {
            ...appImage.wallets,
            ...walletObject,
          };
          appImage.wallets = updatedWallets;
          const updatedImage = await appImage.save((err) => {
            if (err) {
              console.log(err);
              throw new Error(`Error occured while saving to database: ${err}`);
            }
          });
          return { updated: true, error: "" };
        }
      }
      if (signersObject) {
        const updatedSigners = {
          ...appImage.signers,
          ...signersObject,
        };
        appImage.signers = updatedSigners;
        const updatedImage = await appImage.save((err) => {
          if (err) {
            console.log(err);
            throw new Error(`Error occured while saving to database: ${err}`);
          }
        });
        return { updated: true, error: "" };
      }
      await appImage.save((err) => {
        if (err) {
          console.log(err);
          return {
            updated: false,
            error: `Error occured while saving to database: ${err}`,
          };
        }
      });
      return { updated: true, error: "" };
    }
  } catch (err) {
    return { updated: false, error: `${err}` };
  }
};

export const deleteAppImageEntity = async (
  appId,
  wallets,
  signers
): Promise<{ updated: boolean; error?: string }> => {
  const appImageModel: any = db.getAppImageModel();
  const [appImage] = await appImageModel.find({ appId });
  try {
    if (!appImage) {
      console.log("Something Went Wrong, could not find the app image");
      return { updated: false, error: "No app image" };
    } else {
      if (signers?.length > 0) {
        let appImageSigners = { ...appImage.signers };
        console.log({ appImageSigners });
        for (const signerId of signers) {
          if (appImageSigners.hasOwnProperty(signerId)) {
            delete appImageSigners[signerId];
          }
        }
        console.log({ appImageSigners });
        appImage.signers = appImageSigners;
      }
      if (wallets?.length > 0) {
        let appImageWallets = { ...appImage.wallets };
        for (const walletId of wallets) {
          if (appImageWallets.hasOwnProperty(walletId)) {
            delete appImageWallets[walletId];
          }
        }
        appImage.wallets = appImageWallets;
      }
      await appImage.save((err) => {
        if (err) {
          console.log(err);
          return {
            updated: false,
            error: `Error occured while saving to database: ${err}`,
          };
        } else {
          console.log("update");
          return { updated: true, error: "" };
        }
      });
      return { updated: true, error: "" };
    }
  } catch (err) {
    console.log("Error", err);
    return { updated: false, error: `${err}` };
  }
};

export const deleteVaults = async (appId, vaults) => {
  try {
    const vaultImageModel: any = db.getVaultImageModel();
    const appImageModel: any = db.getAppImageModel();
    const [appImage] = await appImageModel.find({ appId });

    if (appImage) {
      console.log({ old: appImage.vaults });
      const updatedAppImageVaults = appImage.vaults.filter(
        (vaultId) => !vaults.includes(vaultId)
      );
      appImage.vaults = updatedAppImageVaults;

      await appImage.save((err) => {
        if (err) {
          console.log(err);
          return {
            updated: false,
            error: `Error occured while saving to database: ${err}`,
          };
        }
      });
      for (const vaultId of vaults) {
        vaultImageModel
          .findOneAndDelete({ vaultId })
          .then((deletedEntity) => {
            console.log("Deleted Vault entity");
          })
          .catch((error) => {
            console.error("Error deleting entity:", error);
          });
      }

      return { updated: true };
    }
  } catch (err) {
    console.log(err);
    return { updated: false, error: `${err}` };
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

export const createVaultMap = async (signersData: any[], vaultId) => {
  const vaultImageMapModel: any = db.getVaultMapModel();
  for (let index in signersData) {
    const [vaultMap] = await vaultImageMapModel.find({
      signerId: signersData[index].signerId,
    });
    if (!vaultMap) {
      const vaultMapInstance = new vaultImageMapModel({
        signerId: signersData[index].signerId,
        xfpHash: signersData[index].xfpHash,
        vaultId,
      });
      vaultMapInstance.save();
    } else {
      vaultMap.vaultId = vaultId;
      vaultMap.save();
    }
  }
};

export const addVaultImage = async (
  appId,
  vaultShellId,
  vaultId,
  scheme,
  vault,
  signersData,
  subscription
) => {
  try {
    const vaultImageModel: any = db.getVaultImageModel();
    const [vaultImage] = await vaultImageModel.find({ vaultId }); // old vault with same signer may exsist
    if (!vaultImage) {
      // update the appImage's vault filed with new vaultId
      const appImageModel: any = db.getAppImageModel();
      const [appImage] = await appImageModel.find({ appId });
      const updatedVaults = [...appImage.vaults, vaultId];
      appImage.vaults = updatedVaults;
      await appImage.save((err) => {
        if (err) {
          console.log(err);
          throw new Error(`Error occured while saving to database: ${err}`);
        }
      });

      //creating new vault image and adding the map
      const signerIds = signersData.map((signer) => signer.signerId);
      const vaultImageInstance = new vaultImageModel({
        appId,
        vaultShellId,
        vaultId,
        signerIds,
        scheme,
        vault,
        subscription,
      });
      vaultImageInstance.save();
      createVaultMap(signersData, vaultId);
    } else {
      if (appId) {
        vaultImage.appId = appId;
        //updated link of vault for new appId
        const appImageModel: any = db.getAppImageModel();
        const [appImage] = await appImageModel.find({ appId });
        const updatedVaults = [...appImage.vaults, vaultId];
        appImage.vaults = updatedVaults;
        await appImage.save((err) => {
          if (err) {
            console.log(err);
            throw new Error(`Error occured while saving to database: ${err}`);
          }
        });
      }
      if (vaultShellId) vaultImage.vaultShellId = vaultShellId;
      if (signersData) {
        const signerIds = signersData.map((signer) => signer.signerId);
        vaultImage.signerIds = signerIds;
        createVaultMap(signersData, vaultId);
      }
      if (scheme) vaultImage.scheme = scheme;
      if (vault) vaultImage.vault = vault;
      if (subscription) vaultImage.subscription = subscription;
      vaultImage.isArchived = false;
      vaultImage.save();
    }

    return { updated: true, error: "" };
  } catch (err) {
    console.log(err);
    return { updated: false, error: `${err}` };
  }
};

export const archiveVault = async (vaultId) => {
  try {
    const vaultImageModel: any = db.getVaultImageModel();
    const [vaultImage] = await vaultImageModel.find({ vaultId });
    if (vaultImage) {
      vaultImage.isArchived = true;
      vaultImage.save();
    }
    const vaultImageMapModel: any = db.getVaultMapModel();
    await vaultImageMapModel.deleteMany({ vaultId });
    return true;
  } catch (err) {
    console.log(err);
    return false;
  }
};

export const updateVault = async (vaultId, vault) => {
  try {
    const vaultImageModel: any = db.getVaultImageModel();
    const [vaultImage] = await vaultImageModel.find({ vaultId });
    if (vaultImage) {
      vaultImage.isArchived = false;
      vaultImage.vault = vault;
      vaultImage.save();
    }
    return {};
  } catch (err) {
    console.log(err);
  }
};

export const getSignerIdInfo = async (signerId) => {
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
  const appImageModel: any = db.getAppImageModel();
  const labelModel: any = db.getLabelModel();
  let [appImage] = await appImageModel.find({ appId });
  if (!appImage) {
    appImage = {
      labels: [],
      vaults: [],
      nodes: [],
      appId,
      wallets: {},
      version: appversion,
      signers: {},
    };
  }
  let vaultImage;
  let allVaultImages = [];
  if (appImage.vaults.length > 0) {
    for (const i in appImage.vaults) {
      const { isVault } = await vaultCheck(appImage.vaults[i]);
      const image = await getVaultImage(appImage.vaults[i]);
      if (isVault) {
        vaultImage = image;
      }
      allVaultImages.push(image);
    }
  }
  const subscription = await getAppSubscriptionDetails(appId, true);
  const plan = getPlans().find((plan) => plan.level === subscription.level);
  const labelIds = appImage.labels;
  const labels = await labelModel.find({ id: labelIds });
  return {
    appImage,
    vaultImage,
    labels,
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
  signerChanges: SignerChange[]
) => {
  try {
    const appImageModel: any = db.getAppImageModel();
    const [appImage] = await appImageModel.find({ appId });
    let signersObject = { ...appImage.signers };
    if (appImage) {
      for (const change of signerChanges) {
        if (signersObject[change.oldSignerId] !== undefined) {
          delete signersObject[change.oldSignerId];
        }
        signersObject[change.newSignerId] = change.newSignerDetails;
      }
      appImage.signers = signersObject;
      await appImage.save();
      return true;
    } else {
      return false;
    }
  } catch (err) {
    console.log(err);
    return false;
  }
};

export const modifyLabels = async (appId, addLabels, deleteLabels) => {
  try {
    const appImageModel: any = db.getAppImageModel();
    const labelModel: any = db.getLabelModel();
    let appImage = await appImageModel.findOne({ appId });

    if (!appImage) {
      throw new Error("App not found");
    }

    if (addLabels && addLabels.length > 0) {
      const newLabels = [];
      for (const label of addLabels) {
        if (!label || !label.content) {
          continue;
        }
        // Check if label exists
        const existingLabel = await labelModel.findOne({ id: label.id });
        if (existingLabel) {
          newLabels.push(existingLabel);
        } else {
          // need to create that label
          const createdLabels = await labelModel.create(label);
          newLabels.push(createdLabels.id);
        }
      }

      appImage.labels = appImage.labels || [];
      appImage.labels.push(...newLabels);
      await appImage.save();
    }

    if (deleteLabels && deleteLabels.length > 0) {
      const deletedLabels = await labelModel.deleteMany({
        id: { $in: deleteLabels },
      });
      if (appImage.labels && appImage.labels.length > 0) {
        appImage.labels = appImage.labels.filter(
          (labelId) => !deleteLabels.includes(labelId.toString())
        );
      }
      await appImage.save();
    }

    return { updated: true };
  } catch (error) {
    console.error("Error modifying labels:", error);
    throw new Error("An error occurred while modifying labels");
  }
};

export const backupAllSignersAndVaults = async (data) => {
  const {
    appId,
    publicId,
    walletObject,
    signersObject,
    vaultObject,
    subscription,
    version,
    nodes,
    labels,
  } = data;
  const appImageModel: any = db.getAppImageModel();
  let [appImage] = await appImageModel.find({ appId });
  const labelModel: any = db.getLabelModel();
  const vaultImageModel: any = db.getVaultImageModel();
  const vaultsList = [];
  let isNewAppImage = false;
  try {
    if (!appImage) {
      isNewAppImage = true;
      appImage = {};
    }

    if (publicId) appImage.public = publicId;
    if (subscription) appImage.subscription = subscription;
    if (version) appImage.version = version;
    if (walletObject) appImage.wallets = walletObject;
    if (signersObject) appImage.signers = signersObject;
    if (nodes) appImage.nodes = nodes;

    for (let vaultId in vaultObject) {
      const { vaultShellId, scheme, signersData, vault } = vaultObject[vaultId];
      const [vaultImage] = await vaultImageModel.find({ vaultId }); // old vault with same signer may exist
      if (!vaultImage) {
        vaultsList.push(vaultId);
        //creating new vault image and adding the ma
        const signerIds = vaultObject[vaultId].signersData.map(
          (signer) => signer.signerId
        );
        const vaultImageInstance = new vaultImageModel({
          appId,
          vaultShellId,
          vaultId,
          signerIds,
          scheme,
          vault,
          subscription,
        });
        vaultImageInstance.save();
        createVaultMap(signersData, vaultId);
      } else {
        if (appId) {
          vaultImage.appId = appId;
          vaultsList.push(vaultId);
        }
        if (vaultShellId) vaultImage.vaultShellId = vaultShellId;
        if (signersData) {
          const signerIds = signersData.map((signer) => signer.signerId);
          vaultImage.signerIds = signerIds;
          createVaultMap(signersData, vaultId);
        }
        if (scheme) vaultImage.scheme = scheme;
        if (vault) vaultImage.vault = vault;
        if (subscription) vaultImage.subscription = subscription;
        vaultImage.isArchived = false;
        vaultImage.save();
      }
    }

    const deletedVaults = appImage?.vaults?.filter(
      (vault) => !vaultsList.includes(vault)
    );

    if (deletedVaults?.length > 0) {
      for (const vaultId of deletedVaults) {
        await vaultImageModel
          .findOneAndDelete({ vaultId })
          .then((deletedEntity) => {
            console.log("Deleted Vault entity");
          })
          .catch((error) => {
            console.error("Error deleting entity:", error);
          });
      }
    }
    appImage.vaults = vaultsList;

    const newLabels = labels.filter(
      (obj) => !appImage?.labels?.includes(obj.id)
    );

    const deletedLabels = appImage?.labels?.filter(
      (labelId) => !labels.some((appItem) => appItem.id === labelId)
    );

    if (newLabels?.length > 0) {
      const finalLabels = [];
      for (const label of newLabels) {
        if (!label || !label.content) {
          continue;
        }
        // Check if label exists
        const existingLabel = await labelModel.findOne({ id: label.id });
        if (existingLabel) {
          finalLabels.push(existingLabel.id);
        } else {
          // need to create that label
          const createdLabels = await labelModel.create(label);
          finalLabels.push(createdLabels.id);
        }
      }
      appImage.labels = appImage?.labels || [];
      appImage.labels.push(...finalLabels);
    }

    if (deletedLabels?.length > 0) {
      await labelModel.deleteMany({
        id: { $in: deletedLabels },
      });
      appImage.labels = appImage?.labels?.filter(
        (labelId) => !deletedLabels.includes(labelId.toString())
      );
    }

    if (isNewAppImage) {
      appImage = new appImageModel({
        ...appImage,
        publicId: appImage.public,
        appId,
      });
    }

    await appImage.save((err) => {
      if (err) {
        console.log(err);
        return {
          updated: false,
          error: `Error occurred while saving to database: ${err}`,
        };
      }
    });
    return { updated: true, error: "" };
  } catch (err) {
    console.log("🚀 ~ backupAllSignersAndVaults ~ err:", err);
    throw new Error(err);
  }
};

export const deleteBackup = async (appId) => {
  const appImageModel: any = db.getAppImageModel();
  let [appImage] = await appImageModel.find({ appId });
  const labelModel: any = db.getLabelModel();
  const vaultImageModel: any = db.getVaultImageModel();
  const vaultMapModel: any = db.getVaultMapModel();

  if (!appImage) {
    throw new Error("no backup found");
  }

  try {
    appImage.nodes = [];
    appImage.wallets = [];
    appImage.signers = [];
    for (const labelId of appImage.labels) {
      await labelModel.findOneAndDelete({ id: labelId });
    }

    for (const vaultId of appImage.vaults) {
      await vaultImageModel.findOneAndDelete({ vaultId });
      await vaultMapModel.deleteMany({ vaultId });
    }

    appImage.labels = [];
    appImage.vaults = [];
    await appImage.save((err) => {
      if (err) {
        console.log(err);
        throw new Error(err);
      }
    });
    return { updated: true, error: "" };
  } catch (error) {
    console.log("🚀 ~ deleteBackup ~ error:", error);
    throw new Error(error);
  }
};
