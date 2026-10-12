import { createStoreReceiptValidator, isStorePurchaseInactive } from "../utils/storeReceipt";
import axios from "axios";
import db from "../db";
import { androidpublisher_v3 } from "googleapis/build/src/apis/androidpublisher/v3";
import { JWT } from "google-auth-library";
import config, { OS } from "../config";
import {
  AppSubscriptionLevel,
  SubscriptionPaymentType,
  AppSubscription,
  SubscriptionPlan,
  PlanName,
  PlebSubscription,
} from "../interface";
import { getPlans } from "../utils/plans";
import { SERVER_ENVIRONMENT } from "../config";
import moment from "moment";

const androidGoogleApi = new androidpublisher_v3.Androidpublisher({
  auth: new JWT(
    config.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    ["https://www.googleapis.com/auth/androidpublisher"]
  ),
});

const validateStoreReceipt = createStoreReceiptValidator({
  applePassword: config.APPLE_SHARED_SECRET,
  appleSandboxOnly: config.ENVIRONMENT === SERVER_ENVIRONMENT.DEVELOPMENT,
  appleBundleId: "io.hexawallet.keeper",
  googlePackageName: "io.hexawallet.bitcoinkeeper",
}, {
  apple: async (url, body) => (await axios.post(url, body, {
    timeout: 20000, maxRedirects: 0, maxContentLength: 1024 * 1024,
    maxBodyLength: 2 * 1024 * 1024,
  })).data,
  google: async (packageName, productId, token) =>
    (await androidGoogleApi.purchases.subscriptions.get({
      packageName, subscriptionId: productId, token,
    }, { timeout: 20000, retry: false })).data,
});

export const createNewApp = async (
  publicId,
  appId,
  os,
  appversion,
  fcmToken
): Promise<boolean> => {
  try {
    const appModel: any = db.getAppModel();
    const appImageModel: any = db.getAppImageModel();
    const [app] = await appModel.find({ appId });
    if (!app) {
      const appInstance = new appModel({
        _id: appId,
        appId,
        publicId,
        os,
        version: appversion,
        fcmToken,
        subscription: {
          plan: PlanName.PLEB,
          level: AppSubscriptionLevel.ONE,
          paymentType: SubscriptionPaymentType.FREE,
        },
      });
      appInstance.save((err) => {
        if (err) {
          throw new Error(`Error occured while saving to database: ${err}`);
        }
      });
      // save empty app image at the same time
      const appImageInstance = new appImageModel({
        appId,
        publicId,
        wallets: {},
        signers: {},
        version: appversion,
        nodes: [],
      });
      await appImageInstance.save();
      return true;
    } else {
      return true;
    }
  } catch (err) {
    console.log(err);
    return false;
  }
};

export const updateContactsKey = async (_id, contactsKey) => {
  try {
    const appModel: any = db.getAppModel();
    const [app] = await appModel.find({ _id });
    if (!app) {
      return false;
    }
    app.contactsKey = contactsKey || app.contactsKey;
    await app.save((err) => {
      if (err) {
        throw new Error(`Error occured while saving to database: ${err}`);
      }
    });
    return true;
  } catch (err) {
    console.log(err);
    return false;
  }
};

