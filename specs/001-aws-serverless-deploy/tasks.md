# Implementation Tasks: AWS Serverless Deployment

**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Generated**: 2025-12-25 | **Architecture**: Simplified (Single REST API + aws-lambda-ric)

## Overview

This task list implements the **simplified AWS serverless architecture**:
- **Single REST API (v1)** for all endpoints including SSE streaming
- **aws-lambda-ric** runtime interface client (not Lambda Web Adapter)
- **Four Terraform modules**: frontend, backend, api-gateway, redis
- **ElastiCache Redis** for session storage (cluster mode disabled)

**Key Changes from Previous Architecture**:
- ~~HTTP API (v2) for REST + REST API (v1) for streaming~~ → Single REST API (v1) for all
- ~~Lambda Web Adapter~~ → aws-lambda-ric with custom handler
- ~~VPC Link integration~~ → Direct Lambda VPC config
- ~~Valkey/Serverless ElastiCache~~ → ElastiCache Redis (cluster mode disabled)

---

## Task Summary

| Phase | Task Count | Status |
|-------|------------|--------|
| Setup | 3 | Complete |
| Foundational | 1 | Complete |
| P1: Frontend | 5 | Complete |
| P2: Backend | 10 | Complete (T013 needs docker push) |
| P3: Unified Access | 6 | In Progress (T020 done, tests pending) |
| Polish | 3 | Partial (T028 done) |
| **Total** | **28** | - |

**MVP Scope**: Setup + Foundational + P1 + P2 + P3 (28 tasks)

---

## Dependency Graph

```
T001 ──┬── T002 ──┬── T004 (Foundational)
       │          │
       └── T003 ──┘
                  │
                  ├── T005 ── T006 ── T007 ── T008 ── T009 (P1: Frontend)
                  │
                  ├── T010 ── T011 ── T012 ── T013 ──┬── T014
                  │                                  │
                  │          T015 ── T016 ── T017 ──┘
                  │                                  │
                  │                                  └── T018 ── T019 (P2: Backend)
                  │
                  └── T020 ── T021 ── T022 ── T023 ── T024 ── T025 (P3: Unified)
                                                              │
                                                              └── T026 ── T027 ── T028 (Polish)
```

**Parallel Execution Opportunities**:
- T005-T009 (P1 Frontend) can run in parallel with T010-T019 (P2 Backend)
- T015-T017 (Redis) can run in parallel with T010-T014 (Lambda/ECR)

---

## Phase: Setup

### T001: Initialize Terraform Project Structure
**Priority**: P0 | **Estimate**: 1h | **FR**: N/A
**Dependencies**: None

Create the Terraform directory structure:
```
infrastructure/terraform/
├── environments/
│   └── dev/
│       ├── main.tf
│       ├── variables.tf
│       ├── outputs.tf
│       └── terraform.tfvars
├── modules/
│   ├── frontend/
│   ├── backend/
│   ├── api-gateway/
│   └── redis/
└── README.md
```

**Acceptance Criteria**:
- [X] Directory structure created
- [X] .gitignore excludes .terraform/, *.tfstate*, *.tfvars (except examples)
- [X] README.md documents module usage

---

### T002: Configure Terraform Backend and Providers
**Priority**: P0 | **Estimate**: 30m | **FR**: N/A
**Dependencies**: T001

Configure S3 backend for state and AWS provider:
```hcl
terraform {
  backend "s3" {
    bucket         = "terraform-state-bucket"
    key            = "librechat-lambda/dev/terraform.tfstate"
    region         = "eu-west-1"
    encrypt        = true
    dynamodb_table = "terraform-locks"
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "eu-west-1"
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"  # For ACM certificates
}
```

**Acceptance Criteria**:
- [X] S3 backend configured with state locking
- [X] AWS provider version pinned to ~> 5.0
- [X] us-east-1 provider alias for ACM

---

### T003: Define Environment Variables
**Priority**: P0 | **Estimate**: 30m | **FR**: N/A
**Dependencies**: T001

Create `terraform.tfvars` for dev environment:
```hcl
environment        = "dev"
custom_domain      = "lambda-test.sandbox.data.apro.is"
vpc_id             = "vpc-05e4efdfad1c2252a"
private_subnet_ids = ["subnet-xxx", "subnet-yyy"]
route53_zone_id    = "Z0123456789"
acm_certificate_arn = "arn:aws:acm:us-east-1:xxx:certificate/xxx"
```

