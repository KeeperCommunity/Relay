import mongoose, { Schema } from "mongoose";
import config from "./config";
import { NotificationType } from "./interface";
class Database {
  private notificationSchema = new Schema({
    appID: { type: String, required: true },
    notifications: {
      type: [
        {
          notificationId: { type: String, required: true },
          notificationType: {
            type: String,
            enum: [NotificationType.RELEASE_MESSAGE],
            required: true,
          },
          title: { type: String, required: true },
          body: { type: String, required: true },
          data: { type: {} },
          tag: {
            type: String,
            enum: ["IMP", "not-IMP"],
            default: "not-IMP",
          },
          status: {
            type: String,
            enum: ["pending", "sent", "failed"],
            default: "failed",
          },
          date: { type: Date, default: Date.now },
        },
      ],
      required: false,
    },
    releaseNotifications: {
      type: [
        {
          notificationId: { type: String, required: true },
          notificationType: {
            type: String,
            enum: ["release", "release_stage", "release_dev"],
            default: "release_dev",
          },
          title: { type: String, required: true },
          body: { type: String, required: true },
          data: {
            type: {
              build: String,
              version: String,
              releaseNotes: {
                ios: { type: String },
                android: { type: String },
              },
              reminderLimit: Number,
            },
            required: true,
          },
          tag: {
            type: String,
            enum: ["IMP", "not-IMP"],
            default: "IMP",
          },
          status: {
            type: String,
            enum: ["pending", "sent", "failed", "discarded"],
            default: "sent",
          },
          date: { type: Date, default: Date.now },
        },
      ],
    },
    DHInfos: {
      type: [{ address: { type: String }, publicKey: { type: String } }],
    },
  });

  private releaseNotesSchema = new Schema({
    releaseId: { type: String, required: true },
    build: { type: String },
    version: { type: String },
    notes: {
      ios: { type: String },
      android: { type: String },
    },
    reminderLimit: {
      type: Number,
      default: -1,
    },
  });

  private messageCentreSchema = new Schema({
    appID: { type: String, required: true },
    FCMToken: { type: String, required: false },
    version: { type: String, required: true, default: "1.0.0" },
    messages: {
      type: [
        {
          type: { type: String, required: true, default: "DEFAULT" },
          status: {
            type: String,
            enum: ["read", "unread", "sent"],
            required: true,
            default: "unread",
          },
          title: { type: String, required: true },
          info: { type: String, required: true },
          timeStamp: { type: Date, default: Date.now },
          notificationId: { type: String, required: true },
          additionalInfo: {},
        },
      ],
      required: false,
    },
    externalId: { type: String, required: false, default: null },
  });

  private vaultMapSchema = new Schema({
    signerId: { type: String, unique: true, required: true, index: true },
    xfpHash: { type: String, required: true, index: true },
    vaultId: { type: String, required: true },
  });

  private vaultImageSchema = new Schema({
    vaultId: { type: String, unique: true, required: true, index: true },
    vaultShellId: { type: String, index: true }, // required above v1.0.1
    appId: { type: String, required: true },
    isArchived: { type: Boolean, required: true, default: false },
    signerIds: [{ type: String, required: true }],
    scheme: { type: {}, required: false },
    vault: { type: Object, required: true },
  });

  // Each app encrypts its copy with its own Recovery Key. Collaborative
  // participants share the canonical vault ID, but must retain separate images.
  private appVaultImageSchema = new Schema({
    vaultId: { type: String, required: true, index: true },
    vaultShellId: { type: String, index: true },
    appId: { type: String, required: true },
    isArchived: { type: Boolean, required: true, default: false },
    signerIds: [{ type: String, required: true }],
    scheme: { type: {}, required: false },
    vault: { type: Object, required: true },
  });

  private appImageSchema = new Schema({
    appId: { type: String, required: true, unique: true },
    publicId: { type: String, required: true, unique: true },
    wallets: { type: Object, required: true },
    signers: { type: Object },
    labels: [{ type: String, ref: "label" }],
    vaults: [{ type: String }],
    subscription: { type: String, required: false },
    version: { type: String, required: true },
    nodes: [{ type: String, required: false }],
    // Once repaired, unversioned full replacements must never overwrite this image.
    backupRevisionRequired: { type: Boolean, default: false },
    // Retained by Delete Backup, preventing stale A → B → A revisions.
    backupGeneration: { type: Number, default: 0, min: 0 },
  });

