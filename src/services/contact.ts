import db from "../db";
import { sendSingleNotification } from "./messageCentre";

interface AppObjectProps extends Document {
  fcmToken: string;
}

export const sendContactNotification = async (data) => {
  const { contactsKey, communityId } = data;
  const appModel = db.getAppModel();
  const appObj: AppObjectProps = await appModel
    .findOne({
      contactsKey: contactsKey,
    })
    .lean();

  const message = {
    notification: {
      title: "Keeper Contacts",
      body: "You have a new message",
    },
    data: {
      communityId: communityId ?? "",
      notificationType: "CONTACT_MESSAGE",
    },
  };
  const res = await sendSingleNotification(message, appObj.fcmToken);
  return true;
};