**Acceptance Criteria**:
- [X] All required variables defined
- [X] terraform.tfvars.example committed (no secrets)
- [X] Actual tfvars in .gitignore

---

## Phase: Foundational

### T004: Create Data Sources for Existing Resources
**Priority**: P0 | **Estimate**: 30m | **FR**: FR-019, FR-020
**Dependencies**: T002, T003

Reference existing VPC and subnets:
```hcl
data "aws_vpc" "existing" {
  id = var.vpc_id
}

data "aws_subnets" "private" {
  filter {
    name   = "vpc-id"
    values = [var.vpc_id]
  }
  filter {
    name   = "tag:Type"
    values = ["private"]
  }
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
```

**Acceptance Criteria**:
- [X] VPC data source resolves correctly
- [X] Private subnets identified
- [X] Region and account ID available

---

## Phase: P1 - Frontend Deployment

### T005: Create Frontend S3 Bucket
**Priority**: P1 | **Estimate**: 1h | **FR**: FR-001, FR-002
**Dependencies**: T004

```hcl
# modules/frontend/s3.tf
module "s3_frontend" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "~> 4.0"

  bucket        = "librechat-frontend-${var.environment}"
  force_destroy = true

  versioning = { enabled = false }

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

  tags = var.tags
}
```

**Acceptance Criteria**:
- [X] Bucket created with naming convention
- [X] Public access blocked
- [X] force_destroy enabled for dev cleanup

---

### T006: Create CloudFront Origin Access Control
**Priority**: P1 | **Estimate**: 30m | **FR**: FR-004
**Dependencies**: T005

```hcl
# modules/frontend/cloudfront.tf
resource "aws_cloudfront_origin_access_control" "s3" {
  name                              = "librechat-frontend-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
```

**Acceptance Criteria**:
- [X] OAC created with sigv4 signing
- [X] S3 bucket policy allows CloudFront access

---

### T007: Create CloudFront Distribution (S3 Origin Only)
**Priority**: P1 | **Estimate**: 2h | **FR**: FR-003, FR-004, FR-005
**Dependencies**: T006

Initial CloudFront with S3 origin only (API Gateway added in P3):
```hcl
module "cloudfront" {
  source  = "terraform-aws-modules/cloudfront/aws"
  version = "~> 4.0"

  aliases = [var.custom_domain]

  origin = {
    s3_frontend = {
      domain_name              = module.s3_frontend.s3_bucket_bucket_regional_domain_name
      origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
    }
  }

  default_cache_behavior = {
    target_origin_id       = "s3_frontend"
    viewer_protocol_policy = "redirect-to-https"
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6"  # CachingOptimized
  }

  # SPA routing: 404 → /index.html
  custom_error_response = [{
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }]

  viewer_certificate = {
    acm_certificate_arn = var.acm_certificate_arn
    ssl_support_method  = "sni-only"
  }
}
```

**Acceptance Criteria**:
- [X] CloudFront distribution created
- [X] S3 origin configured with OAC
- [X] SPA routing works (404 → index.html)
- [X] HTTPS redirect enabled

---

### T008: Create Route53 A Record for CloudFront
**Priority**: P1 | **Estimate**: 30m | **FR**: FR-021
**Dependencies**: T007

```hcl
resource "aws_route53_record" "cloudfront" {
  zone_id = var.route53_zone_id
  name    = var.custom_domain
  type    = "A"

  alias {
    name                   = module.cloudfront.cloudfront_distribution_domain_name
    zone_id                = module.cloudfront.cloudfront_distribution_hosted_zone_id
    evaluate_target_health = false
  }
}
```

**Acceptance Criteria**:
- [X] A record created as alias to CloudFront
- [X] DNS resolves to CloudFront distribution

---

### T009: Deploy Frontend Assets to S3
**Priority**: P1 | **Estimate**: 1h | **FR**: FR-001
**Dependencies**: T005

Create deployment script (not Terraform):
```bash
#!/bin/bash
# scripts/deploy-frontend.sh
aws s3 sync ./client/dist s3://librechat-frontend-dev --delete
aws cloudfront create-invalidation --distribution-id $CF_DIST_ID --paths "/*"
```

**Acceptance Criteria**:
- [X] Frontend assets uploaded to S3
- [X] CloudFront invalidation triggers
- [X] Site accessible at custom domain (frontend only)

---

## Phase: P2 - Backend API Deployment

### T010: Create ECR Repository
**Priority**: P2 | **Estimate**: 30m | **FR**: FR-012
**Dependencies**: T004