export const updateStoreSubscription = async (
  _id,
  appId,
  os,
  data,
  newPlans
): Promise<{ updated: boolean; error?: string; level: number }> => {
  try {
    const appModel: any = db.getAppModel();
    const [app] = await appModel.find({ _id });
    if (!app) {
      return {
        updated: false,
        error: "no matching app found",
        level: AppSubscriptionLevel.ONE,
      };
    } else {
      if (appId === app.publicId) {
        const level = getPlanByProductId(data.productId, os, newPlans).level;
        if (level === AppSubscriptionLevel.ONE) {
          return unsubscribeFromExistingPlan(app);
        }
        if (config.ENVIRONMENT === SERVER_ENVIRONMENT.DEVELOPMENT) {
          if (data.transactionReceipt === config.MOCK_PURCHASE_IDENTIFIER) {
            return await storeMockPurchase(app, data, level);
          }
        }
        const dataAndroid =
          os === "android"
            ? JSON.parse(data.dataAndroid || data.transactionReceipt)
            : null;
        const validationResponse = await validateStoreReceipt(
          os,
          os === "android"
            ? {
                packageName: dataAndroid.packageName,
                productId: dataAndroid.productId,
                purchaseToken: dataAndroid.purchaseToken,
                subscription: true,
              }
            : data.transactionReceipt,
          data.productId
        );
        const purchaseData = validationResponse.purchaseData;
        const firstPurchaseItem = purchaseData[0];
        const isCancelled = isStorePurchaseInactive(firstPurchaseItem);
        if (!isCancelled) {
          const verifiedAndroidReceipt = os === "android" ? JSON.stringify({
            packageName: dataAndroid.packageName,
            productId: dataAndroid.productId,
            purchaseToken: dataAndroid.purchaseToken,
          }) : undefined;
          const subscription = {
            productId: firstPurchaseItem.productId,
            transactionId: firstPurchaseItem.transactionId,
            transactionDate: firstPurchaseItem.purchaseDate,
            transactionReceipt: verifiedAndroidReceipt || data.transactionReceipt,
            ...(verifiedAndroidReceipt ? {
              dataAndroid: verifiedAndroidReceipt, purchaseToken: dataAndroid.purchaseToken,
            } : {}),
            paymentType:
              os === "android"
                ? SubscriptionPaymentType.PLAYSTORE
                : SubscriptionPaymentType.APPLE,
            level,
            purchaseData,
            isCancelled,
            plan: getPlanByProductId(data.productId, os, newPlans).name,
          };
          if (os === "android") {
            if (validationResponse.acknowledgementState === 0) {
              try {
                await androidGoogleApi.purchases.subscriptions.acknowledge({
                  packageName: dataAndroid.packageName,
                  subscriptionId: dataAndroid.productId,
                  token: dataAndroid.purchaseToken,
                }, { timeout: 20000, retry: false });
              } catch (_) {
                throw new Error("Store subscription acknowledgement failed");
              }
            }
          }
          app.subscription = subscription;
          await app.save((err) => {
            if (err) {
              throw new Error(`Error occured while saving to database: ${err}`);
            }
          });
          return {
            updated: true,
            ...firstPurchaseItem,
            level,
          };
        } else {
          return {
            updated: false,
            level: AppSubscriptionLevel.ONE,
          };
        }
      } else {
        return {
          updated: false,
          error: "Unauthorized",
          level: AppSubscriptionLevel.ONE,
        };
      }
    }
  } catch (error) {
    console.log(error);
    return {
      updated: false,
      error: `${error}`,
      level: AppSubscriptionLevel.ONE,
    };
  }
};

const storeMockPurchase = async (
  app,
  subscription,
  level
): Promise<{ updated: boolean; error?: string; level: number }> => {
  app.subscription = { ...subscription, level };
  await app.save((err) => {
    if (err) {
      throw new Error(`Error occured while saving to database: ${err}`);
    }
  });
  return {
    updated: true,
    level,
  };
};

