import { BackupUpgradeRequired, InvalidBackupRequest, BackupConflict, getBackupSnapshot, repairAppBackup } from "../services/backupSnapshot";
import { Express, Router, Request, Response, response } from "express";

import config from "../config";
import semver from "semver";
import * as messageCentre from "../services/messageCentre";
import * as notifications from "../services/notifications";
import * as releaseNotes from "../services/releaseNotes";
import * as btcPay from "../services/payWithBtc";
import * as keeperPrivate from "../services/keeperPrivate";

import * as bhr from "../services/bhr";
import { PromotionalOfferSignatureCreator } from "@apple/app-store-server-library";
import { readFile } from "fs";
import {
  createNewApp,
  getSubscriptionDetails,
  updateStoreSubscription,
  verifyReceipt,
  createRemoteKey,
  getRemoteKey,
  getActiveCampaign,
  updateContactsKey,
} from "../services/app";
import * as uuid from "uuid";

import { getExchangeRates } from "../services/rates";
import { getReleaseTopic } from "../utils/getReleaseTopic";
import { checkQuota, incrementQuota } from "../services/faucetQuota";
import {
  getFeeInsightData,
  getOneDayGraphData,
  getOneWeekGraphData,
  getWidgetData,
} from "../services/feeInsightsService";
import { getPlansForDesktop, iosBundleId, promoOffers } from "../utils/plans";
import {
  updateCollaborativeChannel,
  fetchCollaborativeChannel,
} from "../services/collaborative";
import { createReferralLink, getReferralLink } from "../services/referralLink";
import {
  createSwapTnx,
  getSwapCoins,
  getSwapQuote,
  getSwapTnxDetails,
} from "../services/swap";
import {
  addZendeskComment,
  createZendeskTicket,
  createZendeskUser,
  getZendeskDisabledResponse,
  getZendeskTicketComments,
  getZendeskTickets,
  getZendeskUser,
  isZendeskEnabled,
  uploadImagesToZendesk,
} from "../services/zendesk";
import { createAdvisor, getAdvisors } from "../services/advisor";
import { sendContactNotification } from "../services/contact";
import { generateSignedUrl } from "../services/ramp";
import {
  addRagChunkFrontendService,
  addRagChunkService,
  hasRagChunkAccessByPublicId,
  ingestArticlesService,
} from "../services/articleIngest";
import { chat, submitHelpIssue } from "../services/chat";
import { uploadScreenshotToGCS } from "../services/gcsStorage";
import { appIdRateLimiter } from "../middleware/appIdRateLimiter";
import { ipRateLimiter } from "../middleware/ipRateLimiter";

const fs = require("fs");
const path = require("path");
const multer = require("multer");
const memoryStorage = multer.memoryStorage();
const upload = multer({ memoryStorage });
const screenshotUpload = multer({ storage: multer.memoryStorage() });

export default class Routes {
  public app: Express;
  constructor(app: Express) {
    this.app = app;
  }

  public isNumber = (value: string): boolean => {
    return !isNaN(parseInt(value, 10));
  };

  public isAuthorized = (HEXA_ID: string): boolean => {
    if (config.HEXA_ID && HEXA_ID && config.HEXA_ID === HEXA_ID) {
      return true;
    }
    return false;
  };

  public isAdmin = (ADMIN_KEY: string): boolean => {
    if (config.ADMIN_KEY && ADMIN_KEY && ADMIN_KEY === config.ADMIN_KEY) {
      return true;
    }
    return false;
  };