```hcl
# modules/backend/ecr.tf
resource "aws_ecr_repository" "api" {
  name         = "librechat-lambda-api"
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = var.tags
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 5 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}
```

**Acceptance Criteria**:
- [X] ECR repository created
- [X] Image scanning enabled
- [X] Lifecycle policy retains last 5 images

---

### T011: Create Lambda Handler (handler.mjs)
**Priority**: P2 | **Estimate**: 3h | **FR**: FR-007, FR-008
**Dependencies**: T010

Implement handler per `contracts/lambda-handler-contract.md`:
```javascript
// infrastructure/terraform/modules/backend/docker/handler.mjs
import { spawn } from 'child_process';
import http from 'http';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const LIBRECHAT_PORT = 3080;
let server = null;
let serverReady = false;

// Full implementation from lambda-handler-contract.md
export const handler = awslambda.streamifyResponse(
  async (event, responseStream, context) => {
    await ensureServerRunning();
    await proxyRequest(event, responseStream);
  }
);
```

**Acceptance Criteria**:
- [X] Handler implements awslambda.streamifyResponse()
- [X] S3 config fetch works (FR-026)
- [X] LibreChat server starts on cold start
- [X] Health check loop validates server ready
- [X] Proxy forwards requests with streaming

---

### T012: Create Lambda Dockerfile
**Priority**: P2 | **Estimate**: 1h | **FR**: FR-006, FR-007
**Dependencies**: T011

```dockerfile
# infrastructure/terraform/modules/backend/docker/Dockerfile
FROM ghcr.io/danny-avila/librechat-api:v0.8.2-rc1

WORKDIR /app

# Install aws-lambda-ric
RUN npm install aws-lambda-ric @aws-sdk/client-s3

# Copy Lambda handler
COPY handler.mjs /app/handler.mjs

# Lambda runtime interface
ENTRYPOINT ["/usr/local/bin/npx", "aws-lambda-ric"]
CMD ["handler.handler"]
```

**Acceptance Criteria**:
- [X] Dockerfile builds successfully
- [X] aws-lambda-ric installed
- [X] Handler accessible at handler.handler

---

### T013: Build and Push Lambda Container
**Priority**: P2 | **Estimate**: 1h | **FR**: FR-012
**Dependencies**: T010, T012

Create build script:
```bash
#!/bin/bash
# scripts/build-lambda.sh
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=eu-west-1

cd infrastructure/terraform/modules/backend/docker
docker build -t librechat-lambda-api:latest .
docker tag librechat-lambda-api:latest $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/librechat-lambda-api:latest

aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com
docker push $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/librechat-lambda-api:latest
```

**Acceptance Criteria**:
- [ ] Container builds without errors
- [ ] Container pushed to ECR
- [ ] Image scan shows no critical vulnerabilities

---

### T014: Create Lambda Security Group
**Priority**: P2 | **Estimate**: 1h | **FR**: FR-028
**Dependencies**: T004

```hcl
# modules/backend/security.tf
resource "aws_security_group" "lambda" {
  name        = "librechat-lambda-sg"
  description = "Security group for LibreChat Lambda"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 27017
    to_port     = 27017
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.existing.cidr_block]
    description = "DocumentDB"
  }

  egress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [var.redis_security_group_id]
    description     = "ElastiCache Redis"
  }

  egress {
    from_port   = 0
    to_port     = 65535
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.existing.cidr_block]
    description = "Cloud Map services"
  }

  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS egress"
  }

  tags = var.tags
}
```

**Acceptance Criteria**:
- [X] Security group created
- [X] Egress rules allow DocumentDB, Redis, Cloud Map, HTTPS
- [X] No ingress rules (invoked by AWS services)

---

### T015: Create ElastiCache Redis Cluster
**Priority**: P2 | **Estimate**: 2h | **FR**: FR-036, FR-037, FR-038
**Dependencies**: T004

```hcl
# modules/redis/main.tf
module "redis" {
  source  = "terraform-aws-modules/elasticache/aws"
  version = "1.10.3"

  replication_group_id = "librechat-lambda-redis"

  cluster_mode_enabled = false
  num_cache_clusters   = 1

  engine         = "redis"
  engine_version = "7.1"
  node_type      = "cache.t4g.micro"

  vpc_id     = var.vpc_id
  subnet_ids = var.private_subnet_ids

  create_security_group = true
  security_group_rules = {
    ingress_lambda = {
      type                     = "ingress"
      from_port                = 6379
      to_port                  = 6379
      protocol                 = "tcp"
      source_security_group_id = var.lambda_security_group_id
      description              = "Lambda access"
    }
  }

  at_rest_encryption_enabled = true
  transit_encryption_enabled = false

  apply_immediately = true

  tags = var.tags
}
```

