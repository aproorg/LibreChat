# Phase 0 Research: AWS Serverless Deployment (Simplified)

**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2025-12-25
**Status**: Updated - Simplified architecture

## Executive Summary

This research validates the technical approach for deploying LibreChat as an AWS serverless application using a **simplified architecture**. Key findings confirm:

1. **API Gateway REST API (v1)** with Lambda proxy integration supports SSE streaming via `InvokeWithResponseStream`
2. **terraform-aws-modules** provides well-documented modules for CloudFront, S3, and ElastiCache
3. **aws-lambda-ric** (Runtime Interface Client) is the standard pattern for containerized Lambda functions
4. **Single REST API** handles all endpoints (both standard and streaming) with path-based routing

**Recommendation**: **GO** - Proceed with simplified implementation using 4 Terraform modules under 500 lines.

---

## 1. API Gateway REST API Streaming

### 1.1 Response Transfer Mode Configuration

**Source**: [AWS Terraform Provider - aws_api_gateway_integration](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_integration)

The `aws_api_gateway_integration` resource supports streaming via `response_transfer_mode`:

```hcl
resource "aws_api_gateway_integration" "streaming" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.streaming.id
  http_method             = aws_api_gateway_method.streaming.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"

  # Key configuration for streaming
  uri = "arn:aws:apigateway:${var.region}:lambda:path/2021-11-15/functions/${aws_lambda_function.api.arn}/response-streaming-invocations"

  # Up to 15 minutes for STREAM mode (vs 5 min for BUFFERED)
  timeout_milliseconds = 900000
}
```

**Key Findings**:
- `timeout_milliseconds`: Maximum 300,000ms (5 min) for `BUFFERED`, maximum 900,000ms (15 min) for `STREAM`
- Integration URI must use `/response-streaming-invocations` suffix instead of `/invocations`
- REST API (v1) required; HTTP API (v2) does NOT support streaming
- Lambda attribute `response_streaming_invoke_arn` provides the correct ARN

### 1.2 Lambda Response Format for Streaming

**Source**: [AWS API Gateway Developer Guide - Configure Lambda streaming](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-streaming-lambda-configure.html)

Lambda functions must use `awslambda.streamifyResponse()` decorator:

```javascript
// Using HttpResponseStream.from (recommended)
export const handler = awslambda.streamifyResponse(
  async (event, responseStream, context) => {
    const httpResponseMetadata = {
      statusCode: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache"
      }
    };

    responseStream = awslambda.HttpResponseStream.from(responseStream, httpResponseMetadata);

    // Stream SSE events
    responseStream.write("data: chunk1\n\n");
    await new Promise(r => setTimeout(r, 100));
    responseStream.write("data: chunk2\n\n");
    responseStream.end();
  }
);
```

**Alternative (manual delimiter)**:
```javascript
// Without HttpResponseStream - manual 8 null byte delimiter
response.write('{"statusCode": 200, "headers": {"Content-Type": "text/event-stream"}}');
response.write("\x00".repeat(8)); // 8 null bytes delimiter
response.write("data: chunk1\n\n");
response.end();
```

### 1.3 SSE Endpoint Routing

Per spec, streaming endpoints in LibreChat are:
- `/api/ask/*` - Ask endpoint (legacy)
- `/api/chat/*` - Chat completions
- `/api/agents/*` - Agent interactions

All other `/api/*` endpoints use standard buffered mode.

---

## 2. Lambda Container Configuration

### 2.1 aws-lambda-ric Pattern

