import axios from "axios";
import globals from "../globals";
import { sendLowFeeInsight } from "../services/messageCentre";
const SUGGESTED_FEE = "https://mempool.space/api/v1/fees/recommended";

function checkValueDifference(currentValue, previousValue) {
  // Calculate the 30% threshold
  const threshold = previousValue * 0.3;

  // Check if the current value is lower than the threshold
  if (currentValue < threshold) {
    return true;
  } else {
    return false;
  }
}

export const getLatestFeeData = async () => {
  try {
    const feeResult = await axios.get(SUGGESTED_FEE);
    if (feeResult && feeResult.data && feeResult.data.fastestFee) {
      const isLower = checkValueDifference(
        feeResult.data.fastestFee,
        globals.SuggestedFeeInsight.sats
      );
      if (isLower) {
        await sendLowFeeInsight();
      }
      globals.SuggestedFeeInsight = {
        last_updated: new Date().getTime(),
        sats: feeResult.data.fastestFee,
      };
    }
  } catch (error) {
    console.log("🚀 ~ getLatestFeeData ~ error:", error.message);
  }
};
// IK email job: runs every day at 12:15 am
