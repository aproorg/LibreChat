# Lambda Handler Contract

**Branch**: `001-aws-serverless-deploy` | **Date**: 2025-12-25
**Status**: Updated - Simplified architecture with aws-lambda-ric

## Overview

This document defines the contract for the Lambda handler that wraps the LibreChat API. The handler uses `aws-lambda-ric` (Runtime Interface Client) and `awslambda.streamifyResponse()` for SSE streaming support.

---

## Docker Container Specification

### Dockerfile

```dockerfile
# Base image (FR-006)
FROM ghcr.io/danny-avila/librechat-api:v0.8.2-rc1

WORKDIR /app

# Install aws-lambda-ric (FR-007)
RUN npm install aws-lambda-ric

# Copy Lambda handler wrapper (FR-008)
COPY handler.mjs /app/handler.mjs

# Lambda runtime interface
ENTRYPOINT ["/usr/local/bin/npx", "aws-lambda-ric"]
CMD ["handler.handler"]
```

### Build Context

```
infrastructure/terraform/modules/backend/docker/
├── Dockerfile
└── handler.mjs
```

---

## Handler Interface

### Function Signature

```javascript
// handler.mjs
export const handler = awslambda.streamifyResponse(
  async (event, responseStream, context) => {
    // Implementation
  }
);
```

### Input: API Gateway Event

```typescript
interface APIGatewayProxyEvent {
  httpMethod: string;                    // "GET", "POST", etc.
  path: string;                          // "/api/chat/completions"
  headers: Record<string, string>;       // HTTP headers
  queryStringParameters: Record<string, string> | null;
  body: string | null;                   // Request body (JSON string)
  isBase64Encoded: boolean;
  requestContext: {
    requestId: string;
    stage: string;
    path: string;
    httpMethod: string;
    identity: {
      sourceIp: string;
      userAgent: string;
    };
  };
}
```

### Output: Streaming Response

For SSE streaming endpoints (`/api/ask/*`, `/api/chat/*`, `/api/agents/*`):

```javascript
const httpResponseMetadata = {
  statusCode: 200,
  headers: {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  }
};

responseStream = awslambda.HttpResponseStream.from(responseStream, httpResponseMetadata);

// Write SSE chunks
responseStream.write("data: {\"content\": \"chunk1\"}\n\n");
responseStream.write("data: {\"content\": \"chunk2\"}\n\n");
responseStream.write("data: [DONE]\n\n");
responseStream.end();
```

For non-streaming endpoints:

```javascript
const httpResponseMetadata = {
  statusCode: 200,
  headers: {
    "Content-Type": "application/json"
  }
};

responseStream = awslambda.HttpResponseStream.from(responseStream, httpResponseMetadata);
responseStream.write(JSON.stringify(responseBody));
responseStream.end();
```

---

## Handler Implementation

### Complete handler.mjs

```javascript
// handler.mjs - Lambda wrapper for LibreChat API
import { spawn } from 'child_process';
import http from 'http';
import https from 'https';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const LIBRECHAT_PORT = 3080;
const LIBRECHAT_HOST = 'localhost';
const CONFIG_PATH = '/tmp/librechat.yaml';

let server = null;
let serverReady = false;

// SSE endpoints that require streaming
const SSE_PATTERNS = [
  /^\/api\/ask\//,
  /^\/api\/chat\//,
  /^\/api\/agents\//
];

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

    const fs = await import('fs');
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

  // Fetch config on cold start (FR-026)
  await fetchConfig();

  return new Promise((resolve, reject) => {
    console.log('Starting LibreChat server...');

    server = spawn('node', ['/app/dist/server/index.js'], {
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
 * Check if path requires SSE streaming
 */
function isStreamingEndpoint(path) {
  return SSE_PATTERNS.some(pattern => pattern.test(path));
}

/**
 * Forward request to LibreChat and stream response
 */
async function proxyRequest(event, responseStream) {
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

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      // Set response metadata
      const httpResponseMetadata = {
        statusCode: res.statusCode,
        headers: { ...res.headers }
      };

      responseStream = awslambda.HttpResponseStream.from(responseStream, httpResponseMetadata);

      // Stream the response
      res.on('data', (chunk) => {
        responseStream.write(chunk);
      });

      res.on('end', () => {
        responseStream.end();
        resolve();
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

    // Set timeout for streaming requests
    if (isStreamingEndpoint(event.path)) {
      req.setTimeout(890000); // Just under Lambda 15-min limit
    }

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
 * Main Lambda handler with streaming support
 */
export const handler = awslambda.streamifyResponse(
  async (event, responseStream, context) => {
    try {
      // Ensure LibreChat is running
      await ensureServerRunning();

      // Proxy request to LibreChat
      await proxyRequest(event, responseStream);
    } catch (error) {
      console.error('Handler error:', error);

      const errorResponse = {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' }
      };

      responseStream = awslambda.HttpResponseStream.from(responseStream, errorResponse);
      responseStream.write(JSON.stringify({
        error: 'Internal Server Error',
        message: error.message
      }));
      responseStream.end();
    }
  }
);
```

---

## Cold Start Behavior

### Initialization Sequence

