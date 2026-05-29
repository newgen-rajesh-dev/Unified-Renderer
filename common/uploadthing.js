import path from 'path';
import { UTApi } from 'uploadthing/server';

let client = null;

function getClient() {
  const token = process.env.UPLOADTHING_TOKEN;
  if (!token) {
    throw new Error('UPLOADTHING_TOKEN is required to upload completed videos');
  }
  if (!client) {
    client = new UTApi({ token });
  }
  return client;
}

export async function uploadVideoToUploadThing(filePath, { fileName, jobId }) {
  const name = fileName || path.basename(filePath);
  const file = Bun.file(filePath);
  const uploadFile = new File([await file.arrayBuffer()], name, { type: 'video/mp4' });
  const result = await getClient().uploadFiles(uploadFile, {
    metadata: { jobId },
    contentDisposition: 'inline',
  });

  if (result.error) {
    throw new Error(`UploadThing upload failed: ${result.error.message}`);
  }
  return result.data;
}
