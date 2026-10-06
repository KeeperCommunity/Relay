import db from "../db";
import { AppSubscriptionLevel } from "../interface";
import config, { SERVER_ENVIRONMENT } from "../config";
import { SubscriptionPaymentType, PlanName } from "../interface";
import { getPlans } from "../utils/plans";
import { generateRandomId, getStreamId } from "./utils";

const DeepLinkIdentifier = {
  [SERVER_ENVIRONMENT.DEVELOPMENT]: "app/dev",
  [SERVER_ENVIRONMENT.PRODUCTION]: "app/prod",
};

export const getKeeperPrivateRedeemLink = async (create, accountManagerId) => {
  const keeperPrivateModel: any = db.getKeeperPrivateOrderModel();
  const accountMangerModel = db.getAccountManagerModel();

  const accountManger = await accountMangerModel.findOne({
    id: accountManagerId,
    isActive: true,
  });
  if (!accountManger) throw new Error("Account manager not found or inactive!");

  if (create) {
    const recordsToInsert = [];
    for (let i = 0; i < create; i++)
      recordsToInsert.push({ code: generateRandomId() });
    await keeperPrivateModel.insertMany(recordsToInsert);
  }

  const codes = await keeperPrivateModel.find();
  const links = codes.map((code) => {
    return `https://bitcoinkeeper.app/${
      DeepLinkIdentifier[config.ENVIRONMENT]
    }/kp/${code.code}/${accountManagerId}`;
  });

  return links;
};

export const redeemKeeperPrivateSubscription = async (
  appId,
  redeemCode,
  accountManager
) => {
  const keeperPrivateModel: any = db.getKeeperPrivateOrderModel();
  const validRedeemCode = await keeperPrivateModel.findOne({
    code: redeemCode,
  });
  if (!validRedeemCode)
    return {
      status: false,
      message:
        "Invalid Keeper Private link, Please contact concierge for more details",
    };

  const appModel: any = db.getAppModel();
  const [app] = await appModel.find({ appId });

  const isAlreadyKeeperPrivate =
    app.subscription.level === AppSubscriptionLevel.FOUR;

  const transactionDate = new Date().getTime();
  const expirationTime = isAlreadyKeeperPrivate
    ? new Date(JSON.parse(app.subscription.transactionReceipt).expirationTime)
    : new Date(transactionDate);

  if (config.ENVIRONMENT === SERVER_ENVIRONMENT.DEVELOPMENT) {
    expirationTime.setHours(expirationTime.getHours() + 6);
  } else {
    expirationTime.setFullYear(expirationTime.getFullYear() + 1);
  }

  const productId = config.KEEPER_PRIVATE_SKU[0];
  const plan = getPlans().filter(
    (plan) => plan.name == PlanName.KEEPER_PRIVATE
  )[0];
  const mongoData: any = {
    level: plan.level,
    paymentType: SubscriptionPaymentType.BTC_PAYMENT,
    plan: plan.name,
    isCancelled: false,
    productId,
    transactionDate: transactionDate,
    purchaseToken: "",
    transactionReceipt: JSON.stringify({
      transactionDate: transactionDate,
      expirationTime: expirationTime.getTime(),
      productId,
    }),
  };
  app.subscription = mongoData;
  app.accountManager = accountManager;
  app.save((err) => {
    if (err) {
      throw new Error(`Error occurred while saving to database: ${err}`);
    }
  });

  await keeperPrivateModel.findOneAndDelete({ code: redeemCode });
  mongoData.icon = plan.icon;
  return { data: mongoData, status: true, isExtended: isAlreadyKeeperPrivate };
};

export const createAccountManager = async (data) => {
  const accountMangerModel = db.getAccountManagerModel();
  const { fullName, links, image } = data;
  const id = getStreamId(fullName + links.email);

  const alreadyCreated = await accountMangerModel.find({ id }).count();
  if (alreadyCreated) throw new Error("Account manager already exists");

  const newAccountManager = new accountMangerModel({
    fullName,
    image,
    links,
    id,
  });
  await newAccountManager.save();
  return { success: true, message: "New account manager created successfully" };
};

export const getAccountManagerDetails = async (appId) => {
  const appModel: any = db.getAppModel();
  const accountMangerModel = db.getAccountManagerModel();
  const [app] = await appModel.find({ appId });
  const accountManger = await accountMangerModel
    .findOne({ id: app.accountManager, isActive: true })
    .select("fullName links image -_id");
  return accountManger;
};
