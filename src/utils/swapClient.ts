import axios from "axios";
import config from "../config";

export const swapApi = axios.create({
  baseURL: config.LETS_EXCHANGE_BASE_URL,
});

swapApi.interceptors.request.use(
  (req) => {
    req.headers.Authorization = `Bearer ${config.LETS_EXCHANGE_API_KEY}`;
    if (req.method === "post") {
      req.data = {
        ...req.data,
        affiliate_id: config.LETS_EXCHANGE_AFFILIATE_ID,
      };
    }

    return req;
  },
  (error) => {
    return Promise.reject(error);
  }
);

export const swapEndpoints = {
  coins: "v1/coins",
  coinsInfo: "v1/info/bulk",
  quote: "/v1/info",
  tnx: "v1/transaction",
};

export default class Swap {
  public static getCoins = async (): Promise<any> => {
    try {
      const res = await swapApi.get(swapEndpoints.coins);
      return { data: res.data, status: res.status };
    } catch (error) {
      console.log("🚀 ~ Swap ~ getCoins ~ error:", error);
      throw new Error(error.message ?? "Something went wrong");
    }
  };
  public static getQuote = async (body: any): Promise<any> => {
    try {
      const res = await swapApi.post(swapEndpoints.quote, body);
      return { data: res.data, status: res.status };
    } catch (error) {
      console.log("🚀 ~ Swap ~ getQuote ~ error:", error);
      throw new Error(error.message ?? "Something went wrong");
    }
  };
  public static createTnx = async (body: any): Promise<any> => {
    let res;
    try {
      body.withdrawal_extra_id = ""; // required field
      res = await swapApi.post(swapEndpoints.tnx, body);
      return res.data || res.json;
    } catch (err) {
      console.log("🚀 ~ Swap ~ createTnx ~ err:", err);
      throw handleError(err);
    }
  };

  public static getTnxDetails = async (tnxId: string): Promise<any> => {
    let res;
    try {
      res = await swapApi.get(swapEndpoints.tnx + `/${tnxId}`);
    } catch (err) {
      console.log("🚀 ~ Swap ~ getTnxDetails=async ~ err:", err);
      throw handleError(err);
    }
    return res.data || res.json;
  };
}

const handleError = (err: any) => {
  const errorStrings = {
    withdrawalField: "The withdrawal field is required.",
    returnField: "Invalid return address.",
    destinationField: "Invalid destination address.",
  };

  let error = null;
  for (const key in err?.response?.data?.error?.validation) {
    if (
      !Object.prototype.hasOwnProperty.call(
        err.response.data?.error?.validation,
        key
      )
    )
      continue;
    const value = err.response.data?.error?.validation[key];
    if (value.length) {
      error = value[0];
      break;
    }
  }

  if (error == errorStrings.withdrawalField)
    return new Error("Please enter a valid receive address");

  if (error == errorStrings.returnField)
    return new Error("Please enter a valid refund address");
  if (error == errorStrings.destinationField) {
    console.log("Error caught");
    throw new Error("Please enter a valid withdrawal address");
  }

  return err;
};
