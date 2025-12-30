// handler.mjs - Lambda wrapper for LibreChat API
// Standard async handler (streaming requires HTTP API v2 for proper support)

import { spawn } from 'child_process';
import http from 'http';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import fs from 'fs';

const LIBRECHAT_PORT = 3080;
const LIBRECHAT_HOST = 'localhost';
const CONFIG_PATH = '/tmp/librechat.yaml';

let server = null;
let serverReady = false;
let secretsFetched = false;

// SSM Parameter mappings: env var name -> SSM_PARAM_* env var that contains the ARN
const SSM_PARAM_MAPPINGS = {
  'CREDS_IV': 'SSM_PARAM_CREDS_IV',
  'CREDS_KEY': 'SSM_PARAM_CREDS_KEY',
  'JWT_SECRET': 'SSM_PARAM_JWT_SECRET',
  'JWT_REFRESH_SECRET': 'SSM_PARAM_JWT_REFRESH',
  'MONGO_URI': 'SSM_PARAM_MONGO_URI',
  'LITELLM_API_KEY': 'SSM_PARAM_LITELLM_API_KEY',
  'MEILI_MASTER_KEY': 'SSM_PARAM_MEILI_MASTER_KEY',
  'FIRECRAWL_API_KEY': 'SSM_PARAM_FIRECRAWL_API_KEY',
  'OPENID_CLIENT_ID': 'SSM_PARAM_OPENID_CLIENT_ID',
  'OPENID_CLIENT_SECRET': 'SSM_PARAM_OPENID_CLIENT_SECRET',
  'OPENID_SESSION_SECRET': 'SSM_PARAM_OPENID_SESSION_SECRET'
};

/**
 * Fetch secrets from SSM Parameter Store at cold start
 * Maps SSM_PARAM_* env vars to actual secret values
 */
async function fetchSecrets() {
  if (secretsFetched) return;

  const ssm = new SSMClient({});
  const fetchPromises = [];

  for (const [envName, ssmEnvVar] of Object.entries(SSM_PARAM_MAPPINGS)) {
    const paramArn = process.env[ssmEnvVar];
    if (!paramArn) {
      console.warn(`SSM parameter ARN not set for ${ssmEnvVar}`);
      continue;
    }

    // Extract parameter name from ARN (last part after 'parameter/')
    const paramName = paramArn.split('parameter/')[1];
    if (!paramName) {
      console.warn(`Invalid SSM ARN format for ${ssmEnvVar}: ${paramArn}`);
      continue;
    }

    fetchPromises.push(
      (async () => {
        try {
          const command = new GetParameterCommand({
            Name: paramName,
            WithDecryption: true
          });
          const response = await ssm.send(command);
          process.env[envName] = response.Parameter.Value;
          console.log(`Fetched secret for ${envName}`);
        } catch (error) {
          console.error(`Failed to fetch ${envName} from ${paramName}:`, error.message);
          throw error;
        }
      })()
    );
  }

  await Promise.all(fetchPromises);
  secretsFetched = true;
  console.log('All secrets fetched successfully');
}

/**
 * Download config file from S3 at cold start
 */
async function fetchConfig() {
  const s3 = new S3Client({});
  const bucket = process.env.CONFIG_S3_BUCKET || 'genai-shared-config';
  const key = process.env.CONFIG_S3_KEY || 'lambda-test/librechat/librechat.yaml';

  try {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await s3.send(command);
    const body = await response.Body.transformToString();

    // Replace domain references (FR-027)
    const customDomain = process.env.DOMAIN_SERVER || 'lambda-test.sandbox.data.apro.is';
    const updatedConfig = body.replace(/genai\.sandbox\.data\.apro\.is/g, customDomain.replace('https://', ''));

    fs.writeFileSync(CONFIG_PATH, updatedConfig);
    console.log('Config file fetched and updated successfully');
  } catch (error) {
    console.error('Failed to fetch config:', error);
    throw error;
  }
}

/**
 * Start LibreChat server (cold start only)
 */
