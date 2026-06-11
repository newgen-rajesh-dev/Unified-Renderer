import path from "path";
import { S3Client } from "bun";

let client = null;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to upload completed videos to S3`);
  }
  return value;
}

function getS3Config() {
  return {
    accessKeyId: requireEnv("AWS_ACCESS_KEY"),
    secretAccessKey: requireEnv("AWS_SECRET_KEY"),
    bucket: requireEnv("AWS_S3_BUCKET"),
    region: requireEnv("AWS_S3_REGION"),
  };
}

function getClient() {
  if (!client) {
    client = new S3Client(getS3Config());
  }
  return client;
}

function getObjectUrl({ bucket, region, key }) {
  const encodedKey = key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
}

export async function uploadVideoToS3(filePath, { fileName, jobId }) {
  const name = fileName || path.basename(filePath);
  const key = `renders/${jobId}/${name}`;
  const config = getS3Config();
  const s3File = getClient().file(key);

  await s3File.write(Bun.file(filePath), {
    type: "video/mp4",
  });

  return {
    url: getObjectUrl({ bucket: config.bucket, region: config.region, key }),
    key,
    bucket: config.bucket,
    region: config.region,
  };
}