  private labelSchema = new Schema({
    id: { type: String, required: true, unique: true },
    ref: { type: String, required: false },
    type: { type: String, required: false },
    label: { type: String, required: false },
    origin: { type: String, required: false },
    isSystem: { type: Boolean, required: false, default: false },
    content: { type: String, required: false },
  });

  private remoteKeySchema = new Schema(
    {
      data: { type: String, required: true },
      hash: { type: String, required: true },
    },
    { timestamps: true },
  );

  private appSchema = new Schema(
    {
      _id: { type: String, required: true },
      appId: { type: String, required: true },
      publicId: { type: String, required: true },
      contactsKey: { type: String, required: false },
      fcmToken: { type: String, default: "" },
      os: { type: String, required: true },
      version: { type: String, default: "" },
      subscription: {
        isCancelled: { type: Boolean, default: false },
        paymentType: { type: String, default: "" },
        level: { type: Number, default: 1 },
        plan: { type: String },
        productId: { type: String, require: false },
        dataAndroid: { type: String, require: false },
        purchaseToken: { type: String, require: false },
        signatureAndroid: { type: String, require: false },
        transactionDate: { type: Number, require: false },
        transactionId: { type: String, require: false },
        transactionReceipt: { type: String, require: false },
        purchaseData: { type: {}, default: {} },
        nextSubscription: { type: String, default: "" },
      },
      accountManager: { type: String },
    },
    {
      timestamps: true,
    },
  );

  private collaborativeChannelSchema = new Schema({
    channelId: { type: String, required: true },
    encryptedData: { type: String, required: true },
  });

  private referralLinksSchema = new Schema(
    {
      identifier: { type: String, required: true },
      link: { type: String, required: true },
      isReseller: { type: Boolean, default: false },
      title: { type: String },
      country: { type: String },
      subTitle: { type: String },
      icon: { type: String },
    },
    { timestamps: true },
  );

  private keeperPrivatePromoCodeSchema = new Schema(
    {
      code: { type: String, required: true, unique: true },
    },
    { timestamps: true },
  );

  private accountManagerSchema = new Schema(
    {
      fullName: { type: String, required: true },
      image: { type: String },
      links: {
        email: { type: String },
        whatsapp: { type: String },
        calendly: { type: String },
        phone: { type: String },
        telegram: { type: String },
      },
      id: { type: String, required: true, unique: true },
      isActive: { type: Boolean, require: true, default: true },
    },
    { timestamps: true },
  );

  private campaignSchema = new Schema(
    {
      planName: { type: String, required: true },
      iosSKU: { type: String, required: true },
      androidSKU: { type: String, required: true },
      androidIdentifier: { type: String, required: true },
      discount: { type: Number, required: true },
      isActive: { type: Boolean, required: true, default: false },
      benefits: { type: Array, required: true },
      plan: { type: String, required: true },
      iosRedeemCode: { type: String },
      loginModalText: {
        title: { type: String, required: true },
        subTitle: { type: String, required: true },
        primaryCTA: { type: String, required: true },
      },
    },
    { timestamps: true },
  );

  private advisorSchema = new Schema(
    {
      isActive: { type: Boolean, required: true, default: true },
      title: { type: String, required: true },
      country: { type: String, required: true },
      description: { type: String, required: true },
      image: { type: String, required: true },
      link: { type: String, required: true },
      expertise: [{ type: String, required: true }],
      duration: { type: String, required: true },
      experience: { type: String, required: true },
      timezone: { type: String, required: true },
      languages: [{ type: String, required: true }],
    },
    { timestamps: true },
  );