**Source**: [AWS Lambda Runtime Interface Client](https://github.com/aws/aws-lambda-nodejs-runtime-interface-client)

The `aws-lambda-ric` (Runtime Interface Client) is the standard approach for containerized Lambda:

```dockerfile
FROM ghcr.io/danny-avila/librechat-api:v0.8.2-rc1

# Install aws-lambda-ric
RUN npm install aws-lambda-ric

# Create Lambda handler wrapper
COPY handler.mjs /app/handler.mjs

# Lambda runtime interface
ENTRYPOINT ["/usr/local/bin/npx", "aws-lambda-ric"]
CMD ["handler.handler"]
```

**Key Points**:
- Base image: `ghcr.io/danny-avila/librechat-api:v0.8.2-rc1` (FR-006)
- Lambda handler wraps LibreChat API to handle Lambda events
- ENTRYPOINT uses aws-lambda-ric for Lambda compatibility

### 2.2 Lambda Handler Wrapper

The handler must:
1. Receive API Gateway events
2. Start LibreChat API (or reuse from warm start)
3. Forward requests and stream responses

```javascript
// handler.mjs - Lambda wrapper for LibreChat
import { spawn } from 'child_process';

let server = null;

async function ensureServerRunning() {
  if (!server) {
    // Start LibreChat API on cold start
    server = spawn('node', ['/app/dist/server/index.js']);
    // Wait for ready
    await waitForHealthy('http://localhost:3080/health');
  }
}

export const handler = awslambda.streamifyResponse(
  async (event, responseStream, context) => {
    await ensureServerRunning();
    // Forward request to LibreChat and stream response
    // ...
  }
);
```

### 2.3 ECR Repository Configuration

**Source**: [AWS Terraform Provider - aws_ecr_repository](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ecr_repository)

```hcl
resource "aws_ecr_repository" "api" {
  name         = "librechat-lambda-api"
  force_delete = true  # FR-012: Allow cleanup with images

  image_scanning_configuration {
    scan_on_push = true
  }
}
```

### 2.4 Lambda Function Configuration

**Source**: [AWS Terraform Provider - aws_lambda_function](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function)

```hcl
resource "aws_lambda_function" "api" {
  function_name = "librechat-api"
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.api.repository_url}:latest"

  memory_size = 1024
  timeout     = 900  # 15 minutes max for streaming

  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      USE_REDIS = "true"
      REDIS_URI = "redis://${module.redis.replication_group_primary_endpoint_address}:6379"
      # ... other env vars from SSM
    }
  }
}
```

Key attribute: `response_streaming_invoke_arn` - The ARN for Lambda response streaming invocations.

---

## 3. ElastiCache Redis Module

### 3.1 terraform-aws-modules/elasticache/aws v1.10.3

**Source**: [Terraform Registry - elasticache module](https://registry.terraform.io/modules/terraform-aws-modules/elasticache/aws/1.10.3)

Configuration for cluster mode disabled (single node per FR-037):

```hcl
module "redis" {
  source  = "terraform-aws-modules/elasticache/aws"
  version = "1.10.3"

  replication_group_id = "librechat-lambda-redis"

  # Cluster mode disabled (FR-037)
  cluster_mode_enabled = false
  num_cache_clusters   = 1

  engine         = "redis"
  engine_version = "7.1"
  node_type      = "cache.t4g.micro"  # Small instance for dev

  # VPC configuration (FR-038)
  vpc_id     = var.vpc_id
  subnet_ids = var.private_subnet_ids

  # Security group rules (FR-040, FR-041)
  create_security_group = true
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

  # Encryption
  at_rest_encryption_enabled = true
  transit_encryption_enabled = false  # LibreChat uses redis:// not rediss://

  apply_immediately = true
}
```

**Key Outputs**:
- `replication_group_primary_endpoint_address` - Redis endpoint for `REDIS_URI`
- `security_group_id` - For Lambda security group egress rules

### 3.2 LibreChat Redis Environment Variables

**Source**: LibreChat source code analysis

```hcl
environment {
  variables = {
    USE_REDIS = "true"                                    # Enable Redis
    REDIS_URI = "redis://${module.redis.replication_group_primary_endpoint_address}:6379"
  }
}
```

LibreChat uses `USE_REDIS` (boolean) and `REDIS_URI` (connection string) - NOT `REDIS_URL`.

---

## 4. CloudFront Distribution

### 4.1 terraform-aws-modules/cloudfront/aws

**Source**: [Terraform Registry - cloudfront module](https://registry.terraform.io/modules/terraform-aws-modules/cloudfront/aws/latest)

Dual-origin configuration (S3 + API Gateway):

```hcl
module "cloudfront" {
  source  = "terraform-aws-modules/cloudfront/aws"
  version = "~> 4.0"

  aliases = ["lambda-test.sandbox.data.apro.is"]

  origin = {
    s3_frontend = {
      domain_name           = module.s3_frontend.s3_bucket_bucket_regional_domain_name
      origin_access_control = "s3_oac"
    }

    api_gateway = {
      domain_name = replace(aws_api_gateway_stage.prod.invoke_url, "/^https?://([^/]*).*/", "$1")
      custom_origin_config = {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  origin_access_control = {
    s3_oac = {
      description      = "CloudFront access to S3"
      origin_type      = "s3"
      signing_behavior = "always"
      signing_protocol = "sigv4"
    }
  }

  # Default behavior - S3 frontend (FR-014)
  default_cache_behavior = {
    target_origin_id       = "s3_frontend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # SPA routing - return index.html for 404s (FR-003)
    function_association = {
      viewer-request = {
        function_arn = aws_cloudfront_function.spa_routing.arn
      }
    }
  }

  # API behavior - API Gateway (FR-013, FR-015)
  ordered_cache_behavior = [
    {
      path_pattern           = "/api/*"
      target_origin_id       = "api_gateway"
      viewer_protocol_policy = "https-only"
      allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]

      # No caching for API (FR-015)
      cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"  # CachingDisabled
      origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"  # AllViewerExceptHostHeader
    }
  ]

  viewer_certificate = {
    acm_certificate_arn = var.acm_certificate_arn
    ssl_support_method  = "sni-only"
  }
}
```

### 4.2 Origin Access Control for S3

**Source**: [AWS Terraform Provider - aws_cloudfront_origin_access_control](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudfront_origin_access_control)

```hcl
resource "aws_cloudfront_origin_access_control" "s3" {
  name                              = "librechat-frontend-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
```

### 4.3 S3 Bucket Policy for OAC

```hcl
data "aws_iam_policy_document" "s3_policy" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${module.s3_frontend.s3_bucket_arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [module.cloudfront.cloudfront_distribution_arn]
    }
  }
}
```

---

## 5. S3 Buckets Configuration

### 5.1 Frontend Bucket (terraform-aws-modules/s3-bucket/aws)

```hcl
module "s3_frontend" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "~> 4.0"

  bucket = "librechat-frontend-${var.environment}"

  # FR-002: No versioning, force_destroy enabled
  versioning = {
    enabled = false
  }
  force_destroy = true

  # Block all public access (OAC handles access)
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```

### 5.2 File Storage Bucket (FR-030, FR-031, FR-034)

```hcl
module "s3_files" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "~> 4.0"

  bucket = "librechat-lambda-files-${var.environment}"

  force_destroy = true

  versioning = {
    enabled = false
  }

  # CORS for direct uploads
  cors_rule = [
    {
      allowed_headers = ["*"]
      allowed_methods = ["GET", "PUT", "POST"]
      allowed_origins = ["https://lambda-test.sandbox.data.apro.is"]
      expose_headers  = ["ETag"]
      max_age_seconds = 3600
    }
  ]
}
```

---

## 6. VPC and Security Considerations

### 6.1 Lambda VPC Configuration (FR-020, FR-028)

Lambda requires:
- Private subnets with NAT gateway for outbound internet
- VPC DNS resolution enabled for Cloud Map services (`.local` domains)
- Security group allowing outbound to all required services

### 6.2 Lambda Security Group

```hcl
resource "aws_security_group" "lambda" {
  name        = "librechat-lambda-sg"
  description = "Security group for LibreChat Lambda function"
  vpc_id      = var.vpc_id

  # Outbound to DocumentDB
  egress {
    from_port   = 27017
    to_port     = 27017
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.existing.cidr_block]
    description = "DocumentDB"
  }

  # Outbound to Redis (FR-040)
  egress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.redis.security_group_id]
    description     = "ElastiCache Redis"
  }

  # Outbound to Cloud Map services (various ports)
  egress {
    from_port   = 0
    to_port     = 65535
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.existing.cidr_block]
    description = "Cloud Map services"
  }

  # Outbound HTTPS (external APIs, S3)
  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS egress"
  }
}
```

### 6.3 Cloud Map DNS Resolution

Lambda VPC configuration automatically enables DNS resolution for Cloud Map services (`.local` domains) when deployed in the same VPC as ECS services.

---

## 7. Module Decision Matrix

| Component | Module | Rationale |
|-----------|--------|-----------|
| S3 (Frontend) | terraform-aws-modules/s3-bucket/aws | FR-005: Standard, well-maintained |
| S3 (File Storage) | terraform-aws-modules/s3-bucket/aws | FR-034: Same module, different bucket |
| CloudFront | terraform-aws-modules/cloudfront/aws | FR-004: Supports OAC, multiple origins |
| ElastiCache | terraform-aws-modules/elasticache/aws v1.10.3 | FR-036: Cluster mode disabled support |
| API Gateway | Native aws_api_gateway_* | FR-018: No module supports REST API streaming |
| Lambda | Native aws_lambda_function | Standard for containers |
| ECR | Native aws_ecr_repository | Simple, no module needed |

---

## 8. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Lambda cold start during SSE | 3-10s user experience delay | Accept for dev; provisioned concurrency for prod |
| 15-minute timeout for long responses | Request timeout | LibreChat responses typically < 5 min |
| CloudFront + API Gateway streaming | Potential buffering | CloudFront passes through streaming responses |
| aws-lambda-ric compatibility | Container startup issues | Test with LibreChat base image |
| Redis connection from Lambda | Session failures | ElastiCache in same VPC with security group rules |

---

## 9. Implementation Recommendations

Based on the spec priorities:

1. **P1 - Frontend module** (FR-001 to FR-005)
   - Lowest risk, provides immediate value
   - S3 + CloudFront with OAC

2. **P2 - Backend module** (FR-006 to FR-012, FR-024 to FR-033)
   - Build Lambda container with aws-lambda-ric
   - Test streaming handler before full deployment
   - Add ElastiCache Redis for session storage

3. **P2 - API Gateway module** (FR-009 to FR-011, FR-018)
   - REST API with streaming integration
   - Configure `/api/*` proxy to Lambda

4. **P3 - CloudFront routing integration** (FR-013 to FR-015, FR-021 to FR-023)
   - Add API Gateway origin to CloudFront
   - Configure path-based routing
   - Add custom domain and Route53 record

---

## 10. Validation Checklist

Before proceeding to implementation:

- [x] API Gateway REST API supports streaming (`response_transfer_mode`)
- [x] terraform-aws-modules/cloudfront supports multiple origins
- [x] terraform-aws-modules/elasticache supports cluster_mode_enabled=false
- [x] aws-lambda-ric is standard pattern for Lambda containers
- [x] Lambda `response_streaming_invoke_arn` attribute exists
- [x] CloudFront can route `/api/*` to API Gateway without caching

---

## References

- [AWS API Gateway Response Streaming](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html)
- [Lambda Response Streaming Configuration](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-streaming-lambda-configure.html)
- [terraform-aws-modules/elasticache/aws](https://registry.terraform.io/modules/terraform-aws-modules/elasticache/aws/1.10.3)
- [terraform-aws-modules/cloudfront/aws](https://registry.terraform.io/modules/terraform-aws-modules/cloudfront/aws/latest)
- [terraform-aws-modules/s3-bucket/aws](https://registry.terraform.io/modules/terraform-aws-modules/s3-bucket/aws/latest)
- [AWS Lambda Runtime Interface Client](https://github.com/aws/aws-lambda-nodejs-runtime-interface-client)
- [AWS Terraform Provider - api_gateway_integration](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_integration)
