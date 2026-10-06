import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";
import db from "../db";
import { openAIClient } from "./openAIClient";

// --- HTML to plain text ---
function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  return $.text().replace(/\s+/g, " ").trim();
}

// --- Chunk text into ~500 token segments with overlap ---
export function chunkText(
  text: string,
  maxChars = 1500,
  overlap = 200,
): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    chunks.push(text.slice(start, end));
    start += maxChars - overlap;
  }
  return chunks;
}

// --- Generate embeddings in batches ---
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const batchSize = 100; // OpenAI limit per request
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const response = await openAIClient().embeddings.create({
      model: "text-embedding-3-small",
      input: batch,
    });
    allEmbeddings.push(...response.data.map((d) => d.embedding));
  }
  return allEmbeddings;
}

type IngestSummary = {
  articlesLoaded: number;
  chunksCreated: number;
  bulkMatched: number;
  bulkModified: number;
  bulkInserted: number;
};

export async function ingestArticles(): Promise<IngestSummary> {
  const articles = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'all_articles.json'), "utf-8"));
  console.log(`Loaded ${articles.length} articles`);

  const allChunks: Array<{
    articleId: number;
    title: string;
    url: string;
    chunkIndex: number;
    content: string;
    ragTimestamp: Date;
    metadata: any;
  }> = [];

  for (const article of articles) {
    const plainText = htmlToText(article.body || "");
    if (!plainText || plainText.length < 10) continue;

    // Prepend title to content for better semantic matching
    const fullText = `${article.title}. ${plainText}`;
    const chunks = chunkText(fullText);

    chunks.forEach((chunk, idx) => {
      allChunks.push({
        articleId: article.id,
        title: article.title,
        url: article.html_url,
        chunkIndex: idx,
        content: chunk,
        ragTimestamp: article.created_at
          ? new Date(article.created_at)
          : new Date(),
        metadata: {
          sectionId: article.section_id,
          createdAt: article.created_at,
          updatedAt: article.updated_at,
        },
      });
    });
  }

  console.log(`Created ${allChunks.length} chunks, generating embeddings...`);

  // Generate embeddings for all chunks
  const embeddings = await getEmbeddings(allChunks.map((c) => c.content));

  // Upsert into MongoDB
  const bulkOps = allChunks.map((chunk, i) => ({
    updateOne: {
      filter: { articleId: chunk.articleId, chunkIndex: chunk.chunkIndex },
      update: { $set: { ...chunk, embedding: embeddings[i] } },
      upsert: true,
    },
  }));

  const articleChunkModel = db.getArticleChunkModel();
  const bulkWriteResponse: any = await articleChunkModel.bulkWrite(bulkOps);
  console.log(`Ingested ${allChunks.length} chunks into MongoDB`);
  return {
    articlesLoaded: articles.length,
    chunksCreated: allChunks.length,
    bulkMatched:
      bulkWriteResponse?.matchedCount ?? bulkWriteResponse?.nMatched ?? 0,
    bulkModified:
      bulkWriteResponse?.modifiedCount ?? bulkWriteResponse?.nModified ?? 0,
    bulkInserted:
      bulkWriteResponse?.upsertedCount ?? bulkWriteResponse?.nUpserted ?? 0,
  };
}
