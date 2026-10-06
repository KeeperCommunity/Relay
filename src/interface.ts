export enum NotificationType {
  RELEASE_MESSAGE = "RELEASE_MESSAGE",
}

export type ElectrumUTXO = {
  height: number;
  value: number;
  address: string;
  txId: string;
  vout: number;
};

export enum AppSubscriptionLevel {
  ONE = 1, // free tier (pleb/bronze)
  TWO = 2,
  THREE = 3,
  FOUR = 4,
}

export enum SubscriptionPaymentType {
  FREE = "free", // free tier (pleb/bronze)
  PLAYSTORE = "google",
  APPLE = "apple",
  PROMO_CODE = "promocode",
  BTC_PAYMENT = "btc_payment",
}

export type AppSubscription = {
  isCancelled: boolean;
  paymentType: string;
  level: number;
  plan: string;
  productId: string;
  dataAndroid: string;
  purchaseToken: string;
  signatureAndroid: string;
  transactionDate: number;
  transactionId: string;
  transactionReceipt: string;
  purchaseData: object;
};

export type AppImage = {
  appId: string;
  wallets: object;
  walletShellInstances: string;
  vaultShellInstances: string;
  walletShells: string;
  vaults: [string];
  subscription: object;
  networkType: string;
};

export interface AppProfile {
  _id: string;
  appId: string;
  fcmToken: string;
  os: string;
  version: string;
  subscription: AppSubscription;
}

export type SubscriptionPlan = {
  name: PlanName;
  level: AppSubscriptionLevel;
  icon: string;
  iconFocused: string;
  isActive: boolean;
  benifits: string[];
  productType: string;
  subTitle: string;
  trailPeriod?: string;
  productIds: string[];
  tireConfig?: TireConfig;
  comingSoon: boolean;
  promoCodes?: {
    [code: string]: string;
  };
};

export enum PlanName {
  PLEB = "Pleb",
  HODLER = "Hodler",
  DIAMOND_HANDS = "Diamond Hands",
  KEEPER_PRIVATE = "Keeper Private",
}

export enum SignerType {
  TAPSIGNER = "TAPSIGNER",
  KEEPER = "KEEPER",
  TREZOR = "TREZOR",
  LEDGER = "LEDGER",
  COLDCARD = "COLDCARD",
  PASSPORT = "PASSPORT",
  JADE = "JADE",
  KEYSTONE = "KEYSTONE",
  POLICY_SERVER = "POLICY_SERVER",
  MOBILE_KEY = "MOBILE_KEY",
  SEED_WORDS = "SEED_WORDS",
  SEEDSIGNER = "SEEDSIGNER",
}
export interface TireConfig {
  vaultScheme: { m: number; n: number };
  walletCount: number;
  walletConnect: boolean;
  walletBackup: { auto: boolean };
  autoTransfer: boolean;
  buyFee: any;
  timelock: boolean;
  support: any;
  softKeys: SignerType[];
  inheritance: any;
}

export const PlebSubscription: AppSubscription = {
  plan: PlanName.PLEB,
  level: AppSubscriptionLevel.ONE,
  paymentType: SubscriptionPaymentType.FREE,
  dataAndroid: "",
  isCancelled: false,
  productId: "",
  purchaseData: {},
  purchaseToken: "",
  signatureAndroid: "",
  transactionDate: Date.now(),
  transactionId: "",
  transactionReceipt: "",
};
