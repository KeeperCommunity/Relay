// Store responses are normalized here; no receipt-controlled platform or URL dispatch.
export interface StorePurchase {
  transactionId: string;
  originalTransactionId?: string;
  productId: string;
  bundleId: string;
  purchaseDate: number;
  expirationDate: number;
  cancellationDate: number;
  quantity: number;
  isTrial: boolean;
  paymentState?: number;
}
export interface StoreReceiptResult {
  purchaseData: StorePurchase[];
  acknowledgementState?: number;
}
export interface ReceiptOptions {
  applePassword: string;
  appleSandboxOnly: boolean;
  appleBundleId: string;
  googlePackageName: string;
}
export interface ReceiptTransport {
  apple: (url: string, body: object) => Promise<any>;
  google: (packageName: string, productId: string, token: string) => Promise<any>;
}
const invalid = () => new Error("Invalid store subscription receipt");
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
function milliseconds(value: unknown): number {
  if (!(typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)))) throw invalid();
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw invalid();
  return n;
}
export function isStorePurchaseInactive(purchase: StorePurchase, now = Date.now()): boolean {
  return !!purchase.cancellationDate || purchase.expirationDate <= now || purchase.paymentState === 0;
}

export function createStoreReceiptValidator(options: ReceiptOptions, transport: ReceiptTransport) {
  return async (platform: "ios" | "android", receipt: unknown, productId: string): Promise<StoreReceiptResult> => {
    if ((platform !== "ios" && platform !== "android") || !text(productId)) throw invalid();
    try {
      if (platform === "ios") {
        if (!text(options.applePassword) || !text(options.appleBundleId)) throw invalid();
        // Legacy StoreKit receipts are base64, not XML, URLs or StoreKit 2 JWS.
        if (!text(receipt) || receipt.length > 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(receipt)) throw invalid();
        const body = { "receipt-data": receipt, password: options.applePassword, "exclude-old-transactions": true };
        const sandbox = "https://sandbox.itunes.apple.com/verifyReceipt";
        let response = await transport.apple(options.appleSandboxOnly ? sandbox : "https://buy.itunes.apple.com/verifyReceipt", body);
        if (!options.appleSandboxOnly && response?.status === 21007) response = await transport.apple(sandbox, body);
        if (response?.status !== 0 || response.receipt?.bundle_id !== options.appleBundleId) throw invalid();
        const entries = [...(Array.isArray(response.receipt.in_app) ? response.receipt.in_app : []),
          ...(Array.isArray(response.latest_receipt_info) ? response.latest_receipt_info : [])];
        const matching: StorePurchase[] = entries.filter(item => item?.product_id === productId).map(item => {
          if (!text(item.transaction_id) || !text(item.original_transaction_id)) throw invalid();
          return {
            transactionId: item.transaction_id,
            originalTransactionId: item.original_transaction_id,
            productId, bundleId: options.appleBundleId,
            purchaseDate: milliseconds(item.purchase_date_ms),
            expirationDate: milliseconds(item.expires_date_ms),
            // cancellation_date denotes refund/revocation, not disabling renewal.
            cancellationDate: item.cancellation_date_ms ? milliseconds(item.cancellation_date_ms) : item.cancellation_date ? 1 : 0,
            quantity: 1, isTrial: item.is_trial_period === "true",
          };
        });
        matching.sort((a, b) => b.purchaseDate - a.purchaseDate || b.cancellationDate - a.cancellationDate);
        const seen = new Set<string>();
        const purchaseData = matching.filter(item => {
          if (seen.has(item.originalTransactionId)) return false;
          seen.add(item.originalTransactionId); return true;
        });
        if (!purchaseData.length) throw invalid();
        return { purchaseData };
      }
      const data = receipt as any;
      if (!text(options.googlePackageName) || !data || data.packageName !== options.googlePackageName ||
          data.productId !== productId || data.subscription !== true || !text(data.purchaseToken) || data.purchaseToken.length > 16384) throw invalid();
      const response = await transport.google(options.googlePackageName, productId, data.purchaseToken);
      const expirationDate = milliseconds(response?.expiryTimeMillis);
      const purchaseDate = milliseconds(response?.startTimeMillis);
      if (![0, 1].includes(response.acknowledgementState) ||
          (response.paymentState !== undefined && ![0, 1, 2, 3].includes(response.paymentState)) ||
          (response.cancelReason !== undefined && ![0, 1, 2, 3].includes(response.cancelReason))) throw invalid();
      // Google omits paymentState for canceled/expired subscriptions. Unknown
      // active responses must not grant paid access merely because expiry exists.
      if (response.paymentState === undefined && response.cancelReason === undefined && expirationDate > Date.now()) throw invalid();
      return {
        acknowledgementState: response.acknowledgementState,
        purchaseData: [{
          transactionId: data.purchaseToken, productId, bundleId: options.googlePackageName,
          purchaseDate, expirationDate, quantity: 1, isTrial: response.paymentState === 2,
          paymentState: response.paymentState,
          cancellationDate: response.cancelReason !== undefined && response.cancelReason !== 0 ? expirationDate : 0,
        }],
      };
    } catch (_) {
      // Provider errors may contain credentials, purchase tokens and request bodies.
      // Keep those out of service logging and API error responses.
      throw invalid();
    }
  };
}