export const verifyReceipt = async (
  _id,
  appId,
  os?
): Promise<{
  isCancelled: boolean;
  error?: string;
  productId?: string;
  expirationDate?: number;
  subscription?: ReturnType<typeof createSubscriptionData>;
  level?: number;
}> => {
  try {
    const appModel: any = db.getAppModel();
    const [app] = await appModel.find({ _id });
    if (!app) {
      return {
        isCancelled: true,
        error: "no matching app found",
      };
    } else {
      if (appId === app.publicId) {
        if (app.subscription.level === AppSubscriptionLevel.ONE) {
          return {
            isCancelled: false,
            level: AppSubscriptionLevel.ONE,
          };
        }
        // Validate BTC Payments
        if (
          app?.subscription?.paymentType == SubscriptionPaymentType.BTC_PAYMENT
        ) {
          const { expirationTime } = JSON.parse(
            app.subscription.transactionReceipt
          );
          if (new Date().getTime() <= expirationTime) {
            return {
              isCancelled: app.subscription.isCancelled,
              ...app.subscription,
            };
          } else {
            const nextSubscription = JSON.parse(
              app.subscription?.nextSubscription || "{}"
            );
            if (nextSubscription?.level !== AppSubscriptionLevel.ONE) {
              const { expirationTime } = JSON.parse(
                nextSubscription.transactionReceipt || "{}"
              );
              if (new Date().getTime() <= expirationTime) {
                app.subscription = nextSubscription;
                app.save((err) => {
                  if (err) {
                    throw new Error(
                      `Error occurred while saving to database: ${err}`
                    );
                  }
                });
                return {
                  isCancelled: app.subscription.isCancelled,
                  ...app.subscription,
                  icon: getPlanByProductId(
                    app.subscription.productId,
                    OS.DESKTOP,
                    true
                  ).icon,
                };
              }
            }
            app.subscription = PlebSubscription;
            app.save((err) => {
              if (err) {
                throw new Error(
                  `Error occurred while saving to database: ${err}`
                );
              }
            });
            return {
              isCancelled: true,
              level: AppSubscriptionLevel.ONE,
            };
          }
        }
        if (config.ENVIRONMENT === SERVER_ENVIRONMENT.DEVELOPMENT) {
          if (
            app.subscription.transactionReceipt ===
            config.MOCK_PURCHASE_IDENTIFIER
          ) {
            return {
              isCancelled: false,
              level: app.subscription.level,
            };
          }
        }
        if (app.os === "ios") {
          const validationResponse = await validateStoreReceipt(
            "ios", app.subscription.transactionReceipt, app.subscription.productId
          );
          const purchaseData = validationResponse.purchaseData;
          const firstPurchaseItem = purchaseData[0];
          const isCancelled = isStorePurchaseInactive(firstPurchaseItem);
          app.subscription.purchaseData = firstPurchaseItem;
          app.subscription.isCancelled = isCancelled;
          app.save((err) => {
            if (err) {
              throw new Error(`Error occured while saving to database: ${err}`);
            }
          });
          return {
            isCancelled: isCancelled,
            ...firstPurchaseItem,
            level: app.subscription.level,
            subscription: createSubscriptionData(app.subscription, OS.iOS),
          };
        } else {
          const dataAndroid = JSON.parse(
            app.subscription.transactionReceipt || app.subscription.dataAndroid
          );
          const validationResponse = await validateStoreReceipt("android", {
            packageName: dataAndroid.packageName,
            productId: dataAndroid.productId,
            purchaseToken: dataAndroid.purchaseToken,
            subscription: true,
          }, app.subscription.productId);
          const purchaseData = validationResponse.purchaseData;
          const firstPurchaseItem = purchaseData[0];
          const isCancelled = isStorePurchaseInactive(firstPurchaseItem);
          app.subscription.purchaseData = firstPurchaseItem;
          app.subscription.isCancelled = isCancelled;
          app.save((err) => {
            if (err) {
              throw new Error(`Error occured while saving to database: ${err}`);
            }
          });
          return {
            isCancelled: isCancelled,
            ...firstPurchaseItem,
            level: app.subscription.level,
            subscription: createSubscriptionData(app.subscription, OS.ANDROID),
          };
        }
      } else {
        return {
          isCancelled: true,
          error: "Unauthorized",
          level: AppSubscriptionLevel.ONE,
        };
      }
    }
  } catch (error) {
    console.log(error);
    return {
      isCancelled: true,
      error: `${error}`,
    };
  }
};

const unsubscribeFromExistingPlan = async (
  app
): Promise<{ updated: boolean; error?: string; level: number }> => {
  try {
    if (app.subscription.level === AppSubscriptionLevel.ONE) {
      return {
        updated: true,
        error: "",
        ...app.subscription,
      };
    }

    if (app?.subscription?.paymentType == SubscriptionPaymentType.BTC_PAYMENT) {
      const { expirationTime } = JSON.parse(
        app.subscription.transactionReceipt
      );
      if (new Date().getTime() <= expirationTime) {
        return {
          updated: false,
          level: app.subscription.level,
          error: `You have an active subscription to ${
            getPlanByProductId(app.subscription.productId, app.os, true).name
          } till ${moment(Number(expirationTime)).format("DD-MMM-YY")}`,
        };
      } else {
        app.subscription = PlebSubscription;
        await app.save((err) => {
          if (err) {
            throw new Error(`Error occurred while saving to database: ${err}`);
          }
        });
        return {
          updated: true,
          ...JSON.parse(app.subscription.transactionReceipt),
          level: app.subscription.level,
          error: "",
        };
      }
    }

    if (config.ENVIRONMENT === SERVER_ENVIRONMENT.DEVELOPMENT) {
      if (
        app.subscription.transactionReceipt === config.MOCK_PURCHASE_IDENTIFIER
      ) {
        app.subscription = PlebSubscription;
        await app.save((err) => {
          if (err) {
            throw new Error(`Error occured while saving to database: ${err}`);
          }
        });
        return {
          updated: true,
          level: app.subscription.level,
          error: "",
        };
      }
    }
    const receipt = await verifyReceipt(app._id, app.publicId, app.os);
    if (receipt.isCancelled) {
      app.subscription = PlebSubscription;
      await app.save((err) => {
        if (err) {
          throw new Error(`Error occured while saving to database: ${err}`);
        }
      });
      return {
        updated: true,
        ...receipt,
        level: app.subscription.level,
        error: "",
      };
    } else {
      const isNewPlan = receipt.productId.split(".").length > 1;
      return {
        updated: false,
        ...receipt,
        level: app.subscription.level,
        error: `You have an active subscription to ${
          getPlanByProductId(receipt.productId, app.os, isNewPlan).name
        } till ${moment(Number(receipt.expirationDate)).format(
          "DD-MMM-YY"
        )}. Please cancel it from store settings and try again.`,
      };
    }
  } catch (error) {
    return {
      updated: true,
      ...app.subscription,
      level: app.subscription.level,
    };
  }
};

