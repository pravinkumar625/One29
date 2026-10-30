const fs = require('fs');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function loadEnvFile(filename) {
  try {
    const envPath = path.join(__dirname, filename);
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const m = /^([^=]+)=(.*)$/.exec(trimmed);
        if (m && !process.env[m[1]]) {
          process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
        }
      }
    }
  } catch {}
}
loadEnvFile('.env.local');
loadEnvFile('.env');

let customClient = null;

function getS3Config() {
  const endpoint = process.env.S3_ENDPOINT || process.env.NEON_STORAGE_ENDPOINT || process.env.AWS_ENDPOINT_URL_S3 || '';
  const region = process.env.S3_REGION || process.env.AWS_REGION || 'auto';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '';
  const bucketPublic = process.env.S3_BUCKET_PUBLIC || 'public-media';
  const bucketPrivate = process.env.S3_BUCKET_PRIVATE || 'private-files';
  const publicBaseUrl = process.env.PUBLIC_FILE_BASE_URL || (endpoint ? `${endpoint.replace(/\/$/, '')}/${bucketPublic}` : '');

  return {
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    bucketPublic,
    bucketPrivate,
    publicBaseUrl,
  };
}

function getS3Client() {
  if (customClient) return customClient;
  const cfg = getS3Config();
  if (!cfg.endpoint || !cfg.accessKeyId || !cfg.secretAccessKey) {
    return null;
  }
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: true,
  });
}

function setS3Client(mock) {
  customClient = mock;
}

async function withRetry(operation, maxRetries = 3) {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (err) {
      attempt++;
      const is503 = err?.$metadata?.httpStatusCode === 503 || /SlowDown|503/i.test(err?.message || '');
      if (attempt < maxRetries && is503) {
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 400));
        continue;
      }
      throw err;
    }
  }
}

async function getPresignedUploadUrl(bucket, key, contentType, expiresIn = 900) {
  const client = getS3Client();
  if (!client) throw new Error('Object storage client is not configured');

  if (customClient && typeof customClient.getPresignedUploadUrl === 'function') {
    return customClient.getPresignedUploadUrl(bucket, key, contentType, expiresIn);
  }

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  return await getSignedUrl(client, command, { expiresIn });
}

async function getPresignedDownloadUrl(bucket, key, expiresIn = 300) {
  const client = getS3Client();
  if (!client) throw new Error('Object storage client is not configured');

  if (customClient && typeof customClient.getPresignedDownloadUrl === 'function') {
    return customClient.getPresignedDownloadUrl(bucket, key, expiresIn);
  }

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return await getSignedUrl(client, command, { expiresIn });
}

async function headObject(bucket, key) {
  const client = getS3Client();
  if (!client) throw new Error('Object storage client is not configured');

  return await withRetry(() => client.send(new HeadObjectCommand({
    Bucket: bucket,
    Key: key,
  })));
}

async function deleteObject(bucket, key) {
  const client = getS3Client();
  if (!client) return;

  try {
    return await withRetry(() => client.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })));
  } catch (err) {
    console.warn(`[storage:delete] Warning deleting ${bucket}/${key}:`, err.message);
  }
}

function getPublicUrl(storageKey) {
  const cfg = getS3Config();
  if (cfg.publicBaseUrl) {
    return `${cfg.publicBaseUrl.replace(/\/$/, '')}/${storageKey}`;
  }
  return `/api/files/download/${encodeURIComponent(storageKey)}`;
}

async function ensureBucketsExist() {
  const client = getS3Client();
  if (!client) return { status: 'unconfigured' };

  const cfg = getS3Config();
  const created = [];

  for (const b of [cfg.bucketPublic, cfg.bucketPrivate]) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: b }));
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        try {
          await client.send(new CreateBucketCommand({ Bucket: b }));
          created.push(b);
        } catch (createErr) {
          console.warn(`[storage] Could not create bucket ${b}:`, createErr.message);
        }
      }
    }
  }

  return { status: 'ready', created };
}

module.exports = {
  getS3Config,
  getS3Client,
  setS3Client,
  withRetry,
  getPresignedUploadUrl,
  getPresignedDownloadUrl,
  headObject,
  deleteObject,
  getPublicUrl,
  ensureBucketsExist,
};