async function ensureServerRunning() {
  if (serverReady) return;

  // Fetch secrets from SSM on cold start
  await fetchSecrets();

  // Fetch config on cold start (FR-026)
  await fetchConfig();

  return new Promise((resolve, reject) => {
    console.log('Starting LibreChat server...');

    server = spawn('node', ['/var/task/api/server/index.js'], {
      env: {
        ...process.env,
        PORT: String(LIBRECHAT_PORT),
        HOST: LIBRECHAT_HOST,
        CONFIG_PATH: CONFIG_PATH
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    server.stdout.on('data', (data) => {
      console.log(`LibreChat: ${data}`);
    });

    server.stderr.on('data', (data) => {
      console.error(`LibreChat stderr: ${data}`);
    });

    server.on('error', (err) => {
      console.error('Failed to start server:', err);
      reject(err);
    });

    // Wait for server to be healthy
    const maxAttempts = 60;
    let attempts = 0;

    const checkHealth = () => {
      attempts++;
      const req = http.request({
        hostname: LIBRECHAT_HOST,
        port: LIBRECHAT_PORT,
        path: '/api/health',
        method: 'GET',
        timeout: 1000
      }, (res) => {
        if (res.statusCode === 200) {
          console.log('LibreChat server is ready');
          serverReady = true;
          resolve();
        } else {
          retry();
        }
      });

      req.on('error', retry);
      req.on('timeout', retry);
      req.end();
    };

    const retry = () => {
      if (attempts < maxAttempts) {
        setTimeout(checkHealth, 500);
      } else {
        reject(new Error('Server failed to start within timeout'));
      }
    };

    // Start checking after a short delay
    setTimeout(checkHealth, 1000);
  });
}

/**
 * Forward request to LibreChat and return response
 * Standard (non-streaming) proxy for REST API v1
 */
async function proxyRequest(event) {
  const options = {
    hostname: LIBRECHAT_HOST,
    port: LIBRECHAT_PORT,
    path: event.path + (event.queryStringParameters
      ? '?' + new URLSearchParams(event.queryStringParameters).toString()
      : ''),
    method: event.httpMethod,
    headers: {
      ...event.headers,
      host: `${LIBRECHAT_HOST}:${LIBRECHAT_PORT}`
    }
  };

  // Remove headers that should not be forwarded
  delete options.headers['Host'];
  delete options.headers['host'];
  delete options.headers['Content-Length'];
  delete options.headers['content-length'];

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];

      res.on('data', (chunk) => {
        chunks.push(chunk);
      });

      res.on('end', () => {
        const body = Buffer.concat(chunks);

        // Check if response is binary
        const contentType = res.headers['content-type'] || '';
        const isBinary = contentType.includes('image') ||
                        contentType.includes('audio') ||
                        contentType.includes('video') ||
                        contentType.includes('application/octet-stream') ||
                        contentType.includes('application/pdf');

        // Build response headers (filter out hop-by-hop headers)
        const responseHeaders = {};
        const hopByHopHeaders = ['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade'];
        for (const [key, value] of Object.entries(res.headers)) {
          if (!hopByHopHeaders.includes(key.toLowerCase())) {
            responseHeaders[key] = value;
          }
        }

        resolve({
          statusCode: res.statusCode,
          headers: responseHeaders,
          body: isBinary ? body.toString('base64') : body.toString('utf-8'),
          isBase64Encoded: isBinary
        });
      });

      res.on('error', (err) => {
        console.error('Response error:', err);
        reject(err);
      });
    });

    req.on('error', (err) => {
      console.error('Request error:', err);
      reject(err);
    });

    // Send request body if present
    if (event.body) {
      const body = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : event.body;
      req.write(body);
    }

    req.end();
  });
}

/**
 * Main Lambda handler - standard async format
 */
export const handler = async (event, context) => {
  try {
    // Ensure LibreChat is running
    await ensureServerRunning();

    // Proxy request to LibreChat
    return await proxyRequest(event);
  } catch (error) {
    console.error('Handler error:', error);

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Internal Server Error',
        message: error.message
      })
    };
  }
};
