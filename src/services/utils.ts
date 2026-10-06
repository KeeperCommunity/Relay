import crypto from "crypto";

export const getStreamId = (walletId: string): string =>
  crypto.createHash("sha256").update(walletId).digest("hex").slice(0, 9);

export const generateRandomId = (length: number = 12) => {
const ALPHANUMERIC =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const bytes = crypto.randomBytes(length);
let result = "";
for (let i = 0; i < length; i++) {
  result += ALPHANUMERIC[bytes[i] % ALPHANUMERIC.length];
}

return result;
};