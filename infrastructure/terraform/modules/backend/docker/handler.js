// handler.js - Lambda wrapper for LibreChat API (CommonJS)
// Supports both streaming (SSE) and standard responses
// Build timestamp: 2025-12-26T22:40:00Z - Fix multi-value headers for API Gateway (FR-033)

const { spawn } = require('child_process');
const http = require('http');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const fs = require('fs');

const LIBRECHAT_PORT = 3080;
const LIBRECHAT_HOST = 'localhost';
const CONFIG_PATH = '/tmp/librechat.yaml';

// Paths that use SSE streaming
const STREAMING_PATHS = ['/api/ask', '/api/chat', '/api/agents', '/api/edit'];

let server = null;
let serverReady = false;
let secretsFetched = false;

// SSM Parameter mappings: env var name -> SSM_PARAM_* env var that contains the ARN
const SSM_PARAM_MAPPINGS = {
  CREDS_IV: 'SSM_PARAM_CREDS_IV',
  CREDS_KEY: 'SSM_PARAM_CREDS_KEY',
  JWT_SECRET: 'SSM_PARAM_JWT_SECRET',
  JWT_REFRESH_SECRET: 'SSM_PARAM_JWT_REFRESH',
  MONGO_URI: 'SSM_PARAM_MONGO_URI',
  LITELLM_API_KEY: 'SSM_PARAM_LITELLM_API_KEY',
  MEILI_MASTER_KEY: 'SSM_PARAM_MEILI_MASTER_KEY',
  FIRECRAWL_API_KEY: 'SSM_PARAM_FIRECRAWL_API_KEY',
  OPENID_CLIENT_ID: 'SSM_PARAM_OPENID_CLIENT_ID',
  OPENID_CLIENT_SECRET: 'SSM_PARAM_OPENID_CLIENT_SECRET',
  OPENID_SESSION_SECRET: 'SSM_PARAM_OPENID_SESSION_SECRET',
};

/**
 * Check if request path is a streaming endpoint
 */
function isStreamingEndpoint(path) {
  return STREAMING_PATHS.some((streamPath) => path.startsWith(streamPath));
}

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
    // SSM parameter names need leading slash
    let paramName = paramArn.split('parameter/')[1];
    if (!paramName) {
      console.warn(`Invalid SSM ARN format for ${ssmEnvVar}: ${paramArn}`);
      continue;
    }
    // Ensure leading slash for SSM parameter name
    if (!paramName.startsWith('/')) {
      paramName = '/' + paramName;
    }

    fetchPromises.push(
      (async () => {
        try {
          const command = new GetParameterCommand({
            Name: paramName,
            WithDecryption: true,
          });
          const response = await ssm.send(command);
          process.env[envName] = response.Parameter.Value;
          console.log(`Fetched secret for ${envName}`);
        } catch (error) {
          console.error(`Failed to fetch ${envName} from ${paramName}:`, error.message);
          throw error;
        }
      })(),
    );
  }

  await Promise.all(fetchPromises);

  // Fix MongoDB SSL certificate path for Lambda environment (FR-029)
  // SSM stores the URI configured for ECS which may have different cert path
  if (process.env.MONGO_URI) {
    const lambdaCertPath = '/ssl/global-bundle.pem';
    let mongoUri = process.env.MONGO_URI;

    // Replace any existing tlsCAFile path with Lambda's cert location
    if (mongoUri.includes('tlsCAFile=')) {
      mongoUri = mongoUri.replace(/tlsCAFile=[^&]+/, `tlsCAFile=${lambdaCertPath}`);
    } else if (mongoUri.includes('?')) {
      // Add tlsCAFile if tls is enabled but no cert specified
      mongoUri = mongoUri + `&tlsCAFile=${lambdaCertPath}`;
    } else {
      mongoUri = mongoUri + `?tlsCAFile=${lambdaCertPath}`;
    }

    process.env.MONGO_URI = mongoUri;
    console.log('Updated MONGO_URI with Lambda SSL cert path');
  }

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
    const updatedConfig = body.replace(
      /genai\.sandbox\.data\.apro\.is/g,
      customDomain.replace('https://', ''),
    );

    fs.writeFileSync(CONFIG_PATH, updatedConfig);
    console.log('Config file fetched and updated successfully');
  } catch (error) {
    console.error('Failed to fetch config:', error);
    throw error;
  }
}

/**
 * Write AWS credentials to shared credentials file for SDK default provider (FR-034)
 * LibreChat's initializeS3() intercepts env vars and creates credentials without sessionToken.
 * By using a credentials file instead, we bypass that code and let the SDK read all three values.
 */
function writeCredentialsFile() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;

  if (!accessKeyId || !secretAccessKey) {
    console.log('No AWS credentials in environment - skipping credentials file');
    return null;
  }

  const credentialsDir = '/tmp/.aws';
  const credentialsPath = `${credentialsDir}/credentials`;

  if (!fs.existsSync(credentialsDir)) {
    fs.mkdirSync(credentialsDir, { recursive: true });
  }

  // Write credentials in INI format that AWS SDK expects
  let content = `[default]
aws_access_key_id = ${accessKeyId}
aws_secret_access_key = ${secretAccessKey}`;

  if (sessionToken) {
    content += `
aws_session_token = ${sessionToken}`;
  }

  fs.writeFileSync(credentialsPath, content, { mode: 0o600 });
  console.log('AWS credentials file written for SDK default provider');

  return credentialsPath;
}

/**
 * Start LibreChat server (cold start only)
 */
async function ensureServerRunning() {
  if (serverReady) return;

  // Kill any orphaned process from previous failed attempt (FR-030)
  if (server && !server.killed) {
    console.log('Killing orphaned LibreChat process before retry');
    server.kill('SIGKILL');
    server = null;
    // Brief pause to ensure port is released
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Fetch secrets from SSM on cold start
  await fetchSecrets();

  // Fetch config on cold start (FR-026)
  await fetchConfig();

  // Write credentials file before spawning child process (FR-034)
  const credentialsPath = writeCredentialsFile();

  // Create log directory in /tmp (Lambda filesystem is read-only except /tmp)
  const logDir = process.env.LIBRECHAT_LOG_DIR || '/tmp/logs';
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
    console.log(`Created log directory: ${logDir}`);
  }

  return new Promise((resolve, reject) => {
    console.log('Starting LibreChat server...');
    console.log(`LIBRECHAT_LOG_DIR in handler: ${process.env.LIBRECHAT_LOG_DIR}`);

    // Diagnostic: Check if entry point exists
    const entryPoint = '/var/task/api/server/index.js';
    if (fs.existsSync(entryPoint)) {
      console.log(`Entry point exists: ${entryPoint}`);
      const stats = fs.statSync(entryPoint);
      console.log(`Entry point size: ${stats.size} bytes`);
    } else {
      console.error(`ERROR: Entry point does not exist: ${entryPoint}`);
      // List what's in /var/task/api/server to help debug
      const serverDir = '/var/task/api/server';
      if (fs.existsSync(serverDir)) {
        const files = fs.readdirSync(serverDir);
        console.log(`Files in ${serverDir}: ${files.slice(0, 20).join(', ')}`);
      } else {
        console.error(`Directory does not exist: ${serverDir}`);
        // Check /var/task/api
        if (fs.existsSync('/var/task/api')) {
          const apiFiles = fs.readdirSync('/var/task/api');
          console.log(`Files in /var/task/api: ${apiFiles.join(', ')}`);
        }
      }
    }

    // Build environment for LibreChat child process (FR-034)
    // Remove AWS credential env vars so LibreChat's initializeS3() doesn't intercept them.
    // LibreChat creates credentials without sessionToken when it sees these env vars.
    // By removing them and pointing to a credentials file instead, the SDK's default
    // provider chain reads ALL credentials (including sessionToken) from the file.
    const childEnv = { ...process.env };
    delete childEnv.AWS_ACCESS_KEY_ID;
    delete childEnv.AWS_SECRET_ACCESS_KEY;
    delete childEnv.AWS_SESSION_TOKEN;

    // Point SDK to credentials file instead
    if (credentialsPath) {
      childEnv.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
      console.log(`Set AWS_SHARED_CREDENTIALS_FILE=${credentialsPath}`);
    }

    server = spawn('node', [entryPoint], {
      env: {
        ...childEnv,
        PORT: String(LIBRECHAT_PORT),
        HOST: LIBRECHAT_HOST,
        CONFIG_PATH: CONFIG_PATH,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    console.log(`Spawned LibreChat process with PID: ${server.pid}`);

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

    server.on('exit', (code, signal) => {
      console.error(`LibreChat process exited with code ${code}, signal ${signal}`);
      if (!serverReady) {
        reject(new Error(`Server process exited unexpectedly: code=${code}, signal=${signal}`));
      }
    });

    server.on('close', (code, signal) => {
      console.log(`LibreChat process closed with code ${code}, signal ${signal}`);
    });

    // Wait for server to be healthy (90 attempts × 500ms = 45s max)
    const maxAttempts = 90;
    let attempts = 0;
    let resolved = false; // Flag to stop health check loop once resolved

    const checkHealth = () => {
      if (resolved) return; // Stop if already resolved
      attempts++;
      const req = http.request(
        {
          hostname: LIBRECHAT_HOST,
          port: LIBRECHAT_PORT,
          path: '/health',
          method: 'GET',
          timeout: 1000,
        },
        (res) => {
          if (resolved) return; // Double-check in case of race condition
          if (res.statusCode === 200) {
            console.log('LibreChat server is ready');
            resolved = true; // Stop the loop before resolving
            serverReady = true;
            resolve();
          } else {
            retry();
          }
        },
      );

      req.on('error', () => {
        if (!resolved) retry();
      });
      req.on('timeout', () => {
        if (!resolved) retry();
      });
      req.end();
    };

    const retry = () => {
      if (resolved) return; // Stop if already resolved
      if (attempts < maxAttempts) {
        setTimeout(checkHealth, 500);
      } else {
        // Kill the process to prevent port conflicts on retry (FR-030)
        if (server) {
          console.error('Startup timeout - killing LibreChat process to free port');
          server.kill('SIGTERM');
          setTimeout(() => {
            if (server && !server.killed) {
              server.kill('SIGKILL');
            }
          }, 1000);
          server = null;
        }
        reject(new Error('Server failed to start within timeout'));
      }
    };

    // Start checking after a short delay
    setTimeout(checkHealth, 1000);
  });
}

/**
 * Forward request to LibreChat with streaming response
 * Pipes SSE data directly to Lambda response stream
 */
async function proxyStreamingRequest(event, responseStream) {
  const path =
    event.path +
    (event.queryStringParameters
      ? '?' + new URLSearchParams(event.queryStringParameters).toString()
      : '');

  console.log(`Streaming request: ${event.httpMethod} ${path}`);

  const options = {
    hostname: LIBRECHAT_HOST,
    port: LIBRECHAT_PORT,
    path: path,
    method: event.httpMethod,
    headers: {
      ...event.headers,
      host: `${LIBRECHAT_HOST}:${LIBRECHAT_PORT}`,
    },
  };

  // Remove headers that should not be forwarded
  delete options.headers['Host'];
  delete options.headers['host'];
  delete options.headers['Content-Length'];
  delete options.headers['content-length'];
  // Strip caching headers to prevent 304 responses (FR-031)
  delete options.headers['If-None-Match'];
  delete options.headers['if-none-match'];
  delete options.headers['If-Modified-Since'];
  delete options.headers['if-modified-since'];
  // Strip Accept-Encoding to get uncompressed responses from backend (FR-032)
  delete options.headers['Accept-Encoding'];
  delete options.headers['accept-encoding'];

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      console.log(`Streaming response status: ${res.statusCode}`);

      // Set content type for streaming
      const contentType = res.headers['content-type'] || 'text/event-stream';
      responseStream.setContentType(contentType);

      // Write HTTP metadata as prelude (required for API Gateway integration)
      const metadata = {
        statusCode: res.statusCode,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers':
            'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,Cookie',
          'Access-Control-Allow-Methods': 'DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT',
        },
      };

      // Write prelude with metadata
      responseStream = awslambda.HttpResponseStream.from(responseStream, metadata);

      // Pipe data chunks directly to response stream
      res.on('data', (chunk) => {
        responseStream.write(chunk);
      });

      res.on('end', () => {
        console.log('Streaming response complete');
        responseStream.end();
        resolve();
      });

      res.on('error', (err) => {
        console.error('Streaming response error:', err);
        responseStream.end();
        reject(err);
      });
    });

    req.on('error', (err) => {
      console.error('Streaming request error:', err);
      // Try to write error response
      try {
        const errorMetadata = {
          statusCode: 500,
          headers: { 'Content-Type': 'application/json' },
        };
        responseStream = awslambda.HttpResponseStream.from(responseStream, errorMetadata);
        responseStream.write(
          JSON.stringify({ error: 'Internal Server Error', message: err.message }),
        );
        responseStream.end();
      } catch (e) {
        console.error('Failed to write error response:', e);
      }
      reject(err);
    });

    // Send request body if present
    if (event.body) {
      const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
      req.write(body);
    }

    req.end();
  });
}

