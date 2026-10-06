import axios from "axios";
import globals, { BTC_PRICE_DATA, HistoricalInisightData } from "../globals";
import {
  handlePriceAndChange,
  handleSuggestedTxnFee,
  timestampValidate,
} from "../utils/feeInsightHelper";
const BTC_STATS_ENDPOINT = "https://api.coingecko.com/api/v3/coins/bitcoin";
const ONE_DAY_FEE_ENDPOINT =
  "https://mempool.space/api/v1/mining/blocks/fee-rates/24h";
const ONE_WEEK_FEE_ENDPOINT =
  "https://mempool.space/api/v1/mining/blocks/fee-rates/1w";
const SUGGESTED_FEE = "https://mempool.space/api/v1/fees/recommended"

export const getWidgetData = async (): Promise<{
  widgetData: {
    btc_data: BTC_PRICE_DATA;
    graph_data: HistoricalInisightData[];
  };
}> => {
  let finalResult = {
    btc_data: {
      last_updated: 0,
      btc_price_usd: 0,
      btc_price_change_percent: 0,
    },
    graph_data: [],
  };
  try {
    if (globals.BTC_PRICE && globals.BTC_PRICE.last_updated) {
      if (!timestampValidate(globals.BTC_PRICE.last_updated, 3)) {
        finalResult.btc_data = { ...globals.BTC_PRICE };
      }
    }

    if (finalResult && finalResult.btc_data.last_updated === 0) {
      const btcFeeResult = await axios.get(BTC_STATS_ENDPOINT);
      if (btcFeeResult && btcFeeResult.data) {
        const { btc_price_change_percent, btc_price_usd } =
          handlePriceAndChange(btcFeeResult.data);
        globals.BTC_PRICE = {
          last_updated: new Date().getTime(),
          btc_price_change_percent: btc_price_change_percent,
          btc_price_usd: btc_price_usd,
        };
        finalResult.btc_data = {
          last_updated: new Date().getTime(),
          btc_price_change_percent: btc_price_change_percent,
          btc_price_usd: btc_price_usd,
        };
      }
    }

    if (
      globals.OneDayHistoricalFeeData &&
      globals.OneDayHistoricalFeeData.last_updated
    ) {
      if (!timestampValidate(globals.OneDayHistoricalFeeData.last_updated, 9)) {
        finalResult.graph_data = [
          ...globals.OneDayHistoricalFeeData.feeGraphData,
        ];
      }
    }
    if (finalResult && finalResult.graph_data.length === 0) {
      const feeResult = await axios.get(ONE_DAY_FEE_ENDPOINT);
      if (feeResult && feeResult.data) {
        globals.OneDayHistoricalFeeData = {
          last_updated: new Date().getTime(),
          feeGraphData: [...feeResult.data],
        };
        finalResult.graph_data = [...feeResult.data];
      }
    }
    return { widgetData: { ...finalResult } };
  } catch (err) {
    return { widgetData: null };
  }
};

export const getOneDayGraphData = async (): Promise<{
  graph_data: {
    last_updated: number;
    data: HistoricalInisightData[];
  };
}> => {
  let finalResult = {
    last_updated: 0,
    data: [],
  };
  try {
    if (
      globals.OneDayHistoricalFeeData &&
      globals.OneDayHistoricalFeeData.last_updated
    ) {
      if (!timestampValidate(globals.OneDayHistoricalFeeData.last_updated, 9)) {
        finalResult = {
          last_updated: globals.OneDayHistoricalFeeData.last_updated,
          data: [...globals.OneDayHistoricalFeeData.feeGraphData],
        };
      }
    }
    if (finalResult && finalResult.data.length === 0) {
      const feeResult = await axios.get(ONE_DAY_FEE_ENDPOINT);
      if (feeResult && feeResult.data) {
        globals.OneDayHistoricalFeeData = {
          last_updated: new Date().getTime(),
          feeGraphData: [...feeResult.data],
        };
        finalResult = {
          last_updated:globals.OneWeekHistoricalFeeData.last_updated,
          data: [...globals.OneDayHistoricalFeeData.feeGraphData],
        };
      }
    }
    return { graph_data: { ...finalResult } };
  } catch (err) {
    return { graph_data: null };
  }
};

export const getOneWeekGraphData = async (): Promise<{
  graph_data: {
    last_updated: number;
    data: HistoricalInisightData[];
  };
}> => {
  let finalResult = {
    last_updated: 0,
    data: [],
  };
  try {
    if (
      globals.OneWeekHistoricalFeeData &&
      globals.OneWeekHistoricalFeeData.last_updated
    ) {
      if (
        !timestampValidate(globals.OneWeekHistoricalFeeData.last_updated, 9)
      ) {
        finalResult = {
          last_updated: globals.OneWeekHistoricalFeeData.last_updated,
          data: [...globals.OneWeekHistoricalFeeData.feeGraphData],
        };
      }
    }
    if (finalResult && finalResult.data.length === 0) {
      const feeResult = await axios.get(ONE_WEEK_FEE_ENDPOINT);
      if (feeResult && feeResult.data) {
        globals.OneWeekHistoricalFeeData = {
          last_updated: new Date().getTime(),
          feeGraphData: [...feeResult.data],
        };
        finalResult = {
          last_updated: globals.OneWeekHistoricalFeeData.last_updated,
          data: [...globals.OneWeekHistoricalFeeData.feeGraphData],
        };
      }
    }
    return { graph_data: { ...finalResult } };
  } catch (err) {
    return { graph_data: null };
  }
};


export const getFeeInsightData = async (): Promise<{
  insightData: {
    btc_data: BTC_PRICE_DATA;
    suggested_fee: number;
  };
}> => {
  let finalResult = {
    btc_data: {
      last_updated: 0,
      btc_price_usd: 0,
      btc_price_change_percent: 0,
    },
    suggested_fee:0
  };
  try {
    if (globals.BTC_PRICE && globals.BTC_PRICE.last_updated) {
      if (!timestampValidate(globals.BTC_PRICE.last_updated, 3)) {
        finalResult.btc_data = { ...globals.BTC_PRICE };
      }
    }

    if (finalResult && finalResult.btc_data.last_updated === 0) {
      const btcFeeResult = await axios.get(BTC_STATS_ENDPOINT);
      if (btcFeeResult && btcFeeResult.data) {
        const { btc_price_change_percent, btc_price_usd } =
          handlePriceAndChange(btcFeeResult.data);
        globals.BTC_PRICE = {
          last_updated: new Date().getTime(),
          btc_price_change_percent: btc_price_change_percent,
          btc_price_usd: btc_price_usd,
        };
        finalResult.btc_data = {
          last_updated: new Date().getTime(),
          btc_price_change_percent: btc_price_change_percent,
          btc_price_usd: btc_price_usd,
        };
      }
    }

    if (
      globals.SuggestedFeeInsight &&
      globals.SuggestedFeeInsight.last_updated
    ) {
      if (!timestampValidate(globals.SuggestedFeeInsight.last_updated, 4)) {
        finalResult.suggested_fee = globals.SuggestedFeeInsight.sats
      }
    }
    if (finalResult && finalResult.suggested_fee === 0) {
      const feeResult = await axios.get(SUGGESTED_FEE);
      if (feeResult && feeResult.data && feeResult.data.fastestFee) {
        globals.SuggestedFeeInsight = {
          last_updated: new Date().getTime(),
          sats: feeResult.data.fastestFee
        };
        finalResult.suggested_fee = feeResult.data.fastestFee
      }
    }
    return { insightData: { ...finalResult } };
  } catch (err) {
    return { insightData: null };
  }
};