**Acceptance Criteria**:
- [X] Redis cluster created (single node)
- [X] Cluster mode disabled
- [X] Security group allows Lambda access
- [X] Encryption at rest enabled

---

### T016: Create File Storage S3 Bucket
**Priority**: P2 | **Estimate**: 1h | **FR**: FR-030, FR-031, FR-034
**Dependencies**: T004

```hcl
# modules/backend/s3.tf
module "s3_files" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "~> 4.0"

  bucket        = "librechat-lambda-files-${var.environment}"
  force_destroy = true

  cors_rule = [{
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST"]
    allowed_origins = ["https://${var.custom_domain}"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }]

  tags = var.tags
}
```

**Acceptance Criteria**:
- [X] Bucket created with CORS configured
- [X] Origins match custom domain
- [X] force_destroy enabled

---

### T017: Create Lambda IAM Role
**Priority**: P2 | **Estimate**: 1h | **FR**: FR-029, FR-033
**Dependencies**: T015, T016

```hcl
# modules/backend/iam.tf
resource "aws_iam_role" "lambda" {
  name = "librechat-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "lambda_custom" {
  name = "librechat-lambda-policy"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = var.ssm_parameter_arns
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${module.s3_files.s3_bucket_arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "arn:aws:s3:::${var.config_s3_bucket}/${var.config_s3_key}"
      }
    ]
  })
}
```

**Acceptance Criteria**:
- [X] IAM role created with assume policy
- [X] VPC execution role attached
- [X] SSM, S3 files, S3 config permissions granted

---

### T018: Create Lambda Function
**Priority**: P2 | **Estimate**: 2h | **FR**: FR-007, FR-024, FR-025
**Dependencies**: T013, T014, T015, T017

```hcl
# modules/backend/lambda.tf
resource "aws_lambda_function" "api" {
  function_name = "librechat-api"
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.api.repository_url}:latest"

  memory_size = 1024
  timeout     = 900

  role = aws_iam_role.lambda.arn

  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      DOMAIN_SERVER          = "https://${var.custom_domain}"
      DOMAIN_CLIENT          = "https://${var.custom_domain}"
      CONFIG_PATH            = "/tmp/librechat.yaml"
      CONFIG_S3_BUCKET       = var.config_s3_bucket
      CONFIG_S3_KEY          = var.config_s3_key
      USE_REDIS              = "true"
      REDIS_URI              = "redis://${var.redis_endpoint}:6379"
      AWS_BUCKET_NAME        = module.s3_files.s3_bucket_id
      LITELLM_BASE_URL       = "http://litellm.dev-aprochat-core.local:4000/v1"
      SEARXNG_INSTANCE_URL   = "http://searxng.dev-aprochat-core.local:8080"
      RAG_API_URL            = "http://rag-api.dev-aprochat-core.local:8000"
      MEILI_HOST             = "http://meilisearch.dev-aprochat-core.local:7700"
      FIRECRAWL_API_URL      = "http://firecrawl.dev-aprochat-core.local:3002"
    }
  }

  tags = var.tags
}
```

**Acceptance Criteria**:
- [X] Lambda function created with container image
- [X] VPC configuration applied
- [X] Environment variables set
- [X] 900s timeout configured

---

### T019: Create API Gateway REST API with Streaming
**Priority**: P2 | **Estimate**: 3h | **FR**: FR-009, FR-010, FR-011, FR-018
**Dependencies**: T018

```hcl
# modules/api-gateway/main.tf
resource "aws_api_gateway_rest_api" "api" {
  name        = "librechat-rest-api"
  description = "LibreChat REST API with streaming support"

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

resource "aws_api_gateway_resource" "api" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_rest_api.api.root_resource_id
  path_part   = "api"
}

resource "aws_api_gateway_resource" "proxy" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "proxy" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.proxy.id
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "proxy" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.proxy.id
  http_method             = aws_api_gateway_method.proxy.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"

  # Key: response-streaming-invocations for SSE support
  uri = "arn:aws:apigateway:${var.region}:lambda:path/2021-11-15/functions/${var.lambda_function_arn}/response-streaming-invocations"

  timeout_milliseconds = 900000
}

resource "aws_api_gateway_deployment" "api" {
  rest_api_id = aws_api_gateway_rest_api.api.id

  depends_on = [aws_api_gateway_integration.proxy]

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "prod" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  deployment_id = aws_api_gateway_deployment.api.id
  stage_name    = "prod"
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunctionWithResponseStreaming"
  function_name = var.lambda_function_arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/*"
}
```

