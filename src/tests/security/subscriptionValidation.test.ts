import axios from "axios";
import { androidpublisher_v3 } from "googleapis/build/src/apis/androidpublisher/v3";
import db from "../../db";
import { updateStoreSubscription, verifyReceipt } from "../../services/app";
jest.mock("axios", () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock("../../db", () => ({ __esModule: true, default: { getAppModel: jest.fn() } }));
jest.mock("google-auth-library", () => ({ JWT: jest.fn() }));
jest.mock("googleapis/build/src/apis/androidpublisher/v3", () => {
  const subscriptions = { get: jest.fn(), acknowledge: jest.fn() };
  return { androidpublisher_v3: { Androidpublisher: jest.fn(() => ({ purchases: { subscriptions } })) } };
});
jest.mock("../../config", () => ({
  __esModule: true,
  default: { ENVIRONMENT: "PRODUCTION", APPLE_SHARED_SECRET: "disposable-secret" },
  SERVER_ENVIRONMENT: { DEVELOPMENT: "DEVELOPMENT" },
  OS: { iOS: "ios", ANDROID: "android", DESKTOP: "desktop" },
}));
jest.mock("../../utils/plans", () => ({ getPlans: () => [{ productIds: ["fixture.monthly"], level: 2, name: "fixture", icon: "fixture-icon" }] }));
const productId = "fixture.monthly";
const NOW = 1800000000000;
const receipt = "Zml4dHVyZQ==";
const androidReceipt = JSON.stringify({ packageName: "io.hexawallet.bitcoinkeeper", productId, purchaseToken: "disposable-token" });
const subscriptions = new androidpublisher_v3.Androidpublisher({}).purchases.subscriptions as any;
let app: any;
beforeEach(() => {
  jest.clearAllMocks(); jest.spyOn(Date, "now").mockReturnValue(NOW); jest.spyOn(console, "log").mockImplementation(() => {});
  app = { _id: "fixture-app", publicId: "fixture-owner", os: "ios", subscription: { level: 2, productId, transactionReceipt: receipt }, save: jest.fn(async cb => cb && cb(null)) };
  (db.getAppModel as jest.Mock).mockReturnValue({ find: jest.fn().mockResolvedValue([app]) });
  (axios.post as jest.Mock).mockResolvedValue({ data: { status: 0, receipt: { bundle_id: "io.hexawallet.keeper", in_app: [{ transaction_id: "fixture-tx", original_transaction_id: "fixture-original", product_id: productId, purchase_date_ms: String(NOW - 1000), expires_date_ms: String(NOW + 10000) }] } } });
  subscriptions.get.mockResolvedValue({ data: { startTimeMillis: String(NOW - 1000), expiryTimeMillis: String(NOW + 10000), acknowledgementState: 0, paymentState: 1 } });
  subscriptions.acknowledge.mockResolvedValue({});
});
afterEach(() => jest.restoreAllMocks());
it("saves a validated Apple subscription with the existing response fields", async () => {
  const result = await updateStoreSubscription(app._id, app.publicId, "ios", { productId, transactionReceipt: receipt }, true);
  expect(result).toMatchObject({ updated: true, level: 2, transactionId: "fixture-tx", expirationDate: NOW + 10000 });
  expect(app.subscription.purchaseData).toHaveLength(1); expect(app.save).toHaveBeenCalledTimes(1);
  expect(axios.post).toHaveBeenCalledWith("https://buy.itunes.apple.com/verifyReceipt", expect.any(Object), expect.objectContaining({ timeout: 20000, maxRedirects: 0 }));
});
it("acknowledges an eligible Google purchase before persisting it", async () => {
  const result = await updateStoreSubscription(app._id, app.publicId, "android", { productId, transactionReceipt: androidReceipt }, true);
  expect(result.updated).toBe(true); expect(subscriptions.acknowledge).toHaveBeenCalledTimes(1); expect(app.save).toHaveBeenCalledTimes(1);
  expect(subscriptions.get).toHaveBeenCalledWith({ packageName: "io.hexawallet.bitcoinkeeper", subscriptionId: productId, token: "disposable-token" }, { timeout: 20000, retry: false });
});
it("does not acknowledge already acknowledged purchases", async () => {
  subscriptions.get.mockResolvedValue({ data: { startTimeMillis: String(NOW - 1000), expiryTimeMillis: String(NOW + 10000), acknowledgementState: 1, paymentState: 1 } });
  expect((await updateStoreSubscription(app._id, app.publicId, "android", { productId, transactionReceipt: androidReceipt }, true)).updated).toBe(true);
  expect(subscriptions.acknowledge).not.toHaveBeenCalled();
});
it("does not acknowledge or persist a pending Google payment", async () => {
  subscriptions.get.mockResolvedValue({ data: { startTimeMillis: String(NOW - 1000), expiryTimeMillis: String(NOW + 10000), acknowledgementState: 0, paymentState: 0 } });
  expect((await updateStoreSubscription(app._id, app.publicId, "android", { productId, transactionReceipt: androidReceipt }, true)).updated).toBe(false);
  expect(subscriptions.acknowledge).not.toHaveBeenCalled(); expect(app.save).not.toHaveBeenCalled();
});
it("does not persist or leak an acknowledgement failure", async () => {
  subscriptions.acknowledge.mockRejectedValue(new Error("private-provider-token"));
  const result = await updateStoreSubscription(app._id, app.publicId, "android", { productId, transactionReceipt: androidReceipt }, true);
  expect(result.updated).toBe(false); expect(result.error).toBe("Error: Store subscription acknowledgement failed"); expect(app.save).not.toHaveBeenCalled();
  expect(JSON.stringify((console.log as jest.Mock).mock.calls)).not.toContain("private-provider-token");
});
it("reverification identifies an expired Apple purchase instead of reporting it as active", async () => {
  (axios.post as jest.Mock).mockResolvedValue({ data: { status: 0, receipt: { bundle_id: "io.hexawallet.keeper", in_app: [{ transaction_id: "fixture-tx", original_transaction_id: "fixture-original", product_id: productId, purchase_date_ms: String(NOW - 1000), expires_date_ms: String(NOW) }] } } });
  const result = await verifyReceipt(app._id, app.publicId, "ios");
  expect(result.isCancelled).toBe(true); expect(app.subscription.isCancelled).toBe(true); expect(result.subscription.productId).toBe(productId);
});
it("keeps a user-canceled Google subscription valid until paid expiry", async () => {
  app.os = "android"; app.subscription.transactionReceipt = androidReceipt;
  subscriptions.get.mockResolvedValue({ data: { startTimeMillis: String(NOW - 1000), expiryTimeMillis: String(NOW + 10000), acknowledgementState: 1, cancelReason: 0 } });
  expect((await verifyReceipt(app._id, app.publicId, "android")).isCancelled).toBe(false); expect(app.subscription.isCancelled).toBe(false);
});
it("rejects another app owner before contacting the stores", async () => {
  expect((await updateStoreSubscription(app._id, "other-owner", "ios", { productId, transactionReceipt: receipt }, true)).updated).toBe(false);
  expect(axios.post).not.toHaveBeenCalled(); expect(subscriptions.get).not.toHaveBeenCalled(); expect(app.save).not.toHaveBeenCalled();
});

it("does not let client fields override verified entitlement or store identity", async () => {
  const result = await updateStoreSubscription(app._id, app.publicId, "ios", {
    productId, transactionReceipt: receipt, level: 99, paymentType: "promocode", plan: "forged", isValid: true,
  }, true);
  expect(result.updated).toBe(true);
  expect(app.subscription).toMatchObject({ level: 2, paymentType: "apple", plan: "fixture", transactionId: "fixture-tx" });
  expect(app.subscription.isValid).toBeUndefined();
});
it("persists the Google receipt that was verified even when the alternate client field differs", async () => {
  const result = await updateStoreSubscription(app._id, app.publicId, "android", {
    productId, dataAndroid: androidReceipt, transactionReceipt: "unverified-alternate-receipt",
  }, true);
  expect(result.updated).toBe(true);
  expect(app.subscription.transactionReceipt).toBe(androidReceipt);
  expect(app.subscription.dataAndroid).toBe(androidReceipt);
});
