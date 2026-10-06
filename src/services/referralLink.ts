import db from "../db";
import { verifyReceipt } from "./app";
import { AppSubscriptionLevel } from "../interface";

export const createReferralLink = async (data) => {
  try {
    const referralLinkModel = db.getReferralLinkModel();
    const referralRecord = new referralLinkModel({
      ...data,
    });
    referralRecord.save((err) => {
      if (err) {
        console.log("🚀 ~ referralRecord.save ~ err:", err);
        throw new Error(err?.message);
      }
    });
    return { updated: true };
  } catch (error) {
    console.log("🚀 ~ createReferralLink error:", error);
    throw new Error(error.message);
  }
};

export const getReferralLink = async () => {
  try {
    const referralLinkModel = db.getReferralLinkModel();
    const resellers = await referralLinkModel.aggregate([
      { $match: { isReseller: true } },
      {
        $project: {
          id: "$_id",
          _id: 0,
          identifier: 1,
          link: 1,
          title: 1,
          country: 1,
          subTitle: 1,
          icon: 1,
        },
      },
    ]);
    const sellers = await referralLinkModel.aggregate([
      { $match: { isReseller: false } },
      {
        $project: {
          id: "$_id",
          identifier: 1,
          link: 1,
          _id: 0,
        },
      },
    ]);

    return { sellers, resellers };
  } catch (error) {
    console.log("🚀 ~ getReferralLink error:", error);
    throw new Error(error.message);
  }
};
