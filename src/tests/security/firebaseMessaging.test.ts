import admin from "firebase-admin";
import { sendFcmMulticast } from "../../utils/firebaseMessaging";

jest.mock("firebase-admin", () => {
  const sendEachForMulticast = jest.fn();
  return {
    messaging: jest.fn(() => ({ sendEachForMulticast })),
  };
});

const sdkSend = admin.messaging().sendEachForMulticast as jest.Mock;
const fixtureMessage = (count: number): admin.messaging.MulticastMessage => ({
  tokens: Array.from({ length: count }, (_, index) => `fixture-device-${index}`),
  notification: { title: "Fixture title", body: "Fixture body" },
  data: { notificationId: "fixture-notification", notificationType: "fixture-type" },
  android: { priority: "high" },
});

beforeEach(() => {
  jest.clearAllMocks();
  sdkSend.mockReset();
});

it("chunks 1001 devices and preserves payload, device order, and mixed delivery results", async () => {
  const message = fixtureMessage(1001);
  const originalTokens = [...message.tokens];
  const failedIndexes = new Set([499, 500, 1000]);
  const responses = message.tokens.map((_, index) => failedIndexes.has(index)
    ? { success: false, error: { code: "messaging/registration-token-not-registered" } }
    : { success: true, messageId: `fixture-message-${index}` });

  sdkSend.mockImplementation(async (chunk: admin.messaging.MulticastMessage) => {
    const chunkResponses = chunk.tokens.map(token => responses[originalTokens.indexOf(token)]);
    const successCount = chunkResponses.filter(response => response.success).length;
    return { responses: chunkResponses, successCount, failureCount: chunkResponses.length - successCount };
  });

  const result = await sendFcmMulticast(message);

  expect(sdkSend).toHaveBeenCalledTimes(3);
  expect(sdkSend.mock.calls.map(([chunk]) => chunk.tokens.length)).toEqual([500, 500, 1]);
  for (let index = 0; index < 3; index++) {
    expect(sdkSend.mock.calls[index][0]).toEqual({
      ...message,
      tokens: originalTokens.slice(index * 500, (index + 1) * 500),
    });
  }
  expect(sdkSend.mock.calls.reduce((tokens, [chunk]) => tokens.concat(chunk.tokens), [] as string[])).toEqual(originalTokens);
  expect(message.tokens).toEqual(originalTokens);
  expect(result).toEqual({ responses, successCount: 998, failureCount: 3 });
});

it("returns empty delivery counts without calling Firebase for an empty device list", async () => {
  expect(await sendFcmMulticast(fixtureMessage(0))).toEqual({
    responses: [], successCount: 0, failureCount: 0,
  });
  expect(admin.messaging).not.toHaveBeenCalled();
  expect(sdkSend).not.toHaveBeenCalled();
});

it("propagates a first-chunk SDK error without attempting later chunks", async () => {
  const message = fixtureMessage(1001);
  const providerError = new Error("Fixture provider unavailable");
  sdkSend.mockRejectedValueOnce(providerError);

  await expect(sendFcmMulticast(message)).rejects.toBe(providerError);
  expect(sdkSend).toHaveBeenCalledTimes(1);
  expect(sdkSend.mock.calls[0][0].tokens).toEqual(message.tokens.slice(0, 500));
});

it("retains confirmed outcomes and marks 501 remaining devices unavailable after a later SDK error", async () => {
  const message = fixtureMessage(1001);
  const providerError = new Error("Fixture private provider detail");
  const completedResponses = message.tokens.slice(0, 500).map((_, index) => index === 499
    ? { success: false, error: { code: "messaging/registration-token-not-registered" } }
    : { success: true, messageId: `fixture-message-${index}` });
  sdkSend
    .mockResolvedValueOnce({
      responses: completedResponses,
      successCount: 499,
      failureCount: 1,
    })
    .mockRejectedValueOnce(providerError);

  const result = await sendFcmMulticast(message);

  expect(sdkSend).toHaveBeenCalledTimes(2);
  expect(sdkSend.mock.calls[1][0].tokens).toEqual(message.tokens.slice(500, 1000));
  expect(result.responses.slice(0, 500)).toEqual(completedResponses);
  expect(result.responses).toHaveLength(1001);
  expect(result.successCount).toBe(499);
  expect(result.failureCount).toBe(502);
  const unavailableResponses = result.responses.slice(500);
  expect(unavailableResponses).toHaveLength(501);
  for (const response of unavailableResponses) {
    expect(response).toEqual({
      success: false,
      error: {
        code: "messaging/server-unavailable",
        message: "Delivery outcome unavailable",
        toJSON: expect.any(Function),
      },
    });
    expect(response.error.toJSON()).toEqual({
      code: "messaging/server-unavailable", message: "Delivery outcome unavailable",
    });
  }
  expect(JSON.stringify(result)).not.toContain(providerError.message);
});
