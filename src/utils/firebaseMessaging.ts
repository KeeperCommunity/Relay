import admin from "firebase-admin";

/** FCM accepts at most 500 devices per multicast; responses retain device order. */
export async function sendFcmMulticast(
  message: admin.messaging.MulticastMessage
): Promise<admin.messaging.BatchResponse> {
  const result: admin.messaging.BatchResponse = {
    responses: [],
    successCount: 0,
    failureCount: 0,
  };
  for (let offset = 0; offset < message.tokens.length; offset += 500) {
    try {
      const batch = await admin.messaging().sendEachForMulticast({
        ...message,
        tokens: message.tokens.slice(offset, offset + 500),
      });
      result.responses.push(...batch.responses);
      result.successCount += batch.successCount;
      result.failureCount += batch.failureCount;
    } catch (error) {
      if (!result.responses.length) {
        throw error;
      }
      // Earlier chunks have confirmed outcomes. Preserve them without exposing
      // provider error details or treating the remaining devices as invalid.
      const code = "messaging/server-unavailable";
      const unavailable = "Delivery outcome unavailable";
      for (let index = offset; index < message.tokens.length; index++) {
        result.responses.push({
          success: false,
          error: { code, message: unavailable, toJSON: () => ({ code, message: unavailable }) },
        });
      }
      result.failureCount += message.tokens.length - offset;
      break;
    }
  }
  return result;
}