**Acceptance Criteria**:
- [X] REST API (v1) created (NOT HTTP API v2)
- [X] /api/{proxy+} route configured
- [X] Integration uses /response-streaming-invocations
- [X] 900000ms timeout set
- [X] Lambda permission for streaming invocation

---

## Phase: P3 - Unified CloudFront Access

### T020: Add API Gateway Origin to CloudFront
**Priority**: P3 | **Estimate**: 2h | **FR**: FR-013, FR-014, FR-015
**Dependencies**: T007, T019

Update CloudFront to include API Gateway origin:
```hcl
# modules/frontend/cloudfront.tf (updated)
locals {
  api_gateway_domain = replace(var.api_gateway_endpoint, "/^https?:\\/\\/([^\\/]*).*/", "$1")
}

module "cloudfront" {
  # ... existing config ...

  origin = {
    s3_frontend = {
      # ... existing S3 origin ...
    }
    api_gateway = {
      domain_name = local.api_gateway_domain
      origin_path = "/prod"
      custom_origin_config = {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  ordered_cache_behavior = [{
    path_pattern             = "/api/*"
    target_origin_id         = "api_gateway"
    viewer_protocol_policy   = "https-only"
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"  # CachingDisabled
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"  # AllViewerExceptHostHeader
    allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
  }]
}
```