/**
 * Forward request to LibreChat with standard (buffered) response
 */
async function proxyStandardRequest(event) {
  const path =
    event.path +
    (event.queryStringParameters
      ? '?' + new URLSearchParams(event.queryStringParameters).toString()
      : '');

  console.log(`Standard request: ${event.httpMethod} ${path}`);

  const options = {
    hostname: LIBRECHAT_HOST,
    port: LIBRECHAT_PORT,
    path: path,
    method: event.httpMethod,
    timeout: 28000, // 28s timeout (below API Gateway's 29s limit)
    headers: {
      ...event.headers,
      host: `${LIBRECHAT_HOST}:${LIBRECHAT_PORT}`,
    },
  };

  // Remove headers that should not be forwarded
  delete options.headers['Host'];
  delete options.headers['host'];
  delete options.headers['Content-Length'];
  delete options.headers['content-length'];
  // Strip caching headers to prevent 304 responses (FR-031)
  // 304 responses have no body, which breaks API Gateway/CloudFront proxying
  delete options.headers['If-None-Match'];
  delete options.headers['if-none-match'];
  delete options.headers['If-Modified-Since'];
  delete options.headers['if-modified-since'];
  // Strip Accept-Encoding to get uncompressed responses from backend (FR-032)
  // CloudFront handles compression - double-compression causes ERR_CONTENT_DECODING_FAILED
  delete options.headers['Accept-Encoding'];
  delete options.headers['accept-encoding'];

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      console.log(`Response received: ${res.statusCode} ${res.statusMessage}`);
      const chunks = [];

      res.on('data', (chunk) => {
        chunks.push(chunk);
      });

      res.on('end', () => {
        const body = Buffer.concat(chunks);
        console.log(`Response complete: ${body.length} bytes`);

        // Check if response is binary
        const contentType = res.headers['content-type'] || '';
        const isBinary =
          contentType.includes('image') ||
          contentType.includes('audio') ||
          contentType.includes('video') ||
          contentType.includes('application/octet-stream') ||
          contentType.includes('application/pdf');

        // Build response headers (filter out hop-by-hop headers)
        // API Gateway requires multiValueHeaders for headers with array values (FR-033)
        const responseHeaders = {};
        const multiValueHeaders = {};
        const hopByHopHeaders = [
          'connection',
          'keep-alive',
          'transfer-encoding',
          'te',
          'trailer',
          'upgrade',
        ];
        for (const [key, value] of Object.entries(res.headers)) {
          if (!hopByHopHeaders.includes(key.toLowerCase())) {
            if (Array.isArray(value)) {
              // Multi-value headers (like set-cookie) go in multiValueHeaders
              multiValueHeaders[key] = value;
            } else {
              responseHeaders[key] = value;
            }
          }
        }

        const response = {
          statusCode: res.statusCode,
          headers: responseHeaders,
          body: isBinary ? body.toString('base64') : body.toString('utf-8'),
          isBase64Encoded: isBinary,
        };

        // Only include multiValueHeaders if there are any (FR-033)
        if (Object.keys(multiValueHeaders).length > 0) {
          response.multiValueHeaders = multiValueHeaders;
        }

        resolve(response);
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

    req.on('timeout', () => {
      console.error('Request timeout after 28s');
      req.destroy();
      reject(new Error('Request timeout'));
    });

    // Send request body if present
    if (event.body) {
      const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
      req.write(body);
    }

    req.end();
  });
}