1. **Lambda receives first request** (cold start)
2. **Fetch config from S3** (FR-026)
   - Download `librechat.yaml` from `s3://genai-shared-config/lambda-test/librechat/`
   - Replace `genai.sandbox.data.apro.is` with `lambda-test.sandbox.data.apro.is` (FR-027)
   - Write to `/tmp/librechat.yaml`
3. **Start LibreChat server**
   - Spawn Node.js process with `CONFIG_PATH=/tmp/librechat.yaml`
   - LibreChat connects to DocumentDB, Redis, Cloud Map services
4. **Health check loop**
   - Poll `/api/health` every 500ms
   - Up to 60 attempts (30 seconds max)
5. **Mark server ready**
   - Set `serverReady = true`
   - Server persists across warm invocations

### Warm Start Behavior

- Skip steps 2-5
- Immediately proxy request to running LibreChat server
- Response latency ~50-100ms

---

## Environment Variables

### Required (Lambda Configuration)

| Variable | Description | Example |
|----------|-------------|---------|
| `DOMAIN_SERVER` | Server domain | `https://lambda-test.sandbox.data.apro.is` |
| `DOMAIN_CLIENT` | Client domain | `https://lambda-test.sandbox.data.apro.is` |
| `CONFIG_PATH` | Path to config file | `/tmp/librechat.yaml` |
| `USE_REDIS` | Enable Redis | `true` |
| `REDIS_URI` | Redis connection string | `redis://librechat-lambda-redis.xxx.cache.amazonaws.com:6379` |
| `AWS_BUCKET_NAME` | File storage bucket | `librechat-lambda-files-dev` |
| `LITELLM_BASE_URL` | LiteLLM endpoint | `http://litellm.dev-aprochat-core.local:4000/v1` |
| `SEARXNG_INSTANCE_URL` | SearXNG endpoint | `http://searxng.dev-aprochat-core.local:8080` |
| `RAG_API_URL` | RAG API endpoint | `http://rag-api.dev-aprochat-core.local:8000` |
| `MEILI_HOST` | Meilisearch endpoint | `http://meilisearch.dev-aprochat-core.local:7700` |
| `FIRECRAWL_API_URL` | Firecrawl endpoint | `http://firecrawl.dev-aprochat-core.local:3002` |

### Secrets (from SSM Parameter Store)

| Variable | SSM Parameter |
|----------|---------------|
| `CREDS_IV` | `/ecs/genai/librechat/CREDS_IV` |
| `CREDS_KEY` | `/ecs/genai/librechat/CREDS_KEY` |
| `JWT_SECRET` | `/ecs/genai/librechat/JWT_SECRET` |
| `JWT_REFRESH_SECRET` | `/ecs/genai/librechat/JWT_REFRESH_SECRET` |
| `MONGO_URI` | `/ecs/genai/mongo/DB_URI` |
| `LITELLM_API_KEY` | `/ecs/genai/litellm/master_key` |
| `MEILI_MASTER_KEY` | `/ecs/genai/meilisearch/MEILI_MASTER_KEY` |
| `OPENID_CLIENT_ID` | `/ecs/genai/cognito/idp/client_id` |
| `OPENID_CLIENT_SECRET` | `/ecs/genai/cognito/idp/client_secret` |
| `OPENID_SESSION_SECRET` | `/ecs/genai/cognito/idp/session_secret` |
| `FIRECRAWL_API_KEY` | `/ecs/genai/firecrawl/test_api_key` |

---

## Error Handling

### Error Response Format

```json
{
  "statusCode": 500,
  "headers": {
    "Content-Type": "application/json"
  },
  "body": "{\"error\":\"Internal Server Error\",\"message\":\"Server failed to start\"}"
}
```

### Common Errors

| Error | Cause | Resolution |
|-------|-------|------------|
| `Server failed to start within timeout` | LibreChat startup >30s | Increase memory (CPU), check VPC connectivity |
| `Failed to fetch config` | S3 permission denied | Verify IAM role has s3:GetObject for config bucket |
| `ECONNREFUSED` | LibreChat not listening | Check PORT env var, server logs |
| `Timeout after 900s` | Response took too long | Optimize query, consider chunking |

---

## Testing

### Local Testing with Docker

```bash
# Build container
docker build -t librechat-lambda-api:local .

# Test with Lambda RIE (Runtime Interface Emulator)
docker run -p 9000:8080 \
  -e AWS_ACCESS_KEY_ID=xxx \
  -e AWS_SECRET_ACCESS_KEY=xxx \
  -e DOMAIN_SERVER=http://localhost:3080 \
  librechat-lambda-api:local

# Invoke test
curl -XPOST "http://localhost:9000/2015-03-31/functions/function/invocations" \
  -d '{"httpMethod":"GET","path":"/api/health"}'
```

### Integration Testing

```bash
# After deployment, test non-streaming endpoint
curl "https://lambda-test.sandbox.data.apro.is/api/health"

# Test streaming endpoint
curl -N "https://lambda-test.sandbox.data.apro.is/api/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

---

## Performance Considerations

| Metric | Target | Notes |
|--------|--------|-------|
| Cold start time | <10s | Memory affects CPU allocation |
| Warm invocation latency | <100ms | Proxy overhead minimal |
| Streaming chunk latency | <50ms | Direct stream pass-through |
| Memory usage | <512MB | LibreChat baseline ~400MB |
| Max response time | 890s | Leave buffer for Lambda timeout |
