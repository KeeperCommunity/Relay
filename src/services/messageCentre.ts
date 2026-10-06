import admin from "firebase-admin";
import { v4 as uuidv4 } from "uuid";
import db from "../db";
import { getReleaseTopic, getBroadcastTopic } from "../utils/getReleaseTopic";
import { firebaseAppOptions } from "../utils/firebaseCredentials";
import { sendFcmMulticast } from "../utils/firebaseMessaging";
import moment from "moment";
import { broadcastReleaseNotification } from "./notifications";
import { NotificationType } from "../interface";
import * as releaseNotes from "../services/releaseNotes";
import { Document } from "mongoose";

const firebaseOptions = firebaseAppOptions();
if (firebaseOptions) {
  admin.initializeApp(firebaseOptions);
}

const subscribeToTopic = async (
  topic: string,
  registrationTokens: string[]
) => {
  try {
    if (registrationTokens.length > 1000) {
      throw new Error(
        "Firebase doesn't support more than 1000 token subscription in a single call"
      );
    }
    const res = await admin
      .messaging()
      .subscribeToTopic(registrationTokens, topic);
  } catch (error) {
    console.log(error);
  }
};

const unsubscribeFromTopic = async (
  topic: string,
  registrationTokens: string[]
) => {
  // Unsubscribe the devices corresponding to the registration tokens from
  // the topic.

  if (registrationTokens.length > 1000) {
    throw new Error(
      "Firebase doesn't support more than 1000 token unsubscription in a single call"
    );
  }
  const res = await admin
    .messaging()
    .unsubscribeFromTopic(registrationTokens, topic);
  console.log({ res });
};

export const updateFCMTokens = async (
  appID: string,
  FCMs: string[],
  appVersion?: string
) => {
  // subscribing to broadcast topic
  subscribeToTopic(getBroadcastTopic(), FCMs)
    .then()
    .catch((err) => {
      console.log("An error occured while subscribing: ", err);
    });

  const messageCentreModel: any = db.getMessageCentreModel();

  const [doc] = await messageCentreModel.find({ appID });
  if (!doc) {
    const messageCentreInstance = new messageCentreModel({
      appID,
      FCMToken: FCMs[FCMs.length - 1],
      messages: [],
      version: appVersion,
    });
    await messageCentreInstance.save((err) => {
      if (err) {
        throw new Error(`Error occured while saving to database: ${err}`);
      }
    });
  } else {
    doc.FCMToken = FCMs[FCMs.length - 1];
    await doc.save((err) => {
      if (err) {
        throw new Error(`Error occured while saving to database: ${err}`);
      }
    });
  }
  return true;
};

export const feeinsightSubscription = async (FCMs: string[]) => {
  // subscribing to broadcast topic
  subscribeToTopic("feeinsight", FCMs)
    .then(() => {
      return true;
    })
    .catch((err) => {
      console.log("An error occured while subscribing: ", err);
      return false;
    });
};

/*
This method will fetch all stored release notes from releast notes collecction,
creata an array of all the releases, and save the array under
notifications.releaseNotifications to all users in notifications collection
This will replace the previous list with the new list

The build number is not considered during this operation.
*/
export const updateReleaseNotifications = async (build, appVersion?) => {
  const notificationsModel: any = db.getNotificationsModel();
  const releaseNotesModel: any = db.getReleaseNotesModel();

  try {
    // const doc = await notificationsModel.findOne({});
    // let storedReleaseNotifications;
    // if (doc) {
    //   storedReleaseNotifications = doc.releaseNotifications;
    // }

    const releaseNotes = await releaseNotesModel.find({});

    const updatedReleaseNotifications = [];
    for (const releaseNote of releaseNotes) {
      const releaseNotification = {
        notificationId: releaseNote.releaseId,
        notificationType: getReleaseTopic(appVersion),
        title: "New Release Available",
        body: `Release ${releaseNote.build}`,
        data: {
          build: releaseNote.build,
          version: releaseNote.version,
          notes: releaseNote.notes,
          reminderLimit: releaseNote.reminderLimit,
        },
      };

      // if (storedReleaseNotifications) {
      //   for (const storedNotes of storedReleaseNotifications) {
      //     if (releaseNote.build === storedNotes.data.build) {
      //       releaseNotification.status = "sent"; // previous build notifications is safely assumed to be sent by this build
      //     }
      //   }
      // }

      updatedReleaseNotifications.push(releaseNotification);
    }

    const res = await notificationsModel.updateMany(
      {},
      {
        releaseNotifications: updatedReleaseNotifications,
      }
    );
    if (!res.matchedCount && !res.modifiedCount) {
      throw new Error("Failed to update the release notifications array");
    }
  } catch (err) {
    // removing the release note from the database in case of crash
    console.log("Removing release note due to updation fail");
    releaseNotesModel.deleteOne({ build }, (err) => {
      console.log("Failed to remove release notes");
      console.log({ err });
    });
    console.log(err);
    throw new Error(err);
  }
};

