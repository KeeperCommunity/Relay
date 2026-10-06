import Config, { OS, SERVER_ENVIRONMENT } from "../config";
import {
  AppSubscriptionLevel,
  PlanName,
  SignerType,
  SubscriptionPlan,
} from "../interface";

export function getSkuByPlan(
  os: OS = OS.ANDROID,
  plan: PlanName,
  newPlans
): string[] {
  switch (plan) {
    case PlanName.HODLER:
      if (newPlans) {
        return Config.HODLER_SKU_NEW[Config.ENVIRONMENT][os];
      }
      return Config.HODLER_SKU[Config.ENVIRONMENT][os];
    case PlanName.DIAMOND_HANDS:
      if (newPlans) {
        return Config.DIAMOND_HANDS_SKU_NEW[Config.ENVIRONMENT][os];
      }
      return Config.DIAMOND_HANDS_SKU[Config.ENVIRONMENT][os];
    case PlanName.KEEPER_PRIVATE:
      return Config.KEEPER_PRIVATE_SKU;
    default:
      return [];
  }
}

export const promoOffers = {
  [SERVER_ENVIRONMENT.DEVELOPMENT]: [
    {
      promoCode: "btcsessions30",
      offerId: {
        "diamond_hands.monthly": "btcsessions_promo",
        "diamond_hands.yearly": "btcsessions",
        "hodler.yearly": "btcsessionspromo",
        "hodler.monthly": "btcsessions30",
      },
      offerCode: {
        "diamond_hands.monthly": "HM30",
        "diamond_hands.yearly": "HY30",
        "hodler.yearly": "DHM30",
        "hodler.monthly": "DHY30",
      },
    },
  ],
  [SERVER_ENVIRONMENT.PRODUCTION]: [
    {
      promoCode: "btcsessions30",
      offerId: {
        diamond_hands_yearly: "btcsessionspromo",
        diamond_hands_monthly: "btcsessions",
        hodler_yearly: "btcsessions30",
        hodler_monthly: "btcsessions_promo",
      },
      offerCode: {
        diamond_hands_yearly: "HM30",
        diamond_hands_monthly: "HY30",
        hodler_yearly: "DHM30",
        hodler_monthly: "DHY30",
      },
    },
  ],
};

export const iosBundleId = {
  [SERVER_ENVIRONMENT.DEVELOPMENT]: "io.hexawallet.hexakeeper.dev",
  [SERVER_ENVIRONMENT.PRODUCTION]: "io.hexawallet.keeper",
};

export function getPlans(os: OS = OS.ANDROID, newPlans = false) {
  const plans: SubscriptionPlan[] = [
    {
      name: PlanName.PLEB,
      level: AppSubscriptionLevel.ONE,
      icon: "assets/ic_pleb.svg",
      iconFocused: "assets/ic_pleb_focused.svg",
      isActive: true,
      benifits: [
        "Unlimited single-key and multi-key wallets",
        "Use with most popular hardware wallets",
        "Setup collaborative wallets with friends and family",
        "Advanced keys management and health checks",
        "Easy key replacement in case of loss or emergency",
        "Get quick in-app support from our Keeper Concierge team",
        "Get discounts for purchasing hardware wallet devices",
      ],
      comingSoon: false,
      productType: "free",
      subTitle: "Beginner",
      trailPeriod: "Always free",
      productIds: ["pleb"],
      tireConfig: {
        vaultScheme: { m: 1, n: 1 },
        walletCount: 2,
        walletConnect: false,
        walletBackup: { auto: true },
        autoTransfer: false,
        buyFee: 0,
        timelock: false,
        support: "community",
        softKeys: [SignerType.COLDCARD],
        inheritance: false,
      },
    },
    {
      name: PlanName.HODLER,
      level: AppSubscriptionLevel.TWO,
      icon: "assets/ic_hodler.svg",
      iconFocused: "assets/ic_hodler_focused.svg",
      isActive: true,
      benifits: [
        "All features of Pleb +",
        "Automatic encrypted backups for instant app recovery",
        "Use Server Key to add spending policies and 2FA to your wallet",
        "Save encrypted backups to your personal iCloud or Google Drive",
        "Set up Canary Wallets to detect unauthorized key access",
      ],
      comingSoon: false,
      subTitle: "Intermediate",
      productIds: getSkuByPlan(os, PlanName.HODLER, newPlans),
      trailPeriod: "3 months free",
      productType: "paid",
      tireConfig: {
        vaultScheme: { m: 2, n: 3 },
        walletCount: 4,
        walletConnect: true,
        walletBackup: { auto: true },
        autoTransfer: true,
        buyFee: 0,
        timelock: false,
        support: "community",
        softKeys: [SignerType.COLDCARD],
        inheritance: false,
      },
      promoCodes: {
        btcsessions30: "btc-sessions",
      },
    },
    {
      name: PlanName.DIAMOND_HANDS,
      level: AppSubscriptionLevel.THREE,
      icon: "assets/ic_diamond_hands.svg",
      iconFocused: "assets/ic_diamond_hands_focused.svg",
      isActive: true,
      benifits: [
        "All features of Hodler +",
        "Use Inheritance Key to enable future recovery by your heir",
        "Add Emergency Key to ensure you never lose access to your funds",
        "Inheritance Planning tools and documents",
        "Onboarding call with our Keeper Concierge team",
      ],
      comingSoon: true,
      subTitle: "Advanced",
      productIds: getSkuByPlan(os, PlanName.DIAMOND_HANDS, newPlans),
      trailPeriod: "3 months free",
      productType: "paid",
      tireConfig: {
        vaultScheme: { m: 3, n: 5 },
        walletCount: -1,
        walletConnect: true,
        walletBackup: { auto: true },
        autoTransfer: true,
        buyFee: 0,
        timelock: false,
        support: "community",
        softKeys: [SignerType.COLDCARD],
        inheritance: false,
      },
      promoCodes: {
        btcsessions30: "btc-sessions",
      },
    },
    {
      name: PlanName.KEEPER_PRIVATE,
      level: AppSubscriptionLevel.FOUR,
      icon: "assets/ic_keeper_private.svg",
      iconFocused: "assets/ic_keeper_private.svg",
      isActive: true,
      benifits: [
        "All features of Diamond Hands +",
        "Personal Concierge Manager",
      ],
      comingSoon: true,
      subTitle: "Private",
      productIds: getSkuByPlan(os, PlanName.KEEPER_PRIVATE, newPlans),
      trailPeriod: "",
      productType: "paid",
    },
  ];
  return plans;
}

export const getPlansForDesktop = () => {
  const planPrice = {
    "hodler.yearly": 79.99,
    "diamond_hands.yearly": 159.99,
  };
  let plans: any = getPlans(OS.DESKTOP, true);
  plans = plans.filter(
    (plan) => ![PlanName.PLEB, PlanName.KEEPER_PRIVATE].includes(plan.name)
  );
  plans = plans.map((plan) => {
    const productId = plan.productIds[0];
    return {
      name: plan.name,
      level: plan.level,
      icon: plan.icon,
      isActive: plan.isActive,
      benefits: plan.benifits,
      subTitle: plan.subTitle,
      productId,
      price: planPrice[productId],
    };
  });

  return plans;
};
