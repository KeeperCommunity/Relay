import { AppSubscriptionLevel, SubscriptionPaymentType } from "../interface";
import db from "../db";
import axios from "axios";
import config, { OS, SERVER_ENVIRONMENT } from "../config";
import { getPlanByProductId } from "./app";
const channelUrl = `${config.CHANNEL_URL}btcPaymentConfirmation`;

export const checkEligibility = async (data) => {
  try {
    const appModel: any = db.getAppModel();
    const [app] = await appModel.find({ appId: data.appId });
    if (app.subscription?.paymentType == SubscriptionPaymentType.BTC_PAYMENT) {
      const nextSubscription = JSON.parse(
        app.subscription.nextSubscription || "{}"
      );
      if (nextSubscription?.level) {
        return {
          status: false,
          error: `You already have a ${nextSubscription.plan} subscription lined up after your current subscription expires.`,
        };
      }
    }
    return { status: true };
  } catch (error) {
    console.log("🚀 ~ createBTCPayOrder ~ error:", error);
    throw new Error(error);
  }
};

export const confirmBtcPayment = async (body) => {
  if (["invoice_completed", "invoice_confirmed"].includes(body?.event?.name)) {
    await updateUserSubscriptionViaBtc(body?.data?.id);
    return true;
  }
};

export const validateBtcPayment = async (invoiceId) => {
  try {
    const url = `${config.BTC_PAY_SERVER_URL}/api/v1/stores/${config.BTC_PAY_STORE_ID}/invoices/${invoiceId}`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `token ${config.BTC_PAY_API_TOKEN}`,
    };
    const res = await axios.get(url, { headers });
    return res.data;
  } catch (error) {
    console.log("🚀 ~ validateBtcPayment ~ error:", error);
    return null;
  }
};

export const updateUserSubscriptionViaBtc = async (invoiceId) => {
  const validReceipt = await validateBtcPayment(invoiceId);
  let data;
  if (!validReceipt || validReceipt.status !== "Settled") {
    data = {
      isUpdated: false,
      invoiceId,
      roomId: validReceipt?.metadata?.posData?.roomId,
      error: `Transaction not completed, try recovering subscription after it's completed. For any issue, raise a ticket at concierge with invoice id ${invoiceId}`,
    };
  } else {
    const { appId, roomId, productId } = validReceipt.metadata.posData;
    let isStackSubscription = false;

    const appModel: any = db.getAppModel();
    const [app] = await appModel.find({ appId });

    if (invoiceId === app?.subscription?.purchaseToken) {
      data = {
        isUpdated: false,
        invoiceId,
        roomId: validReceipt?.metadata?.posData?.roomId,
        error: `Invalid invoice. Please contact concierge with invoice id ${invoiceId}`,
      };
    } else {
      const { expirationTime: prevExpirationTime, invoiceId: oldInvoiceId } =
        JSON.parse(app.subscription?.transactionReceipt || "{}");

      if (
        app.subscription?.paymentType == SubscriptionPaymentType.BTC_PAYMENT &&
        new Date().getTime() <= prevExpirationTime &&
        oldInvoiceId != invoiceId
      ) {
        isStackSubscription = true;
      }

      const transactionDate = isStackSubscription
        ? prevExpirationTime
        : new Date().getTime();
      const expirationTime = new Date(transactionDate);

      if (config.ENVIRONMENT === SERVER_ENVIRONMENT.DEVELOPMENT) {
        expirationTime.setHours(expirationTime.getHours() + 6);
      } else {
        expirationTime.setFullYear(expirationTime.getFullYear() + 1);
      }

      const plan = getPlanByProductId(productId, OS.DESKTOP, true);
      const mongoData = {
        level: plan.level,
        paymentType: SubscriptionPaymentType.BTC_PAYMENT,
        plan: plan.name,
        isCancelled: false,
        productId,
        transactionDate: transactionDate,
        purchaseToken: validReceipt?.id,
        transactionReceipt: JSON.stringify({
          transactionDate: transactionDate,
          expirationTime: expirationTime.getTime(),
          productId,
          checkoutLink: validReceipt?.checkoutLink,
        }),
      };

      if (isStackSubscription)
        app.subscription.nextSubscription = JSON.stringify({
          ...mongoData,
        });
      else app.subscription = mongoData;

      app.save((err) => {
        if (err) {
          throw new Error(`Error occurred while saving to database: ${err}`);
        }
      });
      data = {
        isUpdated: true,
        productId: app.subscription.productId,
        receipt: app.subscription.transactionReceipt,
        name: app.subscription.plan,
        level: app.subscription.level,
        icon: getPlanByProductId(app.subscription.productId, OS.DESKTOP, true)
          .icon,
        roomId,
      };
    }
  }

  try {
    await axios.post(channelUrl, data);
  } catch (error) {
    console.log("🚀 ~ BTC subs, channel server error", error?.message);
  }
  return true;
};

export const restoreBtcPurchase = async (_id) => {
  try {
    const appModel: any = db.getAppModel();
    const [app] = await appModel.find({ _id });
    if (!app) {
      return {
        isCancelled: true,
        error: "no matching app found",
      };
    }
    if (app?.subscription?.paymentType == SubscriptionPaymentType.BTC_PAYMENT) {
      const { expirationTime } = JSON.parse(
        app.subscription.transactionReceipt
      );
      if (new Date().getTime() <= expirationTime) {
        const subscription = {
          productId: app?.subscription.productId,
          receipt: app?.subscription.transactionReceipt,
          name: app?.subscription.plan,
          level: app?.subscription.level,
          icon: getPlanByProductId(
            app?.subscription.productId,
            OS.DESKTOP,
            true
          ).icon,
        };
        return subscription;
      } else {
        const nextSubscription = JSON.parse(
          app.subscription?.nextSubscription || "{}"
        );
        if (nextSubscription?.level !== AppSubscriptionLevel.ONE) {
          const { expirationTime } = JSON.parse(
            nextSubscription.transactionReceipt
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
              ...app.subscription,
              icon: getPlanByProductId(
                app.subscription.productId,
                OS.DESKTOP,
                true
              ).icon,
            };
          }
        }
        return {};
      }
    }
  } catch (error) {
    console.log("🚀 ~ restoreBtcPurchase ~ error:", error);
    throw new Error(error);
  }
};

