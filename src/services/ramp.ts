import crypto from "crypto";
import config from '../config';

export interface WidgetParams {
  defaultFlow?: "ONRAMP" | "OFFRAMP" | "SWAP";
  enabledFlows?: string;
  hostApiKey?: string;
  userAddress?: string;
  swapAsset?: string;
  fiatCurrency?: string;
  [key: string]: string | undefined;
}

export interface SignedUrlResult {
  url: string;
  signature: string;
  timestamp: number;
  queryString: string;
}


export function generateSignedUrl(
  userAddress: string,
  swapAsset: string,
  flow: "ONRAMP" | "OFFRAMP" | "SWAP"
): SignedUrlResult {
  const privateKey = config.RAMP_PRIVATE_KEY;
  const defaultParams: WidgetParams = {
    defaultFlow: flow,
    enabledFlows: flow,
    hostApiKey: config.RAMP_HOST_API_KEY,
  };
  const widgetParams = {
    hostAppName: "Bitcoin Keeper",
    userAddress,
    swapAsset: swapAsset,
    fiatCurrency: "USD",
    hostLogoUrl:
      "https://static.wixstatic.com/media/6aee8c_164a4e8d6d7246468071075485eb1259~mv2.png/v1/fill/w_328,h_144,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/keeper%20logo.png",
    finalUrl: `https://www.bitcoinkeeper.app/${config.ENVIRONMENT.toLowerCase()}/ramp/`,
  };
  const allParams: WidgetParams = { ...defaultParams, ...widgetParams };

  const queryParams = new URLSearchParams();
  Object.entries(allParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      queryParams.append(key, value);
    }
  });
  const queryString = queryParams.toString();

  const timestamp = Math.floor(Date.now());
  const queryWithTimestamp = `${queryString}&timestamp=${timestamp}`;
  
  const data = Buffer.from(queryWithTimestamp, "utf8");
  const signature = crypto.sign(null, data, privateKey);
  const base64Signature = signature.toString("base64");

  const finalUrl = `https://app.rampnetwork.com/?${queryWithTimestamp}&signature=${encodeURIComponent(
    base64Signature
  )}`;

  return {
    url: finalUrl,
    signature: base64Signature,
    timestamp,
    queryString: queryWithTimestamp,
  };
}