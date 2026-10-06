import { v4 as uuidv4 } from "uuid";
import db from "../db";

export const storeReleaseNotes = async (
  build: string,
  version: string,
  notes: { ios: string; android: string },
  reminderLimit: number,
  releaseTopic: string
) => {
  if (!notes.ios || !notes.android) {
    throw new Error("Notes missing for iOS/Android");
  }

  try {
    const releaseNotesModel = db.getReleaseNotesModel();
    const [doc] = await releaseNotesModel.find({ build });
    if (doc) {
      throw new Error(
        `Store failed: release notes already exists against build number ${build}`
      );
    }

    const releaseId = uuidv4();
    const releaseNotesInstance = new releaseNotesModel({
      releaseId,
      build,
      version,
      notes,
      reminderLimit,
    });

    await releaseNotesInstance.save((err) => {
      if (err) {
        throw new Error(`Error occured while saving to database: ${err}`);
      }
    });
    return true;
  } catch (err) {
    console.log(err);
    throw new Error(err);
  }
};