  private articleChunkSchema = new Schema(
    {
      articleId: { type: Number, required: true, index: true },
      title: { type: String, required: true },
      url: { type: String },
      chunkIndex: { type: Number, required: true },
      content: { type: String, required: true }, // plain text chunk
      embedding: { type: [Number], required: true }, // 1536-dim vector (OpenAI ada-002) or 3072 (text-embedding-3-large)
      ragTimestamp: { type: Date }, // content authoring date; used for date-aware RAG retrieval
      metadata: {
        sectionId: Number,
        createdAt: Date,
        updatedAt: Date,
      },
    },
    { timestamps: true },
  );

  private faucetQuotaSchema = new Schema({
    appId: { type: String, required: true },
    utcDate: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
    createdAt: { type: Date, default: Date.now },
  });

  private ragChunkAllowlistSchema = new Schema(
    {
      name: { type: String, required: true },
      publicId: { type: String, required: true, unique: true, index: true },
      isActive: { type: Boolean, required: true, default: true },
    },
    { timestamps: true },
  );

  constructor() {
    mongoose.Promise = global.Promise;
    // Compound index for deduplication
    this.articleChunkSchema.index(
      { articleId: 1, chunkIndex: 1 },
      { unique: true },
    );
    this.articleChunkSchema.index({ ragTimestamp: -1 });
    this.appVaultImageSchema.index({ appId: 1, vaultId: 1 }, { unique: true });
    this.faucetQuotaSchema.index({ appId: 1, utcDate: 1 }, { unique: true });
    this.faucetQuotaSchema.index(
      { createdAt: 1 },
      { expireAfterSeconds: 172800 },
    );
    // Preserve Mongoose 5 query filtering behavior during the driver upgrade.
    mongoose.set("strictQuery", false);
    mongoose.connect(config.DATABASE);
  }

  public getAppModel = () => {
    return mongoose.model("App", this.appSchema);
  };

  public getNotificationsModel = () => {
    return mongoose.model("Notifications", this.notificationSchema);
  };

  public getMessageCentreModel = () => {
    return mongoose.model("MessageCentre", this.messageCentreSchema);
  };

  public getReleaseNotesModel = () => {
    return mongoose.model("Release Notes", this.releaseNotesSchema);
  };

  public messageCentreModel = () => {
    return mongoose.model("Message Centre", this.messageCentreSchema);
  };

  public getAppImageModel = () => {
    return mongoose.model("AppImages", this.appImageSchema);
  };

  public getVaultImageModel = () => {
    return mongoose.model("Vault Image", this.vaultImageSchema);
  };

  public getAppVaultImageModel = () => {
    return mongoose.model(
      "App Vault Image",
      this.appVaultImageSchema,
      "appVaultImages",
    );
  };

  public getVaultMapModel = () => {
    return mongoose.model("Vault Map", this.vaultMapSchema);
  };

  public getLabelModel = () => {
    return mongoose.model("Label", this.labelSchema);
  };

  public getRemoteKeyModel = () => {
    return mongoose.model("remoteKey", this.remoteKeySchema);
  };

  public getCollaborativeChannelModel = () => {
    return mongoose.model(
      "CollaborativeChannel",
      this.collaborativeChannelSchema,
    );
  };

  public getReferralLinkModel = () => {
    return mongoose.model("referralLink", this.referralLinksSchema);
  };

  public getKeeperPrivateOrderModel = () => {
    return mongoose.model(
      "keeperPrivatePromoCode",
      this.keeperPrivatePromoCodeSchema,
    );
  };
  public getAccountManagerModel = () => {
    return mongoose.model("accountManager", this.accountManagerSchema);
  };
  public getCampaignModel = () => {
    return mongoose.model("campaign", this.campaignSchema);
  };

  public getAdvisorModel = () => {
    return mongoose.model("advisor", this.advisorSchema);
  };

  public getArticleChunkModel = () => {
    return mongoose.model("articleChunk", this.articleChunkSchema);
  };

  public getFaucetQuotaModel = () => {
    return mongoose.model("FaucetQuota", this.faucetQuotaSchema);
  };

  public getRagChunkAllowlistModel = () => {
    return mongoose.model("ragChunkAllowlist", this.ragChunkAllowlistSchema);
  };
}

export default new Database();
