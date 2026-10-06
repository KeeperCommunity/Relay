import Swap from "../utils/swapClient";

export const getSwapCoins = async () => {
  try {
    let btc;
    let usdt;
    const res = await Swap.getCoins();
    res.data.forEach((coin) => {
      if (coin.code === "BTC") btc = coin;
      else if (coin.code === "USDT-TRC20") usdt = coin;
    });
    return { btc, usdt };
  } catch (error) {
    console.log("🚀 ~ getSwapCoins ~ error:", error);
    throw new Error("Something went wrong! Please try again later");
  }
};

export const getSwapQuote = async (data) => {
  const { coinFrom, coinTo, amount, float } = data;

  try {
    const body = {
      from: coinFrom.code,
      to: coinTo.code,
      network_from: coinFrom.network_code,
      network_to: coinTo.network_code,
      amount: amount,
      float: float,
    };
    const quote = await Swap.getQuote(body);
    return {
      amount:
        coinTo.code === "BTC"
          ? quote.data.amount
          : parseFloat(quote.data.amount).toFixed(2),
      rateId: quote.data.rate_id,
    };
  } catch (error) {
    console.log("🚀 ~ getSwapQuote ~ error:", error);
    throw new Error("Something went wrong! Please try again later");
  }
};

export const createSwapTnx = async (data) => {
  const {
    float,
    coinFrom,
    coinTo,
    depositAmount,
    withdrawal,
    refund = "",
    rateId = "",
  } = data;
  const body = {
    float: float,
    coin_from: coinFrom.code,
    coin_to: coinTo.code,
    network_from: coinFrom.network_code,
    network_to: coinTo.network_code,
    deposit_amount: depositAmount,
    withdrawal: withdrawal,
    return: refund, // btc sent from(spending wallet address)
    rate_id: rateId, // only required for fixed rate tnx
  };
  const tnx = await Swap.createTnx(body);
  return tnx;
};

export const getSwapTnxDetails = async (data) => {
  try {
    const tnx = await Swap.getTnxDetails(data);
    return tnx;
  } catch (error) {
    console.log("🚀 ~ getSwapTnxDetails ~ error:", error);
    throw new Error("Something went wrong! Please try again later");
  }
};
