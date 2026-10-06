import db from "../db";

const DAILY_LIMIT = 5;

const getUtcDate = (): string => {
  // Returns current UTC date as YYYY-MM-DD
  return new Date().toISOString().slice(0, 10);
};

/**
 * Checks whether appId has reached its daily faucet quota.
 * Throws a structured error with code FAUCET_DAILY_LIMIT_REACHED if limit is met.
 * Does NOT modify the counter — call incrementQuota after a successful transfer.
 */
export const checkQuota = async (appId: string): Promise<void> => {
  const model = db.getFaucetQuotaModel();
  const utcDate = getUtcDate();
  const doc = await model.findOne({ appId, utcDate });
  const count = doc ? (doc as any).count : 0;
  if (count >= DAILY_LIMIT) {
    const err: any = new Error(
      "Daily limit reached. Try again after midnight UTC."
    );
    err.code = "FAUCET_DAILY_LIMIT_REACHED";
    throw err;
  }
};

/**
 * Increments the faucet quota counter for appId on the current UTC day.
 * Should only be called after a successful transfer.
 */
export const incrementQuota = async (appId: string): Promise<void> => {
  const model = db.getFaucetQuotaModel();
  const utcDate = getUtcDate();
  await model.findOneAndUpdate(
    { appId, utcDate },
    { $inc: { count: 1 }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
};