/**
 * Standard Lambda handler - the main entry point
 *
 * This handler is used when API Gateway invokes Lambda with standard invocation.
 * It returns a standard Lambda proxy response object.
 *
 * For standard invocation (non-streaming endpoints like /api/config, /api/banner):
 * - API Gateway uses: .../2015-03-31/functions/.../invocations
 * - Handler returns: { statusCode, headers, body }
 */
exports.handler = async (event, context) => {
  const path = event.path || '';
  console.log(`Standard handler invoked: path=${path}`);

  try {
    // Ensure LibreChat is running
    await ensureServerRunning();

    // Use standard proxy for API endpoints
    const response = await proxyStandardRequest(event);
    console.log(
      `Standard response: statusCode=${response.statusCode}, bodyLength=${response.body?.length || 0}`,
    );
    return response;
  } catch (error) {
    console.error('Standard handler error:', error);

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Internal Server Error',
        message: error.message,
      }),
    };
  }
};

/**
 * Streaming Lambda handler using awslambda.streamifyResponse
 *
 * This handler is used when API Gateway invokes Lambda with streaming invocation.
 * It uses responseStream to pipe SSE data directly to the client.
 *
 * For streaming invocation (SSE endpoints like /api/chat, /api/ask, /api/agents):
 * - API Gateway uses: .../2021-11-15/functions/.../response-streaming-invocations
 * - Handler pipes: data -> responseStream -> client
 */
exports.streamingHandler = awslambda.streamifyResponse(async (event, responseStream, context) => {
  const path = event.path || '';
  console.log(`Streaming handler invoked: path=${path}`);

  try {
    // Ensure LibreChat is running
    await ensureServerRunning();

    // Use streaming proxy for SSE endpoints
    console.log(`Processing streaming request: ${path}`);
    await proxyStreamingRequest(event, responseStream);
  } catch (error) {
    console.error('Streaming handler error:', error);

    try {
      const errorMetadata = {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
      };
      responseStream = awslambda.HttpResponseStream.from(responseStream, errorMetadata);
      responseStream.write(
        JSON.stringify({
          error: 'Internal Server Error',
          message: error.message,
        }),
      );
      responseStream.end();
    } catch (e) {
      console.error('Failed to write error response:', e);
      responseStream.end();
    }
  }
});
