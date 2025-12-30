# Data Model: AWS Serverless Infrastructure Resources (Simplified)

**Branch**: `001-aws-serverless-deploy` | **Date**: 2025-12-25
**Status**: Updated - Simplified architecture

## Overview

This document defines the AWS resources for the **simplified** serverless deployment architecture. Key changes from previous version:
- Single Lambda function (not separate api/stream functions)
- Single REST API (v1) for all endpoints including streaming
- aws-lambda-ric instead of Lambda Web Adapter
- ElastiCache Redis for session storage

---

## Resource Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DNS / Edge                                      │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐       │
│  │ Route 53        │────▶│ ACM Cert        │────▶│ CloudFront      │       │
│  │ (A Alias)       │     │ (us-east-1)     │     │ (CDN)           │       │
│  └─────────────────┘     └─────────────────┘     └────────┬────────┘       │
└───────────────────────────────────────────────────────────┼─────────────────┘
                                                            │
┌───────────────────────────────────────────────────────────┼─────────────────┐
│                              Origins                      │                  │
│                    ┌──────────────────────────────────────┼───────────┐     │
│                    │                                      │           │     │
│                    ▼                                      ▼           │     │
│  ┌─────────────────────────────────┐  ┌─────────────────────────────┐│     │
│  │ S3 Bucket                       │  │ API Gateway REST API (v1)  ││     │
│  │ (Frontend - /* default)         │  │ (/api/* - all endpoints)   ││     │
│  │ - OAC access only               │  │ - Streaming support        ││     │
│  │ - No versioning                 │  │ - $default stage only      ││     │
│  └─────────────────────────────────┘  └──────────────┬──────────────┘│     │
└──────────────────────────────────────────────────────┼───────────────┘     │
                                                       │                      │
┌──────────────────────────────────────────────────────┼──────────────────────┐
│                              Compute                 │                       │
│                                                      ▼                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                         Lambda Function                                 ││
│  │  ┌────────────────────────────────────────────────────────────────┐    ││
│  │  │ librechat-api (Container Image)                                │    ││
│  │  │ - Base: ghcr.io/danny-avila/librechat-api:v0.8.2-rc1          │    ││
│  │  │ - Runtime: aws-lambda-ric                                      │    ││
│  │  │ - Memory: 1024 MB                                              │    ││
│  │  │ - Timeout: 900s (streaming)                                    │    ││
│  │  │ - VPC: Private subnets                                         │    ││
│  │  └────────────────────────────────────────────────────────────────┘    ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
┌──────────────────────────────────────┼──────────────────────────────────────┐
│                              VPC (Existing)                                  │
│  ┌───────────────────────────────────┴───────────────────────────────────┐  │
│  │                         Private Subnets                               │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐       │  │
│  │  │ ElastiCache     │  │ DocumentDB      │  │ Cloud Map DNS   │       │  │
│  │  │ (Redis 7.1)     │  │ (MongoDB)       │  │ (.local)        │       │  │
│  │  │ - Session store │  │ - Existing      │  │ - litellm       │       │  │
│  │  │ - Single node   │  │                 │  │ - searxng       │       │  │
│  │  └─────────────────┘  └─────────────────┘  │ - rag-api       │       │  │
│  │                                            │ - meilisearch   │       │  │
│  │                                            │ - firecrawl     │       │  │
│  │                                            └─────────────────┘       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Resource Definitions

### 1. CloudFront Distribution (terraform-aws-modules/cloudfront/aws)

**Purpose**: CDN for unified routing to S3 frontend and API Gateway backend

| Attribute | Type | Required | Description |
|-----------|------|----------|-------------|
| aliases | list[string] | yes | Custom domain: `lambda-test.sandbox.data.apro.is` |
| acm_certificate_arn | string | yes | Wildcard cert for `*.sandbox.data.apro.is` |
| default_cache_behavior | object | yes | S3 origin for frontend |
| ordered_cache_behavior | list | yes | API Gateway origin for `/api/*` |
| origin_access_control | object | yes | OAC for S3 access |

**Origins**:
- `s3_frontend`: S3 bucket with OAC (default behavior)
- `api_gateway`: REST API endpoint (`/api/*` behavior)

**Cache Policies**:
- Frontend: `CachingOptimized` (658327ea-f89d-4fab-a63d-7e88639e58f6)
- API: `CachingDisabled` (4135ea2d-6df8-44a3-9df3-4b5a84be39ad)

---

### 2. S3 Bucket - Frontend (terraform-aws-modules/s3-bucket/aws)

**Purpose**: Static file hosting for React frontend

| Attribute | Type | Required | Description |
|-----------|------|----------|-------------|
| bucket | string | yes | `librechat-frontend-{env}` |
| versioning.enabled | boolean | yes | `false` (FR-002) |
| force_destroy | boolean | yes | `true` (FR-002) |
| block_public_* | boolean | yes | All `true` (OAC only) |

---

### 3. S3 Bucket - File Storage (terraform-aws-modules/s3-bucket/aws)

**Purpose**: User file uploads storage

| Attribute | Type | Required | Description |
|-----------|------|----------|-------------|
| bucket | string | yes | `librechat-lambda-files-{env}` |
| force_destroy | boolean | yes | `true` (FR-031) |
| cors_rule | list | yes | Allow uploads from custom domain |

**CORS Configuration**:
```hcl
cors_rule = [{
  allowed_headers = ["*"]
  allowed_methods = ["GET", "PUT", "POST"]
  allowed_origins = ["https://lambda-test.sandbox.data.apro.is"]
  expose_headers  = ["ETag"]
  max_age_seconds = 3600
}]
```

---

### 4. API Gateway REST API (Native aws_api_gateway_*)

**Purpose**: Lambda proxy with SSE streaming support

| Attribute | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | yes | `librechat-rest-api` |
| endpoint_configuration | object | yes | `REGIONAL` |

**Integration Configuration** (Streaming):
| Attribute | Value | Notes |
|-----------|-------|-------|
| type | `AWS_PROXY` | Lambda proxy integration |
| integration_http_method | `POST` | Required for Lambda |
| uri | `.../response-streaming-invocations` | Streaming suffix |
| timeout_milliseconds | `900000` | 15 minutes max |

**Routes**:
- `ANY /api/{proxy+}` → Lambda (all API endpoints)
- `OPTIONS /api/{proxy+}` → MOCK (CORS preflight)

---

### 5. Lambda Function (Native aws_lambda_function)

**Purpose**: Containerized LibreChat API with streaming support

| Attribute | Type | Required | Value |
|-----------|------|----------|-------|
| function_name | string | yes | `librechat-api` |
| package_type | string | yes | `Image` |
| image_uri | string | yes | ECR image URI |
| memory_size | number | yes | `1024` |
| timeout | number | yes | `900` |
| vpc_config | object | yes | Private subnets + security group |

**Environment Variables**:
| Name | Value | Source |
|------|-------|--------|
| DOMAIN_SERVER | `https://lambda-test.sandbox.data.apro.is` | FR-024 |
| DOMAIN_CLIENT | `https://lambda-test.sandbox.data.apro.is` | FR-024 |
| CONFIG_PATH | `/tmp/librechat.yaml` | FR-026 |
| USE_REDIS | `true` | FR-039 |
| REDIS_URI | `redis://{elasticache}:6379` | FR-039 |
| AWS_BUCKET_NAME | `librechat-lambda-files-{env}` | FR-032 |
| AWS_REGION | `eu-west-1` | FR-032 |
| LITELLM_BASE_URL | `http://litellm.dev-aprochat-core.local:4000/v1` | Cloud Map |
| SEARXNG_INSTANCE_URL | `http://searxng.dev-aprochat-core.local:8080` | Cloud Map |
| RAG_API_URL | `http://rag-api.dev-aprochat-core.local:8000` | Cloud Map |
| MEILI_HOST | `http://meilisearch.dev-aprochat-core.local:7700` | Cloud Map |
| FIRECRAWL_API_URL | `http://firecrawl.dev-aprochat-core.local:3002` | Cloud Map |

**Secrets (from SSM)**:
| Name | SSM Parameter |
|------|---------------|
| CREDS_IV | `/ecs/genai/librechat/CREDS_IV` |
| CREDS_KEY | `/ecs/genai/librechat/CREDS_KEY` |
| JWT_SECRET | `/ecs/genai/librechat/JWT_SECRET` |
| JWT_REFRESH_SECRET | `/ecs/genai/librechat/JWT_REFRESH_SECRET` |
| MONGO_URI | `/ecs/genai/mongo/DB_URI` |
| LITELLM_API_KEY | `/ecs/genai/litellm/master_key` |
| MEILI_MASTER_KEY | `/ecs/genai/meilisearch/MEILI_MASTER_KEY` |
| OPENID_CLIENT_ID | `/ecs/genai/cognito/idp/client_id` |
| OPENID_CLIENT_SECRET | `/ecs/genai/cognito/idp/client_secret` |
| OPENID_SESSION_SECRET | `/ecs/genai/cognito/idp/session_secret` |
| FIRECRAWL_API_KEY | `/ecs/genai/firecrawl/test_api_key` |

---

### 6. ECR Repository (Native aws_ecr_repository)

**Purpose**: Container image storage for Lambda

| Attribute | Type | Required | Value |
|-----------|------|----------|-------|
| name | string | yes | `librechat-lambda-api` |
| force_delete | boolean | yes | `true` (FR-012) |
| image_scanning_configuration | object | yes | `scan_on_push = true` |

---

### 7. ElastiCache Redis (terraform-aws-modules/elasticache/aws v1.10.3)

**Purpose**: Session storage for Lambda (no in-memory state)

| Attribute | Type | Required | Value |
|-----------|------|----------|-------|
| replication_group_id | string | yes | `librechat-lambda-redis` |
| cluster_mode_enabled | boolean | yes | `false` (FR-037) |
| num_cache_clusters | number | yes | `1` (FR-037) |
| engine | string | yes | `redis` |
| engine_version | string | yes | `7.1` |
| node_type | string | yes | `cache.t4g.micro` |
| at_rest_encryption_enabled | boolean | yes | `true` |
| transit_encryption_enabled | boolean | yes | `false` |

**Security Group Rules**:
```hcl
security_group_rules = {
  ingress_lambda = {
    type                     = "ingress"
    from_port                = 6379
    to_port                  = 6379
    protocol                 = "tcp"
    source_security_group_id = aws_security_group.lambda.id
    description              = "Lambda access"
  }
}
```

---

### 8. Security Groups

**Lambda Security Group**:
```yaml
Ingress: []  # No inbound (invoked by AWS services)
Egress:
  - Protocol: tcp
    Port: 27017
    Destination: VPC CIDR  # DocumentDB
  - Protocol: tcp
    Port: 6379
    Destination: Redis SG  # ElastiCache
  - Protocol: tcp
    Port: 0-65535
    Destination: VPC CIDR  # Cloud Map services
  - Protocol: tcp
    Port: 443
    Destination: 0.0.0.0/0  # External APIs (via NAT)
```

**Redis Security Group**:
```yaml
Ingress:
  - Protocol: tcp
    Port: 6379
    Source: Lambda Security Group
Egress: []
```

---

### 9. IAM Roles and Policies

**Lambda Execution Role**:
```yaml
AssumeRolePolicyDocument:
  Service: lambda.amazonaws.com

ManagedPolicies:
  - AWSLambdaVPCAccessExecutionRole
  - AWSLambdaBasicExecutionRole

InlinePolicy:
  # SSM Parameter Store access
  - Effect: Allow
    Action:
      - ssm:GetParameter
      - ssm:GetParameters
    Resource:
      - arn:aws:ssm:eu-west-1:*:parameter/ecs/genai/*

  # S3 file storage access (FR-033)
  - Effect: Allow
    Action:
      - s3:PutObject
      - s3:GetObject
      - s3:DeleteObject
    Resource:
      - arn:aws:s3:::librechat-lambda-files-*/*

  # S3 config bucket access (FR-029)
  - Effect: Allow
    Action:
      - s3:GetObject
    Resource:
      - arn:aws:s3:::genai-shared-config/lambda-test/*
```

---

### 10. Route53 A Record

**Purpose**: Custom domain DNS pointing to CloudFront

| Attribute | Type | Required | Value |
|-----------|------|----------|-------|
| name | string | yes | `lambda-test.sandbox.data.apro.is` |
| type | string | yes | `A` |
| alias.name | string | yes | CloudFront distribution domain |
| alias.zone_id | string | yes | CloudFront hosted zone ID |

---

## State Transitions

### Lambda Function Lifecycle

```
┌──────────────┐
│    COLD      │ No execution environment
└──────┬───────┘
       │ invocation
       ▼
┌──────────────┐
│ INITIALIZING │ Loading container, fetching config from S3
└──────┬───────┘
       │ init complete (LibreChat API ready on localhost:3080)
       ▼
┌──────────────┐
│    WARM      │ Ready to handle requests
└──────┬───────┘
       │ idle timeout (~15 min)
       ▼
┌──────────────┐
│    COLD      │ Environment terminated
└──────────────┘
```

### Streaming Request Flow

```
CloudFront → API Gateway REST API → Lambda (InvokeWithResponseStream)
                                         │
                                         ▼
                               ┌──────────────────┐
                               │ Lambda Handler   │
                               │ (streamifyResponse)
                               └────────┬─────────┘
                                        │
                                        ▼
                               ┌──────────────────┐
                               │ LibreChat API    │
                               │ (localhost:3080) │
                               └────────┬─────────┘
                                        │ SSE chunks
                                        ▼
                               ┌──────────────────┐
                               │ responseStream   │
                               │ .write(chunk)    │
                               └──────────────────┘
```

---

## Validation Rules

### CloudFront
- HTTPS only (redirect HTTP)
- TLSv1.2 minimum
- API caching disabled
- SPA routing via custom error responses (404 → index.html)

### Lambda
- Memory ≥ 1024 MB
- Timeout = 900 seconds for streaming
- VPC subnets in multiple AZs
- Security group allows egress to all VPC services

### API Gateway
- REST API (v1) required for streaming
- Integration URI uses `/response-streaming-invocations` suffix
- Timeout up to 900,000ms for streaming mode

### ElastiCache
- Cluster mode disabled (single node)
- Same VPC as Lambda
- Security group allows Lambda ingress

### S3
- Block all public access
- No versioning (frontend bucket)
- force_destroy enabled for cleanup