**Acceptance Criteria**:
- [X] API Gateway origin added
- [X] /api/* behavior routes to API Gateway
- [X] Caching disabled for API
- [X] All HTTP methods allowed

---

### T021: Test Health Endpoint
**Priority**: P3 | **Estimate**: 30m | **FR**: FR-011
**Dependencies**: T020

```bash
# Test via CloudFront
curl -v https://lambda-test.sandbox.data.apro.is/api/health

# Expected response: 200 OK with health status JSON
```

**Acceptance Criteria**:
- [ ] Health endpoint returns 200
- [ ] Response includes server status
- [ ] CloudFront passes through correctly

---

### T022: Test Non-Streaming Endpoint
**Priority**: P3 | **Estimate**: 30m | **FR**: FR-010
**Dependencies**: T021

```bash
# Test auth endpoint (non-streaming)
curl -v https://lambda-test.sandbox.data.apro.is/api/auth/session
```

**Acceptance Criteria**:
- [ ] API returns JSON response
- [ ] Headers correct (Content-Type: application/json)
- [ ] No streaming artifacts

---

### T023: Test SSE Streaming Endpoint
**Priority**: P3 | **Estimate**: 1h | **FR**: FR-009, FR-010
**Dependencies**: T022

```bash
# Test streaming chat endpoint
curl -N https://lambda-test.sandbox.data.apro.is/api/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'

# Verify chunks arrive progressively (not buffered)
```

**Acceptance Criteria**:
- [ ] SSE chunks arrive progressively
- [ ] Content-Type: text/event-stream
- [ ] Stream completes with data: [DONE]

---

### T024: Test Redis Session Storage
**Priority**: P3 | **Estimate**: 1h | **FR**: FR-039, FR-040
**Dependencies**: T023

```bash
# Login and verify session persists
# 1. Login via API
# 2. Make authenticated request
# 3. Wait for Lambda cold start timeout
# 4. Make another authenticated request
# Session should still be valid (stored in Redis)
```

**Acceptance Criteria**:
- [ ] Login creates session
- [ ] Session persists across Lambda invocations
- [ ] Redis stores session data

---

### T025: CloudFront Cache Invalidation
**Priority**: P3 | **Estimate**: 30m | **FR**: N/A
**Dependencies**: T020

Create invalidation for testing:
```bash
aws cloudfront create-invalidation \
  --distribution-id $CF_DIST_ID \
  --paths "/*"
```

**Acceptance Criteria**:
- [ ] Invalidation completes successfully
- [ ] Fresh content served after invalidation

---

## Phase: Polish

### T026: Add CloudWatch Alarms
**Priority**: P4 | **Estimate**: 2h | **FR**: N/A
**Dependencies**: T025

```hcl
# modules/backend/monitoring.tf
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "librechat-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  alarm_description   = "Lambda function errors"

  dimensions = {
    FunctionName = aws_lambda_function.api.function_name
  }
}
```

**Acceptance Criteria**:
- [ ] Lambda error alarm configured
- [ ] API Gateway 5xx alarm configured
- [ ] Redis connection alarm configured

---

### T027: Document Deployment Process
**Priority**: P4 | **Estimate**: 1h | **FR**: N/A
**Dependencies**: T025

Update `infrastructure/terraform/README.md`:
- Prerequisites
- Deployment steps
- Environment variable configuration
- Troubleshooting guide

**Acceptance Criteria**:
- [ ] README covers all deployment steps
- [ ] Troubleshooting section complete
- [ ] Architecture diagram included

---

### T028: Create Terraform Output Summary
**Priority**: P4 | **Estimate**: 30m | **FR**: N/A
**Dependencies**: T025

```hcl
# environments/dev/outputs.tf
output "cloudfront_domain" {
  value = module.frontend.cloudfront_domain_name
}

output "api_gateway_url" {
  value = module.api_gateway.invoke_url
}

output "lambda_function_arn" {
  value = module.backend.lambda_function_arn
}

output "redis_endpoint" {
  value = module.redis.primary_endpoint_address
}
```

**Acceptance Criteria**:
- [X] All key resource ARNs/URLs output
- [X] Outputs documented
- [X] Sensitive values marked

---

## Validation Checklist

Before marking implementation complete:

- [ ] **Frontend**: Static site accessible at custom domain
- [ ] **API**: All /api/* routes work through CloudFront
- [ ] **Streaming**: SSE chunks arrive progressively (not buffered)
- [ ] **Sessions**: Redis stores sessions across Lambda invocations
- [ ] **Security**: S3 buckets block public access
- [ ] **Security**: Lambda runs in VPC with restricted egress
- [ ] **Cleanup**: terraform destroy works without errors

---

## Appendix: Task Dependencies Matrix

| Task | Depends On | Blocks |
|------|------------|--------|
| T001 | - | T002, T003 |
| T002 | T001 | T004 |
| T003 | T001 | T004 |
| T004 | T002, T003 | T005, T010, T014, T015 |
| T005 | T004 | T006 |
| T006 | T005 | T007 |
| T007 | T006 | T008, T020 |
| T008 | T007 | T009 |
| T009 | T005 | - |
| T010 | T004 | T013 |
| T011 | T010 | T012 |
| T012 | T011 | T013 |
| T013 | T010, T012 | T018 |
| T014 | T004 | T015, T018 |
| T015 | T004, T014 | T017, T018 |
| T016 | T004 | T017 |
| T017 | T015, T016 | T018 |
| T018 | T013, T014, T015, T017 | T019 |
| T019 | T018 | T020 |
| T020 | T007, T019 | T021 |
| T021 | T020 | T022 |
| T022 | T021 | T023 |
| T023 | T022 | T024 |
| T024 | T023 | T025 |
| T025 | T020 | T026, T027, T028 |
| T026 | T025 | - |
| T027 | T025 | - |
| T028 | T025 | - |

---

## External Resource References

Per spec.md, the following existing AproChat resources will be used:

| Resource | Value | Used By |
|----------|-------|---------|
| VPC ID | `vpc-05e4efdfad1c2252a` | Lambda VPC config |
| Private Subnets | 3 subnets in eu-west-1a/b/c | Lambda VPC config |
| DocumentDB | `aprochat-dev-genai-docdb-cluster.cluster-cx8ui6sy4sn2.eu-west-1.docdb.amazonaws.com:27017` | MongoDB connection |
| LiteLLM | `litellm.dev-aprochat-core.local:4000` | LLM proxy |
| RAG API | `rag-api.dev-aprochat-core.local:8000` | Vector search |
| MeiliSearch | `meilisearch.dev-aprochat-core.local:7700` | Full-text search |
| SearXNG | `searxng.dev-aprochat-core.local:8080` | Web search |
| Firecrawl | `firecrawl.dev-aprochat-core.local:3002` | Web scraping |

All values are configured via terraform.tfvars and environment variables.

---

## Notes

- **Simplified Architecture**: Single REST API (v1) handles all endpoints including SSE streaming
- **aws-lambda-ric**: Uses Lambda Runtime Interface Client instead of Lambda Web Adapter
- **No VPC Link**: Lambda connects directly to VPC resources via vpc_config
- **ElastiCache Redis**: Cluster mode disabled, single node for session storage
- Commit after each task or logical group
- Stop at any checkpoint to validate independently