// const notify = async (
//   notification: any,
//   registrationToken: string
// ): Promise<{
//   delivered: boolean;
//   remove: boolean;
// }> => {
//   const payload = {
//     notification: {
//       title: notification.title,
//       body: notification.body,
//     },
//     data: notification.data,
//   };

//   try {
//     const res = await admin
//       .messaging()
//       .sendToDevice(registrationToken, payload);

//     if (
//       res.results[0].error &&
//       res.results[0].error.code ===
//         "messaging/registration-token-not-registered"
//     ) {
//       return { delivered: false, remove: true };
//     }

//     if (res.failureCount) {
//       return { delivered: false, remove: false };
//     } else {
//       return { delivered: true, remove: false };
//     }
//   } catch (err) {
//     console.log(err);
//   }
// };

const notifyAll = async (notification: any, FCMs: string[]) => {
  try {
    const payload = {
      data: notification.data,
      notification: {
        title: notification.title,
        body: notification.info,
      },
      tokens: FCMs,
    };
    const res = await sendFcmMulticast(payload);
    return { sent: res.successCount > 0 };
  } catch (err) {
    console.log("Message centre notification delivery failed");
    return { sent: false };
  }
};

export const deliverNotification = async (
  notification: any,
  FCMs: string[]
) => {
  const data = {
    notificationId: notification.notificationId,
    notificationType: notification.type,
  };

  const pushableNotification = {
    ...notification,
    data: { content: JSON.stringify(data), ...notification.additionalInfo },
  };

  return await notifyAll(pushableNotification, FCMs);
};

export const sendNotifications = async (
  receivers: Array<{ walletId: string; FCMs: string[] }>,
  notification: any
) => {
  if (
    !notification.notificationType ||
    !notification.title ||
    !notification.body ||
    !notification.data
  ) {
    throw new Error("Notification send failed: missing required fields");
  }
  const messageCentreModel: any = db.getMessageCentreModel();

  for (const { walletId, FCMs } of receivers) {
    // assign a notification id
    notification.notificationId = uuidv4();

    if (FCMs && FCMs.length) {
      try {
        const { sent } = await deliverNotification(notification, FCMs);
        if (sent) notification.status = "sent";
      } catch (err) {
        console.log(`Error occured while delivering notification: ${err}`);
      }
    }
    const message = {
      type: notification.notificationType,
      title: notification.title,
      info: notification.body,
      additionalInfo: notification.data,
      notificationId: notification.notificationId,
    };
    const [doc] = await messageCentreModel.find({ walletId });
    if (!doc) {
      const messageCentreInstance = new messageCentreModel({
        walletId,
        messages: [message],
      });
      await messageCentreInstance.save((err) => {
        if (err) {
          throw new Error(`Error occured while saving to database: ${err}`);
        }
      });
    } else {
      if (!doc.messages) {
        doc.messages = [message];
      } else {
        doc.messages.push(message);
      }

      await doc.save((err) => {
        if (err) {
          throw new Error(`Error occured while saving to database: ${err}`);
        }
      });
    }
  }

  return true;
};

