import admin from "firebase-admin";
import { v4 as uuidv4 } from "uuid";
import db from "../db";
import { getReleaseTopic } from "../utils/getReleaseTopic";

// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount as any),
//   databaseURL: config.FIREBASE_DB_URL,
// });

const subscribeToTopic = async (
  topic: string,
  registrationTokens: string[]
) => {
  // Subscribe the devices corresponding to the registration tokens to the
  // topic.

  if (registrationTokens.length > 1000) {
    throw new Error(
      "Firebase doesn't support more than 1000 token subscription in a single call"
    );
  }
  const res = await admin
    .messaging()
    .subscribeToTopic(registrationTokens, topic);
  console.log({ res });
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

export const updateFCMTokens = async (FCMs: string[], appVersion?: number) => {
  // subscribing to topic:release
  subscribeToTopic(getReleaseTopic(appVersion), FCMs)
    .then()
    .catch((err) => {
      console.log("An error occured while subscribing: ", err);
    });

  return true;
};

export const broadcastReleaseNotification = async (
  releaseMessage,
  releaseTopic
) => {
  try {
    const message = {
      notification: {
        title: releaseMessage.title,
        body: releaseMessage.body,
      },
      data: releaseMessage.additionalInfo,
      topic: releaseTopic,
    };
    // Send a message to devices subscribed to the provided topic.
    const res = await admin.messaging().send(message);
    return true;
  } catch (err) {
    console.log("Failed to broadcast: ", err);
    throw new Error(err);
  }
};

/*
This method will fetch all stored release notes from releast notes collecction,
creata an array of all the releases, and save the array under
notifications.releaseNotifications to all users in notifications collection
This will replace the previous list with the new list

The build number is not considered during this operation.
*/
export const updateReleaseNotifications = async (build, releaseTopic) => {
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
        notificationType: releaseTopic,
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

const notifyAll = async (notification: any, FCMs: string[]) => {
  const payload = {
    notification: {
      title: notification.title,
      body: notification.body,
    },
    data: notification.data,
  };
  try {
    const res = await admin.messaging().sendToDevice(FCMs, payload);

    // console.log({ res });
    // console.log({ results: res.results });
    // console.log({ err: res.results[1].error });

    const invalidFCMs = [];
    for (let index = 0; index < res.results.length; index++) {
      if (
        res.results[index].error &&
        (res.results[index].error.code ===
          "messaging/registration-token-not-registered" ||
          res.results[index].error.code ===
            "messaging/invalid-registration-token")
      ) {
        invalidFCMs.push(FCMs[index]); // Firebase results are in sync with the order of supplied registration tokens
      }
    }

    if (res.successCount) {
      // notification is delivered to at lteast one device/fcm
      return { sent: true, invalidFCMs };
    } else {
      return { sent: false, invalidFCMs };
    }
  } catch (err) {
    console.log(err);
  }
};

export const deliverNotification = async (
  notification: any,
  FCMs: string[]
) => {
  // for (const fcm of FCMs) {
  //   const { delivered, remove } = await notify(notification, fcm);
  //   if (remove) {
  //     invalidFCMs.push(fcm);
  //   }
  //   deliveryArray.push(delivered);
  // }

  // restructure the notification so that the data elements only contains string values
  const data = {
    notificationId: notification.notificationId,
    ...notification.data,
    notificationType: notification.notificationType,
  };
  const pushableNotification = {
    ...notification,
    data: { content: JSON.stringify(data) },
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
    !notification.data ||
    !notification.tag
  ) {
    throw new Error("Notification send failed: missing required fields");
  }
  const notificationsModel: any = db.getNotificationsModel();

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

    const [doc] = await notificationsModel.find({ walletId });
    if (!doc) {
      const notificationsInstance = new notificationsModel({
        walletId,
        notifications: [notification],
      });
      await notificationsInstance.save((err) => {
        if (err) {
          throw new Error(`Error occured while saving to database: ${err}`);
        }
      });
    } else {
      if (!doc.notifications) {
        doc.notifications = [notification];
      } else {
        doc.notifications.push(notification);
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