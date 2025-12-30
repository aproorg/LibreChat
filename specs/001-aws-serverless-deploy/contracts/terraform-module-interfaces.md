# Terraform Module Interfaces

**Branch**: `001-aws-serverless-deploy` | **Date**: 2025-12-25
**Status**: Updated - Simplified architecture

## Overview

This document defines the interface contracts for the four Terraform modules in the simplified architecture.

---

## Module: frontend

**Purpose**: S3 bucket for frontend assets + CloudFront distribution with dual origins

**Source Path**: `infrastructure/terraform/modules/frontend/`

### Inputs

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `environment` | string | yes | - | Environment name (e.g., "dev") |
| `custom_domain` | string | yes | - | Custom domain (e.g., "lambda-test.sandbox.data.apro.is") |
| `acm_certificate_arn` | string | yes | - | ACM certificate ARN (us-east-1) |
| `route53_zone_id` | string | yes | - | Route53 hosted zone ID |
| `api_gateway_endpoint` | string | yes | - | API Gateway REST API invoke URL |
| `tags` | map(string) | no | {} | Resource tags |

### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `cloudfront_distribution_id` | string | CloudFront distribution ID |
| `cloudfront_distribution_arn` | string | CloudFront distribution ARN |
| `cloudfront_domain_name` | string | CloudFront domain name |
| `s3_bucket_name` | string | Frontend S3 bucket name |
| `s3_bucket_arn` | string | Frontend S3 bucket ARN |

### Resources Created

```hcl
# terraform-aws-modules/s3-bucket/aws
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
}

# terraform-aws-modules/cloudfront/aws
module "cloudfront" {
  source  = "terraform-aws-modules/cloudfront/aws"
  version = "~> 4.0"

  aliases = [var.custom_domain]

  origin = {
    s3_frontend = {
      domain_name           = module.s3_frontend.s3_bucket_bucket_regional_domain_name
      origin_access_control = "s3_oac"
    }
    api_gateway = {
      domain_name = local.api_gateway_domain
      custom_origin_config = {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  default_cache_behavior = {
    target_origin_id       = "s3_frontend"
    viewer_protocol_policy = "redirect-to-https"
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6"  # CachingOptimized
  }

  ordered_cache_behavior = [{
    path_pattern             = "/api/*"
    target_origin_id         = "api_gateway"
    viewer_protocol_policy   = "https-only"
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"  # CachingDisabled
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"  # AllViewerExceptHostHeader
    allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
  }]

  viewer_certificate = {
    acm_certificate_arn = var.acm_certificate_arn
    ssl_support_method  = "sni-only"
  }
}

# Route53 A record (alias to CloudFront)
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

---

## Module: backend

**Purpose**: Lambda function + ECR repository + IAM roles

**Source Path**: `infrastructure/terraform/modules/backend/`

### Inputs

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `environment` | string | yes | - | Environment name |
| `vpc_id` | string | yes | - | VPC ID for Lambda |
| `private_subnet_ids` | list(string) | yes | - | Private subnet IDs |
| `redis_endpoint` | string | yes | - | ElastiCache Redis endpoint |
| `redis_security_group_id` | string | yes | - | Redis security group ID |
| `custom_domain` | string | yes | - | Custom domain for DOMAIN_SERVER/CLIENT |
| `config_s3_bucket` | string | yes | - | S3 bucket for librechat.yaml |
| `config_s3_key` | string | yes | - | S3 key for librechat.yaml |
| `ssm_parameter_arns` | list(string) | yes | - | SSM parameter ARNs for secrets |
| `tags` | map(string) | no | {} | Resource tags |

### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `lambda_function_arn` | string | Lambda function ARN |
| `lambda_function_name` | string | Lambda function name |
| `lambda_invoke_arn` | string | Lambda invoke ARN |
| `lambda_response_streaming_invoke_arn` | string | Lambda streaming invoke ARN |
| `lambda_security_group_id` | string | Lambda security group ID |
| `ecr_repository_url` | string | ECR repository URL |
| `files_bucket_name` | string | File storage S3 bucket name |

### Resources Created

```hcl
# ECR Repository
resource "aws_ecr_repository" "api" {
  name         = "librechat-lambda-api"
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

# S3 Bucket for file uploads
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
}

# Lambda Security Group
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
}

# Lambda Function
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
      DOMAIN_SERVER     = "https://${var.custom_domain}"
      DOMAIN_CLIENT     = "https://${var.custom_domain}"
      CONFIG_PATH       = "/tmp/librechat.yaml"
      USE_REDIS         = "true"
      REDIS_URI         = "redis://${var.redis_endpoint}:6379"
      AWS_BUCKET_NAME   = module.s3_files.s3_bucket_id
      AWS_REGION        = data.aws_region.current.name
      # Cloud Map service URLs
      LITELLM_BASE_URL       = "http://litellm.dev-aprochat-core.local:4000/v1"
      SEARXNG_INSTANCE_URL   = "http://searxng.dev-aprochat-core.local:8080"
      RAG_API_URL            = "http://rag-api.dev-aprochat-core.local:8000"
      MEILI_HOST             = "http://meilisearch.dev-aprochat-core.local:7700"
      FIRECRAWL_API_URL      = "http://firecrawl.dev-aprochat-core.local:3002"
    }
  }
}