export const fetchNotifications = async (walletId: string) => {
  const notificationsModel: any = db.getNotificationsModel();
  const [doc] = await notificationsModel.find({ walletId });

  const notifications = [];
  let DHInfos = [];

  if (!doc) {
    const notificationsInstance = new notificationsModel({
      walletId,
    });
    await notificationsInstance.save((err) => {
      if (err) {
        throw new Error(`Error occured while saving to database: ${err}`);
      }
    });
  } else {
    if (doc.notifications && doc.notifications.length) {
      notifications.push(...doc.notifications);
    }
    if (doc.releaseNotifications && doc.releaseNotifications.length) {
      notifications.push(...doc.releaseNotifications);
    }
    if (doc.DHInfos && doc.DHInfos.length) {
      DHInfos = doc.DHInfos;
    }
  }

  return [notifications, DHInfos];
};

export const sendNotificationsFCMs = async (
  FCMs: Array<string>,
  notification: any
) => {
  if (FCMs && FCMs.length) {
    try {
      const { sent } = await deliverNotification(notification, FCMs);
      if (sent) {
        notification.status = "sent";
        return true;
      }
    } catch (err) {
      console.log(`Error occured while delivering notification: ${err}`);
      return false;
    }
  }
};

export const sendKeeperNotifications = async (
  notification: any,
  receiversFCMs: Array<string>,
  receiversAppIDs: Array<string>
) => {
  try {
    if (
      !notification.notificationType ||
      !notification.title ||
      !notification.body
    ) {
      throw new Error("Notification send failed: missing required fields");
    }

    const message = {
      type: notification.notificationType,
      title: notification.title,
      info: notification.body,
      additionalInfo: notification.data,
      notificationId: notification.notificationId || uuidv4(),
    };

    // Handle FCM tokens
    if (receiversFCMs && receiversFCMs.length > 0) {
      for (const fcmToken of receiversFCMs) {
        await handleNotification(fcmToken, message);
      }
    }

    // Handle App IDs
    if (receiversAppIDs && receiversAppIDs.length > 0) {
      for (const appID of receiversAppIDs) {
        const notificationsModel: any = db.getMessageCentreModel();
        const [existingDoc] = await notificationsModel.find({ appID });

        if (!existingDoc) {
          throw new Error(
            `Cannot find FCM for the corresponding App ID: ${appID}`
          );
        } else {
          const sent = await handleNotification(existingDoc.FCMToken, message);
          if (!sent) {
            throw new Error(
              `Error while sending notifications for App ID: ${appID}`
            );
          }
        }
      }
    }
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
};

async function handleNotification(receiver: string, message: any) {
  const notificationsModel: any = db.getMessageCentreModel();
  const [existingDoc] = await notificationsModel.find({ FCMToken: receiver });

  if (!existingDoc) {
    throw new Error(
      `Cannot find an App for the corresponding FCM token: ${receiver}`
    );
  } else {
    const sent = await sendNotificationsFCMs([receiver], message);
    if (sent) {
      message.type = "sent";
      if (!existingDoc.messages) {
        existingDoc.messages = [message];
      } else {
        existingDoc.messages.push(message);
      }
      await existingDoc.save();
      return true;
    } else {
      return false;
    }
  }
}

export const updateDHInfo = async (
  walletId: string,
  DHInfo: { address?: string; publicKey: string }
) => {
  const notificationsModel: any = db.getNotificationsModel();
  const [doc] = await notificationsModel.find({ walletId });
  if (!doc) {
    const notificationsInstance = new notificationsModel({
      walletId,
      DHInfos: [DHInfo],
    });

    await notificationsInstance.save((err) => {
      if (err) {
        throw new Error(`Error occured while saving to database: ${err}`);
      }
    });
  } else {
    if (doc.DHInfos && doc.DHInfos.length) {
      doc.DHInfos.push(DHInfo);
    } else {
      doc.DHInfos = [DHInfo];
    }
    await doc.save((err) => {
      if (err) {
        throw new Error(`Error occured while saving to database: ${err}`);
      }
    });
  }
};

export const getMessages = async (
  appID: string,
  timeStamp: Number,
  version: string
) => {
  const messageCentreModel: any = db.getMessageCentreModel();
  const [doc] = await messageCentreModel.find({ appID });
  const messages = [];
  const timeToCompare = timeStamp ? moment(Number(timeStamp)) : moment(0);
  if (doc && doc.messages) {
    for (const message of doc.messages) {
      if (moment(message.timeStamp).isAfter(timeToCompare))
        messages.push(message);
    }
    if (version !== doc.version) {
      doc.version = version;
      doc.save();
    }
    return messages;
  } else {
    return [];
  }
};

export const newReleaseMessage = async (
  build: string,
  version: string,
  notes: any,
  reminderLimit: number
) => {
  try {
    const messageCentreModel = db.getMessageCentreModel();
    const docs = await messageCentreModel.find();
    const saveNotes = await releaseNotes.storeReleaseNotes(
      build,
      version,
      notes,
      reminderLimit,
      getReleaseTopic(version)
    );
    if (saveNotes) {
      await db.getMessageCentreModel().updateMany(
        {},
        {
          $push: {
            messages: {
              type: NotificationType.RELEASE_MESSAGE,
              status: "unread",
              title: `New release ${version}`,
              info: "Info",
              additionalInfo: {
                notes: notes,
                reminderLimit,
              },
              notificationId: uuidv4(),
            },
          },
        }
      );
      const messageCentreModel: any = db.getReleaseNotesModel();
      const releases = await messageCentreModel.find();
      for (const release of releases) {
        await broadcastReleaseNotification(
          {
            title: `New Release ${version}`,
            body: notes.android,
            additionalInfo: {
              androidNotes: notes.android,
              iosNotes: notes.ios,
              reminderLimit: `${reminderLimit}`,
            },
          },
          getReleaseTopic(release.version)
        );
      }
      return true;
    } else {
      return false;
    }
  } catch (error) {
    console.log(error);
    return false;
  }
};

export const sendLowFeeInsight = async () => {
  await broadcastReleaseNotification(
    {
      title: "Low Fee Alert",
      body: "Fees are lower than usual",
      additionalInfo: {},
    },
    "feeinsight"
  );
};

type NotificationMessageType = {
  notification: {
    title: string;
    body: string;
  };
  data?: {
    [key: string]: string;
  };
};
export const sendSingleNotification = async (
  message: NotificationMessageType,
  fcm: string
) => {
  const data = {
    token: fcm,
    notification: message.notification,
    data: message.data,
    condition: null,
  };
  const response = await admin.messaging().send(data);
  return response;
};

export const addZendeskExternalId = async (appID, fcm, externalId) => {
  // save zendesk external id to app record.
  const messageModel = db.getMessageCentreModel();
  // Find the record and update the externalId field
  const updatedMessageObj = await messageModel.findOneAndUpdate(
    { appID }, // Query to find the record
    { $set: { externalId: externalId } }, // Update operation
    { new: true } // Return the updated document
  );
  return updatedMessageObj;
};

interface MessageObjectProps extends Document {
  FCMToken: string;
}
export const sendZendeskNotification = async (data) => {
  const { id, external_id, status } = data;

  const messageModel = db.getMessageCentreModel();
  const msgObj: MessageObjectProps = await messageModel
    .findOne({
      externalId: external_id,
    })
    .select("FCMToken")
    .lean();

  const message = {
    notification: {
      title: "Technical Support", // title handled at frontend
      body: "You have a new response",
    },
    data: {
      ticketId: id.toString(),
      ticketStatus: status,
      notificationType: "ZENDESK_TICKET",
    },
  };

  const res = await sendSingleNotification(message, msgObj.FCMToken);

  return true;
};
