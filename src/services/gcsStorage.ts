import { Storage } from "@google-cloud/storage";

const GCS_BUCKET = "keeper-ai-chat";
const GCS_FOLDER = "github-issues";

// Application Default Credentials: managed identity or a file mounted outside Git.
const storage = new Storage();

/**
 * Uploads an in-memory image buffer to the keeper-ai-chat GCS bucket,
 * makes it publicly readable, and returns the public URL.
 */
export async function uploadScreenshotToGCS(
  buffer: Buffer,
  mimeType: string,
  conversationId: string
): Promise<string> {
  const ext = mimeType === "image/png" ? "png" : "jpg";
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const objectName = `${conversationId}-${uniqueId}.${ext}`;
  const filePath = `${GCS_FOLDER}/${objectName}`;

  const bucket = storage.bucket(GCS_BUCKET);
  const file = bucket.file(filePath);

  await file.save(buffer, { contentType: mimeType });
  // Bucket keeper-ai-chat is already configured with allUsers reader at the
  // bucket level, so uploaded objects are publicly accessible without makePublic().

  return `https://storage.googleapis.com/${GCS_BUCKET}/${filePath}`;
}
