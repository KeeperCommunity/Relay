import { createStoreReceiptValidator, isStorePurchaseInactive } from "../../utils/storeReceipt";
const NOW = 1800000000000;
const token = "disposable-receipt-token";
const receipt = "Zml4dHVyZQ==";
const product = "fixture.monthly";
const options = { applePassword: "disposable-test-password", appleSandboxOnly: false, appleBundleId: "fixture.ios", googlePackageName: "fixture.android" };
let transport: { apple: jest.Mock; google: jest.Mock };
const item = (extra = {}) => ({ transaction_id: "90071992547409931234", original_transaction_id: "90071992547409931200", product_id: product, purchase_date_ms: String(NOW - 1000), expires_date_ms: String(NOW + 10000), is_trial_period: "false", ...extra });
const apple = (extra = {}) => ({ status: 0, receipt: { bundle_id: options.appleBundleId, in_app: [item()] }, ...extra });
const google = (extra = {}) => ({ expiryTimeMillis: String(NOW + 10000), startTimeMillis: String(NOW - 1000), paymentState: 1, acknowledgementState: 0, ...extra });
const android = (extra = {}) => ({ packageName: options.googlePackageName, productId: product, purchaseToken: token, subscription: true, ...extra });
const validate = (opts = options) => createStoreReceiptValidator(opts, transport);
beforeEach(() => { jest.spyOn(Date, "now").mockReturnValue(NOW); transport = { apple: jest.fn().mockResolvedValue(apple()), google: jest.fn().mockResolvedValue(google()) }; });
afterEach(() => jest.restoreAllMocks());

