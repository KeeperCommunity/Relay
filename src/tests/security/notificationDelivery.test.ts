import admin from "firebase-admin";
import { sendFcmMulticast } from "../../utils/firebaseMessaging";
import { deliverNotification as deliverWalletNotification } from "../../services/notifications";
import { deliverNotification as deliverMessageCentreNotification } from "../../services/messageCentre";

jest.mock("firebase-admin", () => ({
  initializeApp: jest.fn(),
  messaging: jest.fn(),
}));
jest.mock("../../utils/firebaseMessaging", () => ({ sendFcmMulticast: jest.fn() }));
jest.mock("../../utils/firebaseCredentials", () => ({ firebaseAppOptions: jest.fn(() => undefined) }));
jest.mock("../../db", () => ({ __esModule: true, default: {} }));
jest.mock("../../utils/getReleaseTopic", () => ({
  getReleaseTopic: jest.fn(() => "fixture-release"),
  getBroadcastTopic: jest.fn(() => "fixture-broadcast"),
}));
jest.mock("../../services/releaseNotes", () => ({ storeReleaseNotes: jest.fn() }));

const multicast = sendFcmMulticast as jest.Mock;
const walletNotification = {
  notificationId: "fixture-wallet-notification",
  notificationType: "fixture-wallet-type",
  title: "Fixture wallet title",
  body: "Fixture wallet body",
  data: { fixtureNumber: 7, fixtureFlag: false },
};
const messageCentreNotification = {
  notificationId: "fixture-centre-notification",
  type: "fixture-centre-type",
  title: "Fixture centre title",
  info: "Fixture centre body",
  additionalInfo: { fixtureCategory: "fixture-category" },
};

beforeEach(() => {
  jest.clearAllMocks();
  multicast.mockReset();
});

afterEach(() => {
  expect(admin.messaging).not.toHaveBeenCalled();
  expect(admin.initializeApp).not.toHaveBeenCalled();
});

it("keeps wallet notification content and identifies invalid devices at their response indexes", async () => {
  const devices = ["fixture-transient", "fixture-valid", "fixture-unregistered", "fixture-invalid"];
  multicast.mockResolvedValue({
    responses: [
      { success: false, error: { code: "messaging/server-unavailable" } },
      { success: true, messageId: "fixture-delivery" },
      { success: false, error: { code: "messaging/registration-token-not-registered" } },
      { success: false, error: { code: "messaging/invalid-registration-token" } },
    ],
    successCount: 1,
    failureCount: 3,
  });

  expect(await deliverWalletNotification(walletNotification, devices)).toEqual({
    sent: true,
    invalidFCMs: [devices[2], devices[3]],
  });
  expect(multicast).toHaveBeenCalledTimes(1);
  expect(multicast).toHaveBeenCalledWith({
    tokens: devices,
    notification: { title: walletNotification.title, body: walletNotification.body },
    data: {
      content: JSON.stringify({
        notificationId: walletNotification.notificationId,
        ...walletNotification.data,
        notificationType: walletNotification.notificationType,
      }),
    },
  });
});

it("reports wallet delivery failure while retaining invalid-device cleanup when all devices fail", async () => {
  const devices = ["fixture-unregistered", "fixture-transient"];
  multicast.mockResolvedValue({
    responses: [
      { success: false, error: { code: "messaging/registration-token-not-registered" } },
      { success: false, error: { code: "messaging/server-unavailable" } },
    ],
    successCount: 0,
    failureCount: 2,
  });

  expect(await deliverWalletNotification(walletNotification, devices)).toEqual({
    sent: false,
    invalidFCMs: [devices[0]],
  });
});

it("keeps message-centre content and reports success when at least one device succeeds", async () => {
  const devices = ["fixture-invalid", "fixture-valid"];
  multicast.mockResolvedValue({
    responses: [
      { success: false, error: { code: "messaging/registration-token-not-registered" } },
      { success: true, messageId: "fixture-delivery" },
    ],
    successCount: 1,
    failureCount: 1,
  });

  expect(await deliverMessageCentreNotification(messageCentreNotification, devices)).toEqual({ sent: true });
  expect(multicast).toHaveBeenCalledTimes(1);
  expect(multicast).toHaveBeenCalledWith({
    tokens: devices,
    notification: { title: messageCentreNotification.title, body: messageCentreNotification.info },
    data: {
      content: JSON.stringify({
        notificationId: messageCentreNotification.notificationId,
        notificationType: messageCentreNotification.type,
      }),
      ...messageCentreNotification.additionalInfo,
    },
  });
});

it("reports message-centre delivery failure when Firebase accepts the request but every device fails", async () => {
  multicast.mockResolvedValue({
    responses: [{ success: false, error: { code: "messaging/registration-token-not-registered" } }],
    successCount: 0,
    failureCount: 1,
  });

  expect(await deliverMessageCentreNotification(messageCentreNotification, ["fixture-invalid"])).toEqual({ sent: false });
});

it("retains confirmed delivery and invalid-device cleanup alongside later unavailable outcomes", async () => {
  const devices = Array.from({ length: 1001 }, (_, index) => `fixture-device-${index}`);
  const responses = devices.map((_, index) => {
    if (index < 499) return { success: true, messageId: `fixture-message-${index}` };
    return {
      success: false,
      error: index === 499
        ? { code: "messaging/registration-token-not-registered" }
        : { code: "messaging/server-unavailable", message: "Delivery outcome unavailable" },
    };
  });
  multicast.mockResolvedValue({ responses, successCount: 499, failureCount: 502 });

  expect(await deliverWalletNotification(walletNotification, devices)).toEqual({
    sent: true,
    invalidFCMs: [devices[499]],
  });
  expect(await deliverMessageCentreNotification(messageCentreNotification, devices)).toEqual({ sent: true });
});
