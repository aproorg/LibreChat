# Dev Environment Main Configuration
# AWS Serverless Deployment for LibreChat
# Orchestrates all modules for the dev environment

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
  }

  backend "s3" {}
}

# -----------------------------------------------------------------------------
# Provider Configuration
# -----------------------------------------------------------------------------

provider "aws" {
  region  = var.aws_region
  profile = var.profile

  default_tags {
    tags = {
      Project     = "LibreChat"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

# Docker provider for ECR builds
provider "docker" {
  registry_auth {
    address  = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
    username = data.aws_ecr_authorization_token.token.user_name
    password = data.aws_ecr_authorization_token.token.password
  }
}

# -----------------------------------------------------------------------------
# Data Sources
# -----------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_ecr_authorization_token" "token" {}

# -----------------------------------------------------------------------------
# Local Values
# -----------------------------------------------------------------------------

locals {
  tags = {
    Project     = "LibreChat"
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
  ecr_repository_url = aws_ecr_repository.api.repository_url
}

# -----------------------------------------------------------------------------
# ECR Repository (created at environment level to break circular dependency)
# -----------------------------------------------------------------------------

resource "aws_ecr_repository" "api" {
  name         = "librechat-lambda-api-${var.environment}"
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.tags
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = {
        type = "expire"
      }
    }]
  })
}

# -----------------------------------------------------------------------------
# Docker Image Build and Push (using kreuzwerker/docker provider)
# Must be after ECR repository, before backend module
# -----------------------------------------------------------------------------

resource "docker_image" "librechat_api" {
  name = "${local.ecr_repository_url}:latest"

  build {
    context    = "${path.module}/../../modules/backend/docker"
    dockerfile = "Dockerfile"
    tag        = ["${local.ecr_repository_url}:latest"]
    no_cache   = true
    platform   = "linux/amd64"
  }

  triggers = {
    dockerfile_hash = filemd5("${path.module}/../../modules/backend/docker/Dockerfile")
    handler_hash    = filemd5("${path.module}/../../modules/backend/docker/handler.js")
  }
}

resource "docker_registry_image" "librechat_api" {
  name          = docker_image.librechat_api.name
  keep_remotely = true

  triggers = {
    dockerfile_hash = filemd5("${path.module}/../../modules/backend/docker/Dockerfile")
    handler_hash    = filemd5("${path.module}/../../modules/backend/docker/handler.js")
  }
}

# -----------------------------------------------------------------------------
# Module: Backend (Lambda + S3 files + IAM)
# ECR moved to environment level to break circular dependency
# Must be created first to get lambda_security_group_id for redis
# -----------------------------------------------------------------------------

module "backend" {
  source = "../../modules/backend"

  environment               = var.environment
  vpc_id                    = var.vpc_id
  private_subnet_ids        = var.private_subnet_ids
  redis_endpoint            = module.redis.primary_endpoint_address
  redis_security_group_id   = module.redis.security_group_id
  litellm_security_group_id = var.litellm_security_group_id
  rag_api_security_group_id = var.rag_api_security_group_id
  custom_domain             = var.custom_domain
  config_s3_bucket          = var.config_s3_bucket
  config_s3_key             = var.config_s3_key
  cloud_map_namespace       = var.cloud_map_namespace
  ssm_parameter_arns        = var.ssm_parameter_arns
  docker_image_uri          = "${local.ecr_repository_url}@${docker_registry_image.librechat_api.sha256_digest}"

  tags = local.tags
}

# -----------------------------------------------------------------------------
# Module: Redis (ElastiCache cluster mode disabled)
# -----------------------------------------------------------------------------

module "redis" {
  source = "../../modules/redis"

  environment              = var.environment
  vpc_id                   = var.vpc_id
  private_subnet_ids       = var.private_subnet_ids
  lambda_security_group_id = module.backend.lambda_security_group_id

  tags = local.tags
}

# -----------------------------------------------------------------------------
# Module: API Gateway (REST API v1 with streaming)
# -----------------------------------------------------------------------------

module "api_gateway" {
  source = "../../modules/api-gateway"

  environment                    = var.environment
  lambda_function_arn            = module.backend.lambda_function_arn
  lambda_streaming_function_arn  = module.backend.lambda_streaming_function_arn
  region                         = var.aws_region

  tags = local.tags
}

# -----------------------------------------------------------------------------
# Module: Frontend (S3 + CloudFront with dual origins)
# -----------------------------------------------------------------------------

module "frontend" {
  source = "../../modules/frontend"

  environment          = var.environment
  custom_domain        = var.custom_domain
  acm_certificate_arn  = var.acm_certificate_arn
  route53_zone_id      = var.route53_zone_id
  api_gateway_endpoint = module.api_gateway.invoke_url

  tags = local.tags
}

# -----------------------------------------------------------------------------
# Module: Monitoring (CloudWatch Alarms + Dashboard)
# -----------------------------------------------------------------------------

module "monitoring" {
  source = "../../modules/monitoring"

  environment          = var.environment
  region               = var.aws_region
  lambda_function_name = module.backend.lambda_function_name
  api_gateway_name     = module.api_gateway.api_name
  api_gateway_stage    = module.api_gateway.stage_name
  redis_cluster_id     = module.redis.cluster_id

  tags = local.tags
}
