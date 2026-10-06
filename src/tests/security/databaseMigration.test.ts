import mongoose from "mongoose";

jest.mock("../../config", () => {
  const url = new URL(process.env.READINESS_MONGO_URL || "mongodb://127.0.0.1:27028");
  if (url.protocol !== "mongodb:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password) {
    throw new Error("Database readiness tests require disposable loopback MongoDB");
  }
  url.pathname = `/keeper_readiness_test_${process.pid}`;
  return { __esModule: true, default: { DATABASE: url.toString() } };
});

const describeDatabase = process.env.READINESS_MONGO_URL ? describe : describe.skip;
describeDatabase("Mongoose 6 database compatibility", () => {
  let db: any;
  beforeAll(async () => {
    db = require("../../db").default;
    await mongoose.connection.asPromise();
  });
  afterAll(async () => {
    try {
      if (mongoose.connection.readyState === 1) {
        if (!/^keeper_readiness_test_\d+$/.test(mongoose.connection.name)) throw new Error("Refusing cleanup of a non-test database");
        await mongoose.connection.dropDatabase();
      }
    } finally { await mongoose.disconnect(); }
  });
  it("retains callback save behavior and encrypted payloads", async () => {
    const model = db.getRemoteKeyModel();
    const doc = new model({ hash: "fixture-hash", data: "fixture-ciphertext" });
    await new Promise<void>((resolve, reject) => doc.save((err: Error) => err ? reject(err) : resolve()));
    expect((await model.findById(doc._id)).data).toBe("fixture-ciphertext");
  });
  it("preserves unknown query fields rather than widening a query", async () => {
    const model = db.getMessageCentreModel();
    await model.create({ appID: "fixture-query" });
    expect(mongoose.get("strictQuery")).toBe(false);
    expect(await model.find({ fieldNotInSchema: "must-not-match" })).toHaveLength(0);
  });
  it("uses MongoDB 4 driver update result counters, including no-op updates", async () => {
    const model = db.getNotificationsModel();
    await model.create({ appID: "fixture-notification", notifications: [] });
    const result = await model.updateMany({ appID: "fixture-notification" }, { $set: { notifications: [] } });
    expect(result.matchedCount).toBe(1);
    expect(result.modifiedCount).toBe(0);
  });
  it("keeps collaborative channel upsert and one-shot fetch behavior", async () => {
    const { updateCollaborativeChannel, fetchCollaborativeChannel } = require("../../services/collaborative");
    await updateCollaborativeChannel("fixture-channel", "fixture-encrypted-payload");
    const value = await fetchCollaborativeChannel("fixture-channel");
    expect(value.encryptedData).toBe("fixture-encrypted-payload");
    expect(await fetchCollaborativeChannel("fixture-channel")).toBeNull();
  });
});
