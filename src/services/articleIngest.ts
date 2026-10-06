import {
  chunkText,
  getEmbeddings,
  ingestArticles,
} from "../utils/ingestArticles";

export const ingestArticlesService = async () => {
  return ingestArticles();
};

export const hasRagChunkAccessByPublicId = async (
  publicId: string,
): Promise<boolean> => {
  const normalizedPublicId = publicId?.trim();
  if (!normalizedPublicId) return false;

  const db = (await import("../db")).default;
  const allowlistModel = db.getRagChunkAllowlistModel();
  const match = await allowlistModel.findOne({
    publicId: { $regex: `^${normalizedPublicId}$`, $options: "i" }, // Case-insensitive regex match
    isActive: true,
  });

  return !!match;
};

export const addRagChunkFrontendService = async (input: {
  publicId: string;
  content: string;
  title?: string;
  url?: string;
  ragTimestamp?: Date;
}) => {
  const { publicId, content, title, url, ragTimestamp } = input;

  const hasAccess = await hasRagChunkAccessByPublicId(publicId);
  if (!hasAccess) {
    throw new Error("Unauthorized request");
  }

  return addRagChunkService({
    content,
    title,
    url,
    ragTimestamp,
  });
};

// Service for adding arbitrary RAG chunks
export const addRagChunkService = async (input: {
  content: string;
  title?: string;
  url?: string;
  metadata?: any;
  ragTimestamp?: Date;
}) => {
  const { content, title, url, metadata, ragTimestamp } = input;
  const db = (await import("../db")).default;

  // Use title if provided, else fallback
  const fullText = title ? `${title}. ${content}` : content;
  const chunks = chunkText(fullText);

  // Generate embeddings
  const embeddings = await getEmbeddings(chunks);

  // Generate a unique articleId
  const articleId = Math.floor(Math.random() * 1e9) + Date.now();

  // Prepare chunk docs
  const chunkRagTimestamp = ragTimestamp ?? new Date();
  const allChunks = chunks.map((chunk, idx) => ({
    articleId,
    title: title || "RAG Chunk",
    url: url || null,
    chunkIndex: idx,
    content: chunk,
    embedding: embeddings[idx],
    ragTimestamp: chunkRagTimestamp,
    metadata: metadata || {},
  }));

  // Upsert into MongoDB
  const articleChunkModel = db.getArticleChunkModel();
  const bulkOps = allChunks.map((chunk) => ({
    updateOne: {
      filter: { articleId: chunk.articleId, chunkIndex: chunk.chunkIndex },
      update: { $set: chunk },
      upsert: true,
    },
  }));
  const bulkWriteResponse = await articleChunkModel.bulkWrite(bulkOps);

  return {
    articleId,
    chunksCreated: allChunks.length,
    bulkMatched: bulkWriteResponse?.matchedCount ?? 0,
    bulkModified: bulkWriteResponse?.modifiedCount ?? 0,
    bulkInserted: bulkWriteResponse?.upsertedCount ?? 0,
  };
};
