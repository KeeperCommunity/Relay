export interface BTC_PRICE_DATA {
  last_updated: number;
  btc_price_usd: number;
  btc_price_change_percent: number;
}

export interface HistoricalInisightData {
  avgHeight: number;
  timestamp: number;
  avgFee_0: number;
  avgFee_10: number;
  avgFee_25: number;
  avgFee_50: number;
  avgFee_75: number;
  avgFee_90: number;
  avgFee_100: number;
}

let ExchangeRates; // holds exchange rates(refreshed every hour)
let AverageTxFees = {}; // holds average txn fee rates(refreshed every hour)

let BTC_PRICE: BTC_PRICE_DATA = {
  last_updated: 0,
  btc_price_usd: 0,
  btc_price_change_percent: 0,
};

let OneDayHistoricalFeeData: {
  feeGraphData: HistoricalInisightData[];
  last_updated: number;
} = {
  feeGraphData: [],
  last_updated: 0,
};


let OneWeekHistoricalFeeData: {
  feeGraphData: HistoricalInisightData[];
  last_updated: number;
} = {
  feeGraphData: [],
  last_updated: 0,
};

let SuggestedFeeInsight = {
  last_updated: 0,
  sats: 0
};

export default {
  ExchangeRates,
  AverageTxFees,
  BTC_PRICE,
  OneDayHistoricalFeeData,
  OneWeekHistoricalFeeData,
  SuggestedFeeInsight
};