  /**
   * Validates a ragTimestamp string (YYYY-MM-DD format only).
   * Returns a Date set to midnight UTC on success, or null if invalid.
   */
  public parseRagTimestamp = (value: string): Date | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00Z`);
    if (isNaN(date.getTime())) return null;
    // Guard against dates like "2025-13-45" that pass regex but are invalid
    const [year, month, day] = value.split("-").map(Number);
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() + 1 !== month ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return date;
  };

  public initializeRoutes = (): Router => {
    const router = this.app.get("router");
    const initializedAt = Date();
    const zendeskDisabledResponse = () =>
      getZendeskDisabledResponse({ status: 503 });

    router.get("/", (req, res) => {
      res.send(
        `${initializedAt} Relay: ENV:${config.ENVIRONMENT} V:${config.VERSION}`,
      );
    });

    // Authorization middleware
    // router.use((req, res, next) => {
    //   if (!this.isAuthorized(req.headers["hexa-id"])) {
    //     return res.status(400).json({ err: "Unauthorized request" });
    //   }
    //   next();
    // });

    router.post("/updateFCMTokens", async (req, res) => {
      if (!req.body.appID) {
        return res.status(400).json({ err: "Input param missing - appID" });
      }

      if (!req.body.FCMs) {
        return res.status(400).json({ err: "Input param missing - FCMs" });
      }

      if (req.body.FCMs.length === 0) {
        return res.status(400).json({ err: "FCMs array is empty" });
      }

      try {
        let appversion = req.headers.appversion;
        const updated = await messageCentre.updateFCMTokens(
          req.body.appID,
          req.body.FCMs,
          appversion,
        );
        res.status(200).json({ updated });
      } catch (err) {
        console.log(err);
        res.status(400).json({
          err: err.message,
        });
      }
    });

    router.post("/feeInsightSub", async (req, res) => {
      try {
        const updated = await messageCentre.feeinsightSubscription(
          req.body.FCMs,
        );
        res.status(200).json({ updated });
      } catch (err) {
        console.log(err);
        res.status(400).json({
          err: err.message,
        });
      }
    });

    router.post("/storeReleaseNotes", async (req, res) => {
      if (!this.isAdmin(req.body.ADMIN_KEY)) {
        return res.status(400).json({ err: "Unauthorized request" });
      }

      if (!req.body.build) {
        return res.status(400).json({ err: "Input param missing - build" });
      }

      if (isNaN(parseFloat(req.body.build))) {
        return res
          .status(400)
          .json({ err: "Input param build should be an integer/float" });
      }

      if (!req.body.version) {
        return res.status(400).json({ err: "Input param missing - version" });
      }

      if (!req.body.notes) {
        return res.status(400).json({ err: "Input param missing - notes" });
      }

      if (!req.body.reminderLimit) {
        return res
          .status(400)
          .json({ err: "Input param missing - reminderLimit" });
      }

      if (!this.isNumber(req.body.reminderLimit)) {
        return res.status(400).json({
          err: "Type error: reminderLimit can only be of type Number",
        });
      }

      try {
        let appversion = req.body.version;
        const releaseTopic = getReleaseTopic(appversion);
        const stored = await releaseNotes.storeReleaseNotes(
          req.body.build,
          req.body.version,
          req.body.notes,
          req.body.reminderLimit,
          releaseTopic,
        );
        res.status(200).json({ stored });
      } catch (err) {
        res.status(400).json({
          err: err.message,
        });
      }
    });

    router.post("/releaseBroadcast", async (req, res) => {
      if (!this.isAdmin(req.body.ADMIN_KEY)) {
        return res.status(400).json({ err: "Unauthorized request" });
      }

      if (!req.body.build) {
        return res.status(400).json({ err: "Input param missing - build" });
      }

      if (isNaN(parseFloat(req.body.build))) {
        return res
          .status(400)
          .json({ err: "Input param build should be an integer/float" });
      }

      if (!req.body.version) {
        return res.status(400).json({ err: "Input param missing - version" });
      }

      if (!req.body.notes) {
        return res.status(400).json({ err: "Input param missing - notes" });
      }

      if (!req.body.reminderLimit) {
        return res
          .status(400)
          .json({ err: "Input param missing - reminderLimit" });
      }

      if (!this.isNumber(req.body.reminderLimit)) {
        return res.status(400).json({
          err: "Type error: reminderLimit can only be of type Number",
        });
      }

      try {
        const stored = await messageCentre.newReleaseMessage(
          req.body.build,
          req.body.version,
          req.body.notes,
          req.body.reminderLimit,
        );
        res.status(200).json({ stored });
      } catch (err) {
        res.status(400).json({
          err: err.message,
        });
      }
    });

    router.post("/sendNotifications", async (req, res) => {
      if (!req.body.receivers) {
        return res.status(400).json({ err: "Input param missing - receivers" });
      }

      if (req.body.receivers.length === 0) {
        return res.status(400).json({ err: "Receiver's array is empty" });
      }

      if (!req.body.notification) {
        return res
          .status(400)
          .json({ err: "Input param missing - notification" });
      }

      try {
        const sent = await messageCentre.sendNotifications(
          req.body.receivers,
          req.body.notification,
        );
        res.status(200).json({ sent });
      } catch (err) {
        res.status(400).json({
          err: err.message,
        });
      }
    });

    router.post("/sendKeeperNotifications", async (req, res) => {
      if (!req.body.notification) {
        return res
          .status(400)
          .json({ err: "Input param missing - notification" });
      }

      try {
        const sent = await messageCentre.sendKeeperNotifications(
          req.body.notification,
          req.body.FCMs,
          req.body.AppIds,
        );
        res.status(200).json({ sent });
      } catch (err) {
        res.status(400).json({
          err: err.message,
        });
      }
    });

    //API to handle migrations for v1.2.9
    router.post("/migrateXfps", async (req, res) => {
      if (!req.body.appId || !req.body.signerChanges) {
        return res
          .status(400)
          .json({ err: "Input param missing - appId or signerChnages" });
      }

      try {
        const updated = await bhr.migrateXfp(
          req.body.appId,
          req.body.signerChanges,
        );
        res.status(200).json({ updated });
      } catch (err) {
        res.status(400).json({
          updated: false,
          err: err.message,
        });
      }
    });

    router.post("/fetchFeeAndExchangeRates", async (req, res) => {
      try {
        const exchangeRates = await getExchangeRates(req.body.currencyCode);
        if (exchangeRates) {
          res.status(200).json({
            exchangeRates,
          });
        }
      } catch (err) {
        res.status(400).json({
          // respond with error
          err: err.message,
        });
      }
    });

    router.get("/widgetData", async (req, res) => {
      try {
        const widgetData = await getWidgetData();
        if (widgetData) {
          res.status(200).json(widgetData);
        } else {
          res.status(400).json({
            err: "No data found",
          });
        }
      } catch (err) {
        res.status(400).json({
          err: err.message,
        });
      }
    });

    router.get("/oneDayGraphData", async (req, res) => {
      try {
        const graphData = await getOneDayGraphData();
        if (graphData) {
          res.status(200).json(graphData);
        } else {
          res.status(400).json({
            err: "No data found",
          });
        }
      } catch (err) {
        res.status(400).json({
          err: err.message,
        });
      }
    });

    router.get("/oneWeekGraphData", async (req, res) => {
      try {
        const widgetData = await getOneWeekGraphData();
        if (widgetData) {
          res.status(200).json(widgetData);
        } else {
          res.status(400).json({
            err: "No data found",
          });
        }
      } catch (err) {
        res.status(400).json({
          err: err.message,
        });
      }
    });

    router.get("/feeInsighData", async (req, res) => {
      try {
        const insightData = await getFeeInsightData();
        if (insightData) {
          res.status(200).json(insightData);
        } else {
          res.status(400).json({
            err: "No data found",
          });
        }
      } catch (err) {
        res.status(400).json({
          err: err.message,
        });
      }
    });

    router.post("/getVaultMetaData", async (req, res) => {
      if (!req.body.xfpHash) {
        return res
          .status(400)
          .json({ err: "Input param missing - masterfingerprint" });
      }
      try {
        const response = await bhr.getVaultMetaData(
          req.body.xfpHash,
          req.body.signerId,
        );
        res.status(200).json(response);
      } catch (err) {
        console.log("No vault for the signer exsists", err);

        res.status(200).json({
          error: "No vault for the signer exsists",
        });
      }
    });

    router.post("/getSignerIdInfo", async (req, res) => {
      if (!req.body.signerId) {
        return res.status(400).json({ err: "Input param missing - Signer Id" });
      }

      try {
        const exsists = await bhr.getSignerIdInfo(req.body.signerId);
        res.status(200).json({ exsists });
      } catch (err) {
        res.status(400).json({
          err: "Signer Id exsists",
        });
      }
    });

    router.post("/getMessages", async (req, res) => {
      if (!req.body.appID) {
        return res.status(400).json({ err: "Input param missing - appID" });
      }

      try {
        const messages = await messageCentre.getMessages(
          req.body.appID,
          req.body.timeStamp,
          req.headers.appversion,
        );
        res.status(200).json({ messages });
      } catch (err) {
        console.log("getMessages Error", err);

        res.status(400).json({
          err: err.message,
        });
      }
    });

    router.post("/updateAppImage", async (req, res) => {
      if (!req.body.appId) {
        return res.status(400).json({ err: "Input param missing - app's id" });
      }
      // Older mobile clients send walletObject and signersObjects.
      const hasField = (name: string) => Object.prototype.hasOwnProperty.call(req.body, name);
      if ((hasField("walletsObject") && hasField("walletObject")) ||
          (hasField("signersObject") && hasField("signersObjects"))) {
        return res.status(400).json({ updated: false, error: "Conflicting backup record fields" });
      }
      try {
        const result = await bhr.updateAppImage(
          req.body.appId,
          req.body.publicId,
          hasField("walletsObject") ? req.body.walletsObject : req.body.walletObject,
          req.body.subscription,
          req.body.version,
          hasField("signersObject") ? req.body.signersObject : req.body.signersObjects,
          req.body.nodes,
          req.body.replaceNodes === true,
        );
        res.status(200).json(result);
      } catch (err) {
        res.status(400).json(err);
      }
    });

    router.post("/deleteAppImageEntity", async (req, res) => {
      if (!req.body.appId) {
        return res.status(400).json({ err: "Input param missing - app's id" });
      }
      try {
        const result = await bhr.deleteAppImageEntity(
          req.body.appId,
          req.body.walletIds,
          req.body.signers,
        );
        res.status(200).json(result);
      } catch (err) {
        res.status(400).json(err);
      }
    });

    router.post("/deleteVaults", async (req, res) => {
      if (!req.body.appId) {
        return res.status(400).json({ err: "Input param missing - app's id" });
      }
      try {
        const result = await bhr.deleteVaults(req.body.appId, req.body.vaults);
        res.status(200).json(result);
      } catch (err) {
        res.status(400).json(err);
      }
    });

    router.post("/updateVaultImage", async (req, res) => {
      try {
        if (!req.body.vaultId) {
          throw new Error("VaultId is not present");
        }
        if (req.body.isUpdate) {
          const updated = await bhr.updateVault(
            req.body.vaultId,
            req.body.vault,
            req.body.appId ?? req.body.appID,
            req.body.isArchived,
            req.body.signersData,
          );
          if (updated) {
            return res.status(200).json({
              updated: true,
              error: "",
            });
          }
          return res.status(503).json({
            updated: false,
            error: "Backup update failed",
          });
        }
        const result = await bhr.addVaultImage(
          req.body.appId ?? req.body.appID,
          req.body.vaultShellId,
          req.body.vaultId,
          req.body.scheme,
          req.body.vault,
          req.body.signersData,
          req.body.subscription,
          req.body.archiveVaultId,
          req.body.isArchived,
        );
        res.status(200).json(result);
      } catch {
        res.status(400).json({
          updated: false,
          error: "Vault backup update failed",
        });
      }
    });

    router.post("/getAppImage", async (req, res) => {
      if (!req.body.appId)
        return res.status(400).json({ err: "Input param missing - id" });

      if (!req.headers.appversion)
        return res
          .status(400)
          .json({ err: "Input param missing - appversion" });

      try {
        const data = await bhr.getAppImage(
          req.body.appId,
          req.headers.appversion,
        );
        if (data) {
          res.status(200).json(data);
        } else {
          res.status(400).json({ err: "no appImage" });
        }
      } catch {
        // Always terminate the request. The client must not mistake missing
        // account metadata or a database failure for an empty recoverable image.
        res.status(503).json({ err: "Backup temporarily unavailable" });
      }
    });

    router.post("/createNewApp", async (req, res) => {
      if (!req.headers.appversion) {
        return res
          .status(400)
          .json({ err: "Input param missing - appversion" });
      }
      if (!req.headers.os) {
        return res.status(400).json({ err: "Input param missing - os" });
      }
      if (!req.body.publicId) {
        return res.status(400).json({ err: "Input param missing - publicId" });
      }
      if (!req.body.appID) {
        return res.status(400).json({ err: "Input param missing - app id" });
      }
      try {
        const result = await createNewApp(
          req.body.publicId,
          req.body.appID,
          req.headers.os,
          req.headers.appversion,
          req.body.fcmToken || "",
        );
        if (result) {
          res.status(200).json({ created: result });
        } else {
          res.status(400).json({ err: "failed to create" });
        }
      } catch (err) {
        console.log(err);
      }
    });

    router.post("/updateContactsKey", async (req, res) => {
      if (!req.body.id) {
        return res.status(400).json({ err: "Input param missing - id" });
      }
      if (!req.body.contactsKey) {
        return res
          .status(400)
          .json({ err: "Input param missing - contactsKey" });
      }
      try {
        const result = await updateContactsKey(
          req.body.id,
          req.body.contactsKey || null,
        );
        if (result) {
          res.status(200).json({ updated: result });
        } else {
          res.status(400).json({ err: "failed to create" });
        }
      } catch (err) {
        console.log(err);
      }
    });

    router.post("/updateSubscription", async (req, res) => {
      if (!req.headers.os) {
        return res.status(400).json({ err: "Input param missing - os" });
      }
      if (!req.body.id) {
        return res.status(400).json({ err: "Input param missing - id" });
      }
      if (!req.body.appID) {
        return res.status(400).json({ err: "Input param missing - app id" });
      }
      if (!req.body.data || !req.body.data.productId) {
        return res.status(400).json({ err: "Invalid param - data" });
      }
      try {
        const result = await updateStoreSubscription(
          req.body.id,
          req.body.appID,
          req.headers.os,
          req.body.data,
          req.body?.newPlans || false,
        );
        if (result.updated) {
          res.status(200).json(result);
        } else {
          res.status(400).json(result);
        }
      } catch (err) {
        console.log(err);
      }
    });

    router.post("/verifyReceipt", async (req, res) => {
      if (!req.headers.os) {
        return res.status(400).json({ err: "Input param missing - os" });
      }
      if (!req.body.id) {
        return res.status(400).json({ err: "Input param missing - id" });
      }
      if (!req.body.appID) {
        return res.status(400).json({ err: "Input param missing - app id" });
      }
      try {
        const result = await verifyReceipt(
          req.body.id,
          req.body.appID,
          req.headers.os,
        );
        res.status(200).json({ isValid: !result.isCancelled, ...result });
      } catch (err) {
        console.log(err);
      }
    });

    router.post("/getSubscriptionDetails", async (req, res) => {
      if (!req.headers.os) {
        return res.status(400).json({ err: "Input param missing - os" });
      }
      if (!req.body.id) {
        return res.status(400).json({ err: "Input param missing - id" });
      }
      if (!req.body.appID) {
        return res.status(400).json({ err: "Input param missing - app id" });
      }
      try {
        const result = await getSubscriptionDetails(
          req.headers.os,
          req.body.appID,
          req?.body?.newPlans,
        );
        res.status(200).json(result);
      } catch (err) {
        console.log(err);
      }
    });

    router.post("/modifyLabels", async (req, res) => {
      if (!req.body.appId) {
        return res.status(400).json({ err: "Input param missing - appId" });
      }
      try {
        const result = await bhr.modifyLabels(
          req.body.appId,
          req.body?.addLabels,
          req.body?.deleteLabels,
        );
        res.status(200).json(result);
      } catch (err) {
        res
          .status(400)
          .json({ updated: false, err: "failed to update the labels" });
        console.log(err);
      }
    });

    router.post("/testnetFaucet", async (req, res) => {
      if (!config.FAUCET_MNEMONIC) {
        return res.status(503).json({ err: "Testnet faucet is not configured" });
      }
      if (!req.body.appId) {
        return res.status(400).json({ err: "Input param missing - appId" });
      }

      if (!req.body.recipientAddress) {
        return res
          .status(400)
          .json({ err: "Input param missing - recipientAddress" });
      }

      try {
        await checkQuota(req.body.appId);
      } catch (err) {
        if (err.code === "FAUCET_DAILY_LIMIT_REACHED") {
          return res.status(429).json({
            err: "Daily limit reached. Try again after midnight UTC.",
            code: "FAUCET_DAILY_LIMIT_REACHED",
          });
        }
        return res.status(400).json({ err: err.message });
      }

      try {
        const TestnetFaucet = require("../services/testFaucet").default;
        const { txid } = await TestnetFaucet.transfer(
          req.body.recipientAddress,
        );
        if (txid) {
          await incrementQuota(req.body.appId);
          res.status(200).json({
            txid,
            funded: true,
          });
        } else {
          throw new Error("Unable to fund the supplied address");
        }
      } catch (err) {
        res.status(400).json({
          err: err.message,
        });
      }
    });

    router.post("/getCoins", async (req, res) => {
      if (!config.FAUCET_MNEMONIC) {
        return res.status(503).json({ err: "Testnet faucet is not configured" });
      }
      if (!req.body.recipientAddress) {
        return res
          .status(400)
          .json({ err: "Input param missing - recipientAddress" });
      }

      try {
        const TestnetFaucet = require("../services/testFaucet").default;
        const { txid } = await TestnetFaucet.transfer(
          req.body.recipientAddress,
          req.body.amount,
        );
        if (txid) {
          res.status(200).json({
            txid,
            funded: true,
          });
        } else {
          throw new Error("Unable to fund the supplied address");
        }
      } catch (err) {
        res.status(400).json({
          err: err.message,
        });
      }
    });

    router.post("/offer", async (req, res) => {
      if (!config.APPSTORE_KEY || !config.APPSTORE_KEY_ID) {
        return res.status(503).json({ err: "Promotional offers are not configured" });
      }
      try {
        const offers = promoOffers[config.ENVIRONMENT];
        const promoCode = req.body.promoCode;
        const productId = req.body.productId;
        const offer = offers.find((o) => o.promoCode === promoCode);
        if (offer) {
          const offerId = offer?.offerId[productId];
          if (offerId) {
            const offerCode = offer?.offerCode[productId];
            const keyId = config.APPSTORE_KEY_ID;
            const nonce = uuid.v4();
            const timestamp = Date.now();
            const signatureCreator = new PromotionalOfferSignatureCreator(
              config.APPSTORE_KEY,
              keyId,
              iosBundleId[config.ENVIRONMENT],
            );
            const signature = signatureCreator.createSignature(
              productId,
              offerId,
              "",
              nonce,
              timestamp,
            );
            res.status(200).json({
              signature,
              timestamp,
              nonce,
              keyIdentifier: keyId,
              identifier: offerId,
              offerCode,
            });
          } else {
            res.status(400).json({
              err: "Invalid promo code",
            });
          }
        } else {
          res.status(400).json({
            err: "Invalid promo code",
          });
        }
      } catch (err) {
        console.log(err);
        res.status(400).json({
          err: err.message,
        });
      }
    });

    router.post("/createRemoteKey", async (req, res) => {
      if (!req.body.data || !req.body.hash) {
        return res.status(400).json({ err: "Input param missing - data" });
      }

      try {
        const { data, hash } = req.body;
        const result = await createRemoteKey(data, hash);
        if (result) {
          res.status(200).json(result);
        } else {
          res.status(400).json({ err: "failed to create" });
        }
      } catch (err) {
        console.log("🚀 ~ Routes ~ createRemoteKey ~ err:", err);
      }
    });

    router.get("/getRemoteKey", async (req, res) => {
      if (!req.query.hash) {
        return res.status(400).json({ err: "Input param missing - id" });
      }

      try {
        const externalKey = await getRemoteKey(req.query.hash);
        res.status(200).json(externalKey);
      } catch (err) {
        console.log("🚀 ~ Routes ~ getRemoteKey ~ err:", err);
        res.status(400).json({
          err: err.message,
        });
      }
    });

    router.post("/sendSingleNotification", async (req, res) => {
      if (!req.body.fcm) {
        return res.status(400).json({ err: "Input param missing - fcm" });
      }
      if (!req.body.notification) {
        return res
          .status(400)
          .json({ err: "Input param missing - notification" });
      }
      if (!req.body.data) {
        return res.status(400).json({ err: "Input param missing - data" });
      }
      const { fcm, notification, data } = req.body;
      try {
        const message = {
          notification,
          data,
        };
        const response = await messageCentre.sendSingleNotification(
          message,
          fcm,
        );

        res.status(200).json({ response });
      } catch (error) {
        console.log("🚀 ~ Routes ~ sendSingleNotification ~ error:", error);
        return res.status(400).json({ err: error });
      }
    });

    router.post("/zendeskNotification", async (req, res) => {
      if (!req.body.external_id) {
        return res
          .status(400)
          .json({ err: "Input param missing - external_id" });
      }

      if (!req.body.status) {
        return res.status(400).json({ err: "Input param missing - status" });
      }

      if (!req.body.id) {
        return res.status(400).json({ err: "Input param missing - id" });
      }
      try {
        const data = await messageCentre.sendZendeskNotification(req.body);
        res.status(200).json(data);
      } catch (error) {
        console.log("🚀 ~ Routes ~ router.post ~ error:", error);
        res.status(400).json({
          err: error.message,
        });
      }
    });

    router.post("/updateZendeskExternalId", async (req, res) => {
      if (!req.body.appID) {
        return res.status(400).json({ err: "Input param missing - appID" });
      }

      if (!req.body.FCM) {
        return res.status(400).json({ err: "Input param missing - FCMs" });
      }

      if (!req.body.externalId) {
        return res
          .status(400)
          .json({ err: "Input param missing - externalId" });
      }

      try {
        const data = await messageCentre.addZendeskExternalId(
          req.body.appID,
          req.body.FCM,
          req.body.externalId,
        );
        res.status(200).json(data);
      } catch (err) {
        res.status(400).json({
          err: err.message,
        });
      }
    });

    router.post("/updateCollaborativeChannel", async (req, res) => {
      if (!req.body.channelId) {
        return res.status(400).json({ err: "Input param missing - channelId" });
      }

      if (!req.body.encryptedData) {
        return res
          .status(400)
          .json({ err: "Input param missing - encryptedData" });
      }

      try {
        const data = await updateCollaborativeChannel(
          req.body.channelId,
          req.body.encryptedData,
        );
        res.status(200).json(data);
      } catch (err) {
        res.status(400).json({
          err: err.message,
        });
      }
    });

    router.post("/fetchCollaborativeChannel", async (req, res) => {
      if (!req.body.channelId) {
        return res.status(400).json({ err: "Input param missing - channelId" });
      }

      try {
        const data = await fetchCollaborativeChannel(req.body.channelId);
        res.status(200).json(data);
      } catch (err) {
        res.status(400).json({
          err: err.message,
        });
      }
    });

    router.post("/getBackupSnapshot", async (req, res) => {
      if (typeof req.body.appId !== "string" || !req.body.appId) return res.status(400).json({ error: "Invalid backup account" });
      try { return res.status(200).json(await getBackupSnapshot(req.body.appId)); }
      catch { return res.status(503).json({ error: "Backup snapshot unavailable" }); }
    });
    router.post("/repairAppBackup", async (req, res) => {
      try { return res.status(200).json(await repairAppBackup(req.body)); }
      catch (error) {
        return res.status(error instanceof BackupConflict ? 409 : error instanceof InvalidBackupRequest ? 400 : 503).json({
          updated: false, error: error instanceof BackupConflict ? "BACKUP_CHANGED" : "BACKUP_NOT_UPDATED",
        });
      }
    });

    router.post("/backupAllSignersAndVaults", async (req, res) => {
      if (!req.body.appId) {
        return res.status(400).json({ err: "Input param missing - app's id" });
      }
      try {
        const result = await bhr.backupAllSignersAndVaults(req.body);
        res.status(200).json(result);
      } catch (err) {
        res.status(err instanceof BackupUpgradeRequired || err instanceof BackupConflict ? 409 : err instanceof InvalidBackupRequest ? 400 : 503).json({
          updated: false,
          error: err instanceof BackupUpgradeRequired ? "BACKUP_UPGRADE_REQUIRED" : err instanceof BackupConflict ? "BACKUP_CHANGED" : "BACKUP_NOT_UPDATED",
        });
      }
    });

    router.post("/deleteBackup", async (req, res) => {
      if (!req.body.appId) {
        return res.status(400).json({ err: "Input param missing - app's id" });
      }
      try {
        const result = await bhr.deleteBackup(req.body.appId);
        res.status(200).json(result);
      } catch (err) {
        console.log("🚀 ~deleteBackup err:", err);
        res.status(400).json(err);
      }
    });

    router.post("/createHardwareReferralLinks", async (req, res) => {
      if (!req.body.appId) {
        return res.status(400).json({ err: "Input param missing - app's id" });
      }
      try {
        const result = await createReferralLink(req?.body?.data);
        res.status(200).json(result);
      } catch (err) {
        console.log("🚀 ~ createHardwareReferralLinks ~ err:", err);
        res.status(400).json(err);
      }
    });

    router.get("/getHardwareReferralLinks", async (req, res) => {
      try {
        if (!req.query.appId) {
          return res
            .status(400)
            .json({ err: "Input param missing - app's id" });
        }
        const result = await getReferralLink();
        res.status(200).json(result);
      } catch (err) {
        console.log("🚀 getHardwareReferralLinks err:", err?.message);
        res.status(400).json({ err: err?.message });
      }
    });

    // Webhook from btcPayServer for payment confirmation
    router.post("/btcPayServer", async (req, res) => {
      try {
        await btcPay.confirmBtcPayment(req.body);
        res.status(200).json({ message: "received" });
      } catch (error) {
        console.log("🚀 ~ Routes ~ router.get ~ error:", error);
        res.status(400).json(error);
      }
    });

    router.post("/eligibleForBtcPay", async (req, res) => {
      try {
        const response = await btcPay.checkEligibility(req.body);
        res.status(200).json(response);
      } catch (error) {
        console.log("🚀 ~ /createBTCPayOrder: ", error);
        res.status(400).json(error);
      }
    });

    router.get("/restoreBtcPurchase", async (req, res) => {
      if (!req.query.appId) {
        return res.status(400).json({ err: "Input param missing - app's id" });
      }
      try {
        const result = await btcPay.restoreBtcPurchase(req.query.appId);
        res.status(200).json(result);
      } catch (err) {
        console.log("🚀 /restoreBtcPurchase err:", err);
        res.status(400).json(err);
      }
    });

    // Subscription details for desktop app
    router.get("/getSubscriptionsDesktop", async (req, res) => {
      try {
        const result = getPlansForDesktop();
        res.status(200).json(result);
      } catch (err) {
        console.log("🚀 /restoreBtcPurchase err:", err);
        res.status(400).json(err);
      }
    });

    router.get("/getKeeperPrivateRedeemLink", async (req, res) => {
      try {
        if (!this.isAdmin(req.headers["admin-key"]))
          return res.status(400).json({ err: "Unauthorized request" });
        if (!req?.query.accountManagerId)
          return res
            .status(400)
            .json({ err: "Input param missing - accountManagerId" });
        const count = req?.query.create ?? null;
        const result = await keeperPrivate.getKeeperPrivateRedeemLink(
          count,
          req?.query?.accountManagerId,
        );
        res.status(200).json(result);
      } catch (err) {
        console.log("🚀 /getKeeperPrivateRedeemLink err:", err);
        res.status(400).json(err);
      }
    });

    router.post("/redeemKeeperPrivate", async (req, res) => {
      if (!req.body.appId)
        return res.status(400).json({ err: "Input param missing - app Id" });
      if (!req.body.redeemCode)
        return res
          .status(400)
          .json({ err: "Input param missing - redeem code" });
      if (!req.body.accountManagerId)
        return res
          .status(400)
          .json({ err: "Input param missing - accountManagerId" });
      try {
        const result = await keeperPrivate.redeemKeeperPrivateSubscription(
          req.body.appId,
          req.body.redeemCode,
          req.body.accountManagerId,
        );
        res.status(200).json(result);
      } catch (err) {
        console.log("🚀 /redeemKeeperPrivate err:", err);
        res.status(400).json(err);
      }
    });

    router.post("/createAccountManager", async (req, res) => {
      try {
        if (!this.isAdmin(req.headers["admin-key"]))
          return res.status(400).json({ err: "Unauthorized request" });
        if (!req.body.fullName)
          return res
            .status(400)
            .json({ err: "Input param missing - fullName" });
        if (!req.body.links)
          return res.status(400).json({ err: "Input param missing - links" });
        if (!req.body.image)
          return res.status(400).json({ err: "Input param missing - image" });
        const result = await keeperPrivate.createAccountManager(req.body);
        res.status(200).json(result);
      } catch (err) {
        console.log("🚀 ~ createAccountManager err:", err);
        res.status(400).json(err.message);
      }
    });

    router.get("/getAccountManagerDetails", async (req, res) => {
      try {
        if (!req.query.appId)
          return res.status(400).json({ err: "Input param missing - appId" });
        const result = await keeperPrivate.getAccountManagerDetails(
          req.query.appId,
        );
        res.status(200).json(result);
      } catch (err) {
        console.log("🚀 ~ getAccountManagerDetails err:", err);
        res.status(400).json(err.message);
      }
    });

    router.get("/getActiveCampaign", async (req, res) => {
      try {
        if (!req.query.appId)
          return res.status(400).json({ err: "Input param missing - appId" });
        const result = await getActiveCampaign();
        res.status(200).json(result);
      } catch (err) {
        console.log("🚀 ~ getActiveCampaign err:", err);
        res.status(400).json(err.message);
      }
    });

    router.get("/getSwapCoins", async (req, res) => {
      try {
        const result = await getSwapCoins();
        res.status(200).json(result);
      } catch (err) {
        res.status(400).json(err);
      }
    });

    router.post("/getSwapQuote", async (req, res) => {
      try {
        if (!req.body.coinFrom)
          return res
            .status(400)
            .json({ err: "Input param missing - coinFrom" });
        if (!req.body.coinTo)
          return res.status(400).json({ err: "Input param missing - coinTo" });
        if (!req.body.amount)
          return res.status(400).json({ err: "Input param missing - amount" });
        if (req.body.float === undefined || req.body.float === null)
          return res.status(400).json({ err: "Input param missing - float" });
        const result = await getSwapQuote(req.body);
        res.status(200).json(result);
      } catch (err) {
        res.status(400).json(err);
      }
    });

    router.post("/createSwapTnx", async (req, res) => {
      try {
        if (!req.body.coinFrom)
          return res.status(400).json("Input param missing - coinFrom");
        if (!req.body.coinTo)
          return res.status(400).json("Input param missing - coinTo");
        if (!req.body.depositAmount)
          return res.status(400).json("Input param missing - depositAmount");
        if (req.body.float === undefined || req.body.float === null)
          return res.status(400).json("Input param missing - float");
        if (!req.body.withdrawal)
          return res.status(400).json("Input param missing - withdrawal");
        //Test for valid coins
        const VALID_CODES = ["BTC", "USDT-TRC20"];
        if (!VALID_CODES.includes(req.body.coinFrom?.code))
          return res.status(400).json(`Invalid coinFrom code`);
        if (!VALID_CODES.includes(req.body.coinTo?.code))
          return res.status(400).json(`Invalid coinTo code`);
        const result = await createSwapTnx(req.body);
        res.status(200).json(result);
      } catch (err) {
        console.log("🚀 ~ Routes ~ router.post ~ err:", err);
        res.status(400).json(err?.message);
      }
    });

    router.get("/getSwapTnxDetails", async (req, res) => {
      try {
        if (!req.query.tnxId)
          return res.status(400).json({ err: "Input param missing - tnxId" });
        const result = await getSwapTnxDetails(req.query.tnxId);
        res.status(200).json(result);
      } catch (err) {
        res.status(400).json(err);
      }
    });

    router.post(
      "/uploadZendeskImages",
      upload.array("files"),
      async (req, res) => {
        if (!isZendeskEnabled()) {
          return res.status(200).json(zendeskDisabledResponse());
        }
        if (!req.files || req.files.length === 0)
          return res.status(400).json({ err: "No files uploaded" });
        try {
          const tokens = await uploadImagesToZendesk(req.files);
          res.status(200).json(tokens);
        } catch (error) {
          console.log("🚀 ~ Routes ~ uploadZendeskImages ~ error:", error);
          res.status(400).json("Failed to upload images");
        }
      },
    );

    router.get("/getZendeskTickets", async (req, res) => {
      if (!isZendeskEnabled()) {
        return res.status(500).json(getZendeskDisabledResponse());
      }
      if (!req.query.conciergeUserId)
        return res
          .status(400)
          .json({ err: "Input param missing - conciergeUserId" });
      try {
        const tickets = await getZendeskTickets(req.query.conciergeUserId);
        res.status(200).json(tickets);
      } catch (error) {
        console.log("🚀 ~ Routes ~ getZendeskTickets ~ error:", error);
        res.status(400).json("Failed to get tickets");
      }
    });

    router.get("/getZendeskTicketComments", async (req, res) => {
      if (!isZendeskEnabled()) {
        return res.status(200).json(getZendeskDisabledResponse());
      }
      if (!req.query.ticketId)
        return res.status(400).json({ err: "Input param missing - ticketId" });
      try {
        const comments = await getZendeskTicketComments(req.query.ticketId);
        res.status(200).json(comments);
      } catch (error) {
        console.log("🚀 ~ Routes ~ getZendeskTicketComments ~ error:", error);
        res.status(400).json("Failed to get ticket comments");
      }
    });

    router.get("/getZendeskUser", async (req, res) => {
      if (!isZendeskEnabled()) {
        return res.status(200).json(getZendeskDisabledResponse());
      }
      if (!req.query.userExternalId)
        return res
          .status(400)
          .json({ err: "Input param missing - userExternalId" });
      try {
        const comments = await getZendeskUser(req.query.userExternalId);
        res.status(200).json(comments);
      } catch (error) {
        console.log("🚀 ~ Routes ~ getZendeskUser ~ error:", error);
        res.status(400).json("Failed to get user details");
      }
    });

    router.post("/createZendeskUser", async (req, res) => {
      if (!isZendeskEnabled()) {
        return res.status(200).json(zendeskDisabledResponse());
      }
      if (!req.body.userExternalId)
        return res
          .status(400)
          .json({ err: "Input param missing - userExternalId" });
      if (!req.body.os)
        return res.status(400).json({ err: "Input param missing - os" });
      try {
        const comments = await createZendeskUser(
          req.body.userExternalId,
          req.body.os,
        );
        res.status(200).json(comments);
      } catch (error) {
        console.log("🚀 ~ Routes ~ createZendeskUser ~ error:", error);
        res.status(400).json("Failed to create user");
      }
    });

    router.post("/addZendeskComment", async (req, res) => {
      if (!isZendeskEnabled()) {
        return res.status(200).json(zendeskDisabledResponse());
      }
      if (!req.body.ticketId)
        return res.status(400).json({ err: "Input param missing - ticketId" });
      if (!req.body.conciergeUserId)
        return res
          .status(400)
          .json({ err: "Input param missing - conciergeUserId" });
      if (!req.body.desc)
        return res.status(400).json({ err: "Input param missing - desc" });
      try {
        const comments = await addZendeskComment(req.body);
        res.status(200).json(comments);
      } catch (error) {
        console.log("🚀 ~ Routes ~ addZendeskComment ~ error:", error);
        res.status(400).json("Failed to add comment");
      }
    });

    router.post("/createZendeskTicket", async (req, res) => {
      if (!isZendeskEnabled()) {
        return res.status(200).json(zendeskDisabledResponse());
      }
      if (!req.body.onboardEmail) {
        if (!req.body.conciergeUser)
          return res
            .status(400)
            .json({ err: "Input param missing - conciergeUser" });
        if (!req.body.desc)
          return res.status(400).json({ err: "Input param missing - desc" });
      }
      try {
        const comments = await createZendeskTicket(req.body);
        res.status(200).json(comments);
      } catch (error) {
        console.log("🚀 ~ Routes ~ addZendeskComment ~ error:", error);
        res.status(400).json("Failed to add comment");
      }
    });

    router.post("/createAdvisor", async (req, res) => {
      try {
        if (!this.isAdmin(req.headers["admin-key"]))
          return res.status(400).json({ err: "Unauthorized request" });
        const result = await createAdvisor(req.body);
        res.status(200).json(result);
      } catch (err) {
        res.status(400).json(err);
      }
    });

    router.get("/getAdvisors", async (req, res) => {
      try {
        const result = await getAdvisors();
        res.status(200).json(result);
      } catch (err) {
        res.status(400).json(err);
      }
    });

    router.post("/sendContactNotification", async (req, res) => {
      try {
        if (!this.isAdmin(req.headers["admin-key"]))
          return res.status(400).json({ err: "Unauthorized request" });
        const data = await sendContactNotification(req.body);
        res.status(200).json(data);
      } catch (error) {
        console.log("🚀 ~ Routes ~ router.post ~ error:", error);
        res.status(400).json({
          err: error.message,
        });
      }
    });

    router.get("/getRampUrl", async (req, res) => {
      if (!req.query.appId)
        return res.status(400).json({ err: "Input param missing - appId" });
      if (!req.query.swapAsset)
        return res.status(400).json({ err: "Input param missing - swapAsset" });
      if (!req.query.flow)
        return res.status(400).json({ err: "Input param missing - flow" });
      try {
        const { userAddress, swapAsset, flow } = req.query;
        const result = generateSignedUrl(userAddress, swapAsset, flow);
        return res.status(200).json(result);
      } catch (error) {
        console.error("❌ Error:", (error as Error).message);
        return res
          .status(400)
          .json({ error: "Error while generating ramp url" });
      }
    });

    router.post(
      "/chat",
      // The following two rate limiters apply to the /chat endpoint, but only count requests
      // where there is no messages array or the messages array has 1 or fewer items.
      // This is to allow multi-message requests (e.g., chat history sync) to bypass the stricter rate limit,
      // while still rate limiting normal single-message chat requests.
      appIdRateLimiter({
        scope: "chat",
        shouldCount: (req) =>
          !Array.isArray(req?.body?.messages) || req.body.messages.length <= 1,
      }),
      ipRateLimiter({
        scope: "chat",
        shouldCount: (req) =>
          !Array.isArray(req?.body?.messages) || req.body.messages.length <= 1,
      }),
      // The next two rate limiters apply to all /chat requests (regardless of messages array),
      // but with a different scope ("chatMessage"). This allows for layered rate limiting:
      // - "chat" scope: stricter, only for single-message requests
      // - "chatMessage" scope: broader, applies to all requests for overall abuse prevention
      appIdRateLimiter({ scope: "chatMessage" }),
      ipRateLimiter({ scope: "chatMessage" }),
      async (req, res) => {
        try {
          const {
            conversationId,
            messages = [],
            userText,
            metadata,
            appId,
          } = req.body;

          if (!appId || typeof appId !== "string") {
            return res.status(400).json({ error: "appId is required" });
          }

          if (!conversationId || typeof conversationId !== "string") {
            return res
              .status(400)
              .json({ error: "conversationId is required" });
          }

          if (!userText || typeof userText !== "string") {
            return res.status(400).json({ error: "userText is required" });
          }

          if (!metadata || typeof metadata !== "object") {
            return res.status(400).json({ error: "metadata is required" });
          }

          const result = await chat({
            conversationId,
            messages,
            userText,
            metadata,
          });
          return res.status(200).json(result);
        } catch (error) {
          console.error("Chat error:", error);
          const err = error as Error;
          return res
            .status(500)
            .json({ error: err.message || "Internal server error" });
        }
      },
    );

    router.post(
      "/submitHelpIssue",
      appIdRateLimiter({ scope: "helpIssue" }),
      ipRateLimiter({ scope: "helpIssue" }),
      screenshotUpload.fields([
        { name: "file_0", maxCount: 1 },
        { name: "file_1", maxCount: 1 },
        { name: "file_2", maxCount: 1 },
      ]),
      async (req: Request, res: Response) => {
        try {
          // Support both plain JSON body and multipart (payload field + file_N fields)
          const payload =
            typeof req.body.payload === "string"
              ? JSON.parse(req.body.payload)
              : req.body;

          const screenshotUrls: string[] = [];
          const files = req.files as
            | { [fieldname: string]: Express.Multer.File[] }
            | undefined;
          if (files) {
            for (let i = 0; i < 3; i++) {
              const fileArr = files[`file_${i}`];
              if (fileArr?.[0]) {
                const { buffer, mimetype } = fileArr[0];
                const url = await uploadScreenshotToGCS(
                  buffer,
                  mimetype,
                  payload.conversationId
                );
                screenshotUrls.push(url);
              }
            }
          }

          const result = await submitHelpIssue({
            ...payload,
            screenshotUrls:
              screenshotUrls.length > 0 ? screenshotUrls : undefined,
          });
          return res.status(200).json(result);
        } catch (error) {
          console.error("submitHelpIssue error:", error);
          const err = error as Error;
          return res
            .status(400)
            .json({ error: err.message || "Issue submission failed" });
        }
      },
    );

    router.post("/ingestArticles", async (req, res) => {
      const adminKey = req.body?.ADMIN_KEY || req.headers["admin-key"];
      if (!this.isAdmin(adminKey as string)) {
        return res.status(400).json({ err: "Unauthorized request" });
      }

      try {
        const ingestSummary = await ingestArticlesService();
        res.status(200).json({ ingested: ingestSummary });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        res.status(400).json({
          err: errorMessage,
        });
      }
    });

    router.post("/addRagChunk", async (req, res) => {
      const adminKey = req.body?.ADMIN_KEY || req.headers["admin-key"];
      if (!this.isAdmin(adminKey as string)) {
        return res.status(400).json({ err: "Unauthorized request" });
      }

      const {
        content,
        title,
        url,
        metadata,
        ragTimestamp: ragTimestampRaw,
      } = req.body;
      if (
        !content ||
        typeof content !== "string" ||
        content.trim().length < 10
      ) {
        return res
          .status(400)
          .json({ err: "Input param missing or too short - content" });
      }

      let ragTimestamp: Date | undefined;
      if (ragTimestampRaw !== undefined) {
        if (typeof ragTimestampRaw !== "string") {
          return res
            .status(400)
            .json({ err: "Invalid input - ragTimestamp must be a string" });
        }
        const parsed = this.parseRagTimestamp(ragTimestampRaw);
        if (!parsed) {
          return res
            .status(400)
            .json({ err: "Invalid input - ragTimestamp must be YYYY-MM-DD" });
        }
        ragTimestamp = parsed;
      }

      try {
        const result = await addRagChunkService({
          content,
          title,
          url,
          metadata,
          ragTimestamp,
        });
        res.status(200).json({ added: result });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        res.status(400).json({ err: errorMessage });
      }
    });

    router.get("/ragChunkAccessCheck", async (req, res) => {
      const publicId = String(req.query?.publicId || "").trim();
      const genericDeniedResponse = {
        allowed: false,
        message: "Access not available",
      };

      if (!publicId) {
        return res.status(200).json(genericDeniedResponse);
      }

      try {
        const allowed = await hasRagChunkAccessByPublicId(publicId);
        if (!allowed) {
          return res.status(200).json(genericDeniedResponse);
        }
        return res.status(200).json({ allowed: true });
      } catch {
        return res.status(200).json(genericDeniedResponse);
      }
    });

    router.post("/addRagChunkFrontend", async (req, res) => {
      const {
        publicId,
        content,
        title,
        url,
        ragTimestamp: ragTimestampRaw,
      } = req.body || {};

      if (!publicId || typeof publicId !== "string") {
        return res.status(400).json({ err: "Input param missing - publicId" });
      }

      if (
        !content ||
        typeof content !== "string" ||
        content.trim().length < 10
      ) {
        return res
          .status(400)
          .json({ err: "Input param missing or too short - content" });
      }

      if (title !== undefined && typeof title !== "string") {
        return res.status(400).json({ err: "Invalid input - title" });
      }

      if (url !== undefined && typeof url !== "string") {
        return res.status(400).json({ err: "Invalid input - url" });
      }

      let ragTimestamp: Date | undefined;
      if (ragTimestampRaw !== undefined) {
        if (typeof ragTimestampRaw !== "string") {
          return res
            .status(400)
            .json({ err: "Invalid input - ragTimestamp must be a string" });
        }
        const parsed = this.parseRagTimestamp(ragTimestampRaw);
        if (!parsed) {
          return res
            .status(400)
            .json({ err: "Invalid input - ragTimestamp must be YYYY-MM-DD" });
        }
        ragTimestamp = parsed;
      }

      try {
        const result = await addRagChunkFrontendService({
          publicId,
          content,
          title,
          url,
          ragTimestamp,
        });

        return res.status(200).json({ added: result });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (errorMessage === "Unauthorized request") {
          return res.status(403).json({ err: "Unauthorized request" });
        }
        return res.status(400).json({ err: errorMessage });
      }
    });

    return router;
  };
}