it("validates Apple over a fixed production URL and preserves large transaction identifiers", async () => {
  const result = await validate()("ios", receipt, product);
  expect(transport.apple).toHaveBeenCalledWith("https://buy.itunes.apple.com/verifyReceipt", { "receipt-data": receipt, password: options.applePassword, "exclude-old-transactions": true });
  expect(result.purchaseData[0].transactionId).toBe("90071992547409931234");
  expect(isStorePurchaseInactive(result.purchaseData[0])).toBe(false);
  expect(transport.google).not.toHaveBeenCalled();
});
it("retries an Apple sandbox receipt once on 21007", async () => {
  transport.apple.mockResolvedValueOnce({ status: 21007 });
  await validate()("ios", receipt, product);
  expect(transport.apple).toHaveBeenCalledTimes(2);
  expect(transport.apple.mock.calls[1][0]).toBe("https://sandbox.itunes.apple.com/verifyReceipt");
});
it("does not loop when both endpoints reject the receipt", async () => {
  transport.apple.mockResolvedValue({ status: 21007 });
  await expect(validate()("ios", receipt, product)).rejects.toThrow("Invalid store subscription receipt");
  expect(transport.apple).toHaveBeenCalledTimes(2);
});
it("development stays sandbox-only, including production-receipt rejection", async () => {
  transport.apple.mockResolvedValue({ status: 21008 });
  await expect(validate({ ...options, appleSandboxOnly: true })("ios", receipt, product)).rejects.toThrow();
  expect(transport.apple).toHaveBeenCalledTimes(1);
  expect(transport.apple.mock.calls[0][0]).toBe("https://sandbox.itunes.apple.com/verifyReceipt");
});
it.each(["<Receipt/>", "https://untrusted.invalid", "", {}, "a".repeat(1024 * 1024 + 1)])("rejects malformed Apple input before any provider call (%#)", async value => {
  await expect(validate()("ios", value, product)).rejects.toThrow();
  expect(transport.apple).not.toHaveBeenCalled(); expect(transport.google).not.toHaveBeenCalled();
});
it.each([21003, 21004, 21005, 21006, 21008, undefined])("rejects Apple failure status %s", async status => {
  transport.apple.mockResolvedValue(apple({ status }));
  await expect(validate()("ios", receipt, product)).rejects.toThrow();
});
it("rejects a valid receipt for another app", async () => {
  transport.apple.mockResolvedValue(apple({ receipt: { bundle_id: "wrong.app", in_app: [item()] } }));
  await expect(validate()("ios", receipt, product)).rejects.toThrow();
});
it("does not use another product's receipt to grant the requested plan", async () => {
  await expect(validate()("ios", receipt, "fixture.expensive")).rejects.toThrow();
});
it("deduplicates renewals and chooses the newest matching product, not an unrelated latest purchase", async () => {
  transport.apple.mockResolvedValue(apple({ latest_receipt_info: [item({ purchase_date_ms: String(NOW), transaction_id: "latest" }), item({ product_id: "different", purchase_date_ms: String(NOW + 1) })] }));
  const result = await validate()("ios", receipt, product);
  expect(result.purchaseData).toHaveLength(1); expect(result.purchaseData[0].transactionId).toBe("latest");
});
it.each([{ expires_date_ms: String(NOW) }, { cancellation_date_ms: String(NOW - 1) }, { cancellation_date: "provider date" }])("marks expired/refunded Apple purchases inactive (%#)", async fields => {
  transport.apple.mockResolvedValue(apple({ latest_receipt_info: [item({ ...fields, purchase_date_ms: String(NOW) })] }));
  expect(isStorePurchaseInactive((await validate()("ios", receipt, product)).purchaseData[0])).toBe(true);
});
it.each([undefined, "NaN", "", "123oops", 0, -1, Infinity])("rejects malformed Apple expiry (%s)", async expiry => {
  transport.apple.mockResolvedValue(apple({ receipt: { bundle_id: options.appleBundleId, in_app: [item({ expires_date_ms: expiry })] } }));
  await expect(validate()("ios", receipt, product)).rejects.toThrow();
});
it("validates Google package, product and token with the official API transport", async () => {
  const result = await validate()("android", android(), product);
  expect(transport.google).toHaveBeenCalledWith(options.googlePackageName, product, token);
  expect(result.acknowledgementState).toBe(0); expect(result.purchaseData[0].transactionId).toBe(token);
  expect(isStorePurchaseInactive(result.purchaseData[0])).toBe(false); expect(transport.apple).not.toHaveBeenCalled();
});
it.each([{ packageName: "other.app" }, { productId: "other.product" }, { purchaseToken: "" }, { subscription: false }])("rejects Google identity/input mismatches before validation (%#)", async fields => {
  await expect(validate()("android", android(fields), product)).rejects.toThrow(); expect(transport.google).not.toHaveBeenCalled();
});
it.each([{ paymentState: 0 }, { expiryTimeMillis: String(NOW) }, { cancelReason: 1 }, { cancelReason: 2 }, { cancelReason: 3 }])("does not grant pending, expired or revoked Google purchases (%#)", async fields => {
  transport.google.mockResolvedValue(google(fields));
  expect(isStorePurchaseInactive((await validate()("android", android(), product)).purchaseData[0])).toBe(true);
});
it.each([{ paymentState: 2 }, { cancelReason: 0 }, { cancelReason: 0, paymentState: undefined }])("keeps trials/user-canceled subscriptions active until expiry (%#)", async fields => {
  transport.google.mockResolvedValue(google(fields));
  expect(isStorePurchaseInactive((await validate()("android", android(), product)).purchaseData[0])).toBe(false);
});
it.each([{ paymentState: 99 }, { paymentState: undefined }, { acknowledgementState: undefined }, { expiryTimeMillis: "bad" }, { startTimeMillis: null }, { cancelReason: 99 }])("fails closed on malformed Google responses (%#)", async fields => {
  transport.google.mockResolvedValue(google(fields)); await expect(validate()("android", android(), product)).rejects.toThrow();
});
it.each(["ios", "android"])("does not expose provider errors, request bodies or credentials for %s", async platform => {
  const sensitive = new Error("token=private-token password=private-password");
  transport.apple.mockRejectedValue(sensitive); transport.google.mockRejectedValue(sensitive);
  await expect(validate()(platform as any, platform === "ios" ? receipt : android(), product)).rejects.toThrow(/^Invalid store subscription receipt$/);
});
it("rejects unsupported platforms without invoking any provider", async () => {
  await expect(validate()("windows" as any, "<Receipt/>", product)).rejects.toThrow();
  expect(transport.apple).not.toHaveBeenCalled(); expect(transport.google).not.toHaveBeenCalled();
});