export const getAppSubscriptionDetails = async (
  appId: string,
  checkReceipt = false
): Promise<AppSubscription> => {
  try {
    const appModel: any = db.getAppModel();
    const [app] = await appModel.find({ appId });
    if (!app) {
      return null;
    } else {
      if (checkReceipt) {
        const receipt = await verifyReceipt(app._id, app.publicId, app.os);
        return {
          isValid: !receipt.isCancelled,
          ...app.subscription,
        };
      }
      return {
        ...app.subscription,
        isValid: !app.subscription.isCancelled,
      };
    }
  } catch (error) {
    console.log(error);
  }
};

export const getSubscriptionDetails = async (
  os: OS,
  appID: string,
  newPlans: boolean = false
): Promise<{
  plans: SubscriptionPlan[];
  currentSubscription: AppSubscription;
}> => {
  try {
    return {
      currentSubscription: await getAppSubscriptionDetails(appID),
      plans: getPlans(os, newPlans),
    };
  } catch (error) {
    console.log(error);
  }
};

export function getPlanByProductId(
  productId: string,
  os: OS,
  newPlans: boolean = false
): SubscriptionPlan {
  const plan = getPlans(os, newPlans).filter((plan) =>
    plan.productIds.includes(productId)
  );
  return plan[0];
}

export const createRemoteKey = async (data, hash) => {
  try {
    const createKeyModal = db.getRemoteKeyModel();
    let externalKey = await createKeyModal.create({ data, hash });
    if (!externalKey) {
      throw new Error("Key not created");
    }
    return { id: externalKey._id };
  } catch (error) {
    console.log("🚀 ~ createRemoteKey ~ error:", error);
  }
};

export const getRemoteKey = async (hash) => {
  // fetch remote key and delete it
  const externalKeyModel = db.getRemoteKeyModel();
  const externalKey = await externalKeyModel.findOne({ hash }).select({
    data: 1,
    createdAt: 1,
    _id: 1,
  });
  if (!externalKey) {
    throw new Error("Remote Key link expired.");
  }
  if (config.ENVIRONMENT == SERVER_ENVIRONMENT.PRODUCTION) {
    // deleting on access only on production
    await externalKeyModel.deleteOne({ _id: externalKey.id });
  }
  return externalKey;
};

export const deleteExpiredRemoteKeyData = async () => {
  // Deletes all remote keys older than 10 minutes
  const now = new Date().getTime();
  const threshold = now - 10 * 60 * 1000; // 10 mins
  try {
    const externalKeyModal = db.getRemoteKeyModel();
    const res = await externalKeyModal.deleteMany({
      createdAt: { $lt: threshold },
    });
  } catch (error) {
    console.log("🚀 ~ deleteExpiredRemoteKeyData ~ error:", error);
  }
};

export const createSubscriptionData = (data, os) => {
  return {
    level: data.level,
    paymentType: data.paymentType,
    name: data.plan,
    productId: data.productId,
    receipt: data.transactionReceipt,
    icon: getPlanByProductId(data.productId, os, true).icon,
  };
};

export const getActiveCampaign = async () => {
  const campaignModel = db.getCampaignModel();
  const res = await campaignModel
    .find({ isActive: true })
    .select("-_id -isActive -createdAt -updatedAt -__v");
  if (res) {
    return res[0];
  }

  return null;
};