# IAM Role and Policies
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

---

## Module: api-gateway

**Purpose**: REST API (v1) with Lambda proxy integration and streaming support

**Source Path**: `infrastructure/terraform/modules/api-gateway/`

### Inputs

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `lambda_function_arn` | string | yes | - | Lambda function ARN |
| `lambda_invoke_arn` | string | yes | - | Lambda invoke ARN |
| `lambda_response_streaming_invoke_arn` | string | yes | - | Lambda streaming invoke ARN |
| `region` | string | yes | - | AWS region |
| `tags` | map(string) | no | {} | Resource tags |

### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `rest_api_id` | string | REST API ID |
| `rest_api_execution_arn` | string | REST API execution ARN |
| `invoke_url` | string | API Gateway invoke URL |

### Resources Created

```hcl
# REST API
resource "aws_api_gateway_rest_api" "api" {
  name        = "librechat-rest-api"
  description = "LibreChat REST API with streaming support"

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

# /api resource
resource "aws_api_gateway_resource" "api" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_rest_api.api.root_resource_id
  path_part   = "api"
}

# /api/{proxy+} resource
resource "aws_api_gateway_resource" "proxy" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "{proxy+}"
}

# ANY method
resource "aws_api_gateway_method" "proxy" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.proxy.id
  http_method   = "ANY"
  authorization = "NONE"
}

# Lambda integration with streaming
resource "aws_api_gateway_integration" "proxy" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.proxy.id
  http_method             = aws_api_gateway_method.proxy.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"

  # Key: Use response-streaming-invocations for SSE support
  uri = "arn:aws:apigateway:${var.region}:lambda:path/2021-11-15/functions/${var.lambda_function_arn}/response-streaming-invocations"

  # 15 minutes for streaming mode
  timeout_milliseconds = 900000
}

# OPTIONS for CORS
resource "aws_api_gateway_method" "options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.proxy.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.proxy.id
  http_method = aws_api_gateway_method.options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

# Deployment
resource "aws_api_gateway_deployment" "api" {
  rest_api_id = aws_api_gateway_rest_api.api.id

  depends_on = [
    aws_api_gateway_integration.proxy,
    aws_api_gateway_integration.options
  ]

  lifecycle {
    create_before_destroy = true
  }
}

# Stage (prod)
resource "aws_api_gateway_stage" "prod" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  deployment_id = aws_api_gateway_deployment.api.id
  stage_name    = "prod"
}

# Lambda permission
resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunctionWithResponseStreaming"
  function_name = var.lambda_function_arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/*"
}
```

---

## Module: redis

**Purpose**: ElastiCache Redis cluster for session storage

**Source Path**: `infrastructure/terraform/modules/redis/`

### Inputs

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `environment` | string | yes | - | Environment name |
| `vpc_id` | string | yes | - | VPC ID |
| `private_subnet_ids` | list(string) | yes | - | Private subnet IDs |
| `lambda_security_group_id` | string | yes | - | Lambda security group ID |
| `tags` | map(string) | no | {} | Resource tags |

### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `replication_group_id` | string | Redis replication group ID |
| `primary_endpoint_address` | string | Redis primary endpoint |
| `security_group_id` | string | Redis security group ID |

### Resources Created

```hcl
# terraform-aws-modules/elasticache/aws v1.10.3
module "redis" {
  source  = "terraform-aws-modules/elasticache/aws"
  version = "1.10.3"

  replication_group_id = "librechat-lambda-redis"

  # Cluster mode disabled (FR-037)
  cluster_mode_enabled = false
  num_cache_clusters   = 1

  engine         = "redis"
  engine_version = "7.1"
  node_type      = "cache.t4g.micro"

  # VPC configuration (FR-038)
  vpc_id     = var.vpc_id
  subnet_ids = var.private_subnet_ids

  # Security group (FR-041)
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

  # Encryption
  at_rest_encryption_enabled = true
  transit_encryption_enabled = false  # LibreChat uses redis:// not rediss://

  apply_immediately = true

  tags = var.tags
}
```

---

## Module Dependencies

```
                    ┌─────────────┐
                    │    redis    │
                    └──────┬──────┘
                           │ security_group_id
                           │ primary_endpoint_address
                           ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  frontend   │◄────│   backend   │────►│ api-gateway │
└─────────────┘     └─────────────┘     └─────────────┘
      ▲                    │                   │
      │                    │                   │
      │ api_gateway_       │ lambda_arn        │
      │ endpoint           │ streaming_arn     │
      └────────────────────┴───────────────────┘
```

**Dependency Order**:
1. `redis` (no dependencies)
2. `backend` (depends on redis.security_group_id, redis.primary_endpoint_address)
3. `api-gateway` (depends on backend.lambda_function_arn, backend.lambda_response_streaming_invoke_arn)
4. `frontend` (depends on api-gateway.invoke_url)
