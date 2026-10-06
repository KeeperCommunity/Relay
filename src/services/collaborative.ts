import db from "../db";


export const updateCollaborativeChannel = async (
  channelId: string,
  encryptedData: string
) => {
  try {
    const collaborativeChannel = db.getCollaborativeChannelModel();
    await collaborativeChannel.findOneAndUpdate(
      { channelId },
      { encryptedData },
      { new: true, upsert: true }
    );
    return { updated: true };
  } catch (error) {
    throw new Error(`Error updating collaborative channel: ${error.message}`);
  }
};

export const fetchCollaborativeChannel = async (channelId: string) => {
  try {
    const collaborativeChannel = db.getCollaborativeChannelModel();
    const result = await collaborativeChannel.findOne({ channelId });

    if (result) await collaborativeChannel.deleteOne({ channelId });
    const allDocuments = await collaborativeChannel.find({});

    return result;
  } catch (error) {
    throw new Error(`Error fetching collaborative channel: ${error.message}`);
  }
};
