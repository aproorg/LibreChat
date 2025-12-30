# Backend Module - Lambda + S3 Files + IAM
# Purpose: Containerized LibreChat API with streaming support
# Note: ECR repository is created at the environment level to support image digest passing

# -----------------------------------------------------------------------------
# Data Sources
# -----------------------------------------------------------------------------

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

data "aws_vpc" "existing" {
  id = var.vpc_id
}

# -----------------------------------------------------------------------------
# S3 Bucket for File Uploads
# -----------------------------------------------------------------------------

module "s3_files" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "~> 4.0"

  bucket        = "librechat-lambda-files-${var.environment}"
  force_destroy = true

  # Block public access
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

  # CORS configuration for uploads
  cors_rule = [{
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST"]
    allowed_origins = ["https://${var.custom_domain}"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }]

  tags = var.tags
}

# -----------------------------------------------------------------------------
# Lambda Security Group
# -----------------------------------------------------------------------------

resource "aws_security_group" "lambda" {
  name        = "librechat-lambda-sg-${var.environment}"
  description = "Security group for LibreChat Lambda"
  vpc_id      = var.vpc_id

  # DocumentDB access
  egress {
    from_port   = 27017
    to_port     = 27017
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.existing.cidr_block]
    description = "DocumentDB"
  }

  # ElastiCache Redis access
  egress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [var.redis_security_group_id]
    description     = "ElastiCache Redis"
  }

  # Cloud Map services access (all ports within VPC)
  egress {
    from_port   = 0
    to_port     = 65535
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.existing.cidr_block]
    description = "Cloud Map services"
  }

  # HTTPS egress for external APIs
  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS egress"
  }

  tags = var.tags
}

# -----------------------------------------------------------------------------
# LiteLLM Security Group Ingress Rule
# Allows Lambda to reach LiteLLM ECS service on port 4000
# -----------------------------------------------------------------------------

resource "aws_security_group_rule" "litellm_ingress_from_lambda" {
  type                     = "ingress"
  from_port                = 4000
  to_port                  = 4000
  protocol                 = "tcp"
  security_group_id        = var.litellm_security_group_id
  source_security_group_id = aws_security_group.lambda.id
  description              = "Allow Lambda to reach LiteLLM"
}

resource "aws_security_group_rule" "rag_api_ingress_from_lambda" {
  type                     = "ingress"
  from_port                = 8000
  to_port                  = 8000
  protocol                 = "tcp"
  security_group_id        = var.rag_api_security_group_id
  source_security_group_id = aws_security_group.lambda.id
  description              = "Allow Lambda to reach RAG API"
}

# -----------------------------------------------------------------------------
# IAM Role and Policies
# -----------------------------------------------------------------------------

resource "aws_iam_role" "lambda" {
  name = "librechat-lambda-role-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda_custom" {
  name = "librechat-lambda-policy-${var.environment}"
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
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${module.s3_files.s3_bucket_arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = module.s3_files.s3_bucket_arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "arn:aws:s3:::${var.config_s3_bucket}/${var.config_s3_key}"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = "arn:aws:s3:::${var.config_s3_bucket}"
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Lambda Function
# -----------------------------------------------------------------------------

resource "aws_lambda_function" "api" {
  function_name = "librechat-api-${var.environment}"
  package_type  = "Image"
  image_uri     = var.docker_image_uri

  # Explicitly set the standard handler (overrides Dockerfile CMD)
  image_config {
    command = ["handler.handler"]
  }

  memory_size = 2048
  timeout     = 900

  role = aws_iam_role.lambda.arn

  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      # Domain configuration
      DOMAIN_SERVER = "https://${var.custom_domain}"
      DOMAIN_CLIENT = "https://${var.custom_domain}"

      # Config from S3 (using shared config bucket)
      CONFIG_PATH      = "/tmp/librechat.yaml"
      CONFIG_S3_BUCKET = var.config_s3_bucket
      CONFIG_S3_KEY    = var.config_s3_key

      # Redis
      USE_REDIS = "true"
      REDIS_URI = "redis://${var.redis_endpoint}:6379"

      # S3 file storage
      AWS_BUCKET_NAME = module.s3_files.s3_bucket_id

      # Cloud Map service URLs
      LITELLM_BASE_URL     = "http://litellm.${var.cloud_map_namespace}:4000/v1"
      SEARXNG_INSTANCE_URL = "http://searxng.${var.cloud_map_namespace}:8080"
      RAG_API_URL          = "http://rag-api.${var.cloud_map_namespace}:8000"
      FIRECRAWL_API_URL    = "http://firecrawl.${var.cloud_map_namespace}:3002"

      # Server configuration
      HOST       = "0.0.0.0"
      PORT       = "3080"
      NODE_ENV   = "production"
      ENV        = "dev"
      TRUST_PROXY = "2"

      # Auth configuration
      ALLOW_REGISTRATION             = "false"
      ALLOW_SOCIAL_LOGIN             = "true"
      ALLOW_SOCIAL_REGISTRATION      = "false"
      ALLOW_EMAIL_LOGIN              = "false"
      ALLOW_PASSWORD_RESET           = "false"
      ALLOW_UNVERIFIED_EMAIL_LOGIN   = "true"
      ALLOW_SHARED_LINKS             = "false"
      ALLOW_SHARED_LINKS_PUBLIC      = "false"

      # OpenID/Cognito configuration
      OPENID_ISSUER             = "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_HZelGgG25/.well-known/openid-configuration"
      OPENID_CALLBACK_URL       = "/oauth/openid/callback"
      OPENID_SCOPE              = "openid profile email"
      OPENID_BUTTON_LABEL       = "Innskráning"
      OPENID_NAME_CLAIM         = "name"
      OPENID_USERNAME_CLAIM     = "email"
      OPENID_USE_PKCE           = "true"
      OPENID_GENERATE_NONCE     = "true"
      OPENID_CLOCK_TOLERANCE    = "300"
      OPENID_REUSE_TOKENS       = "true"
      OPENID_EXPOSE_SUB_COOKIE  = "true"

      # Session configuration
      SESSION_EXPIRY        = "900000"
      REFRESH_TOKEN_EXPIRY  = "604800000"

      # Rate limiting
      LOGIN_WINDOW              = "5"
      LOGIN_MAX                 = "1000"
      LIMIT_CONCURRENT_MESSAGES = "false"
      LIMIT_MESSAGE_USER        = "false"
      LIMIT_MESSAGE_IP          = "false"
      BAN_VIOLATIONS            = "false"

      # Features - Meilisearch disabled to avoid 10s connection timeout blocking startup
      SEARCH                  = "false"
      RAG_USE_FULL_CONTEXT    = "true"
      NO_INDEX                = "true"
      DEBUG_PLUGINS           = "false"
      DEBUG_OPENID_REQUESTS   = "false"
      DEBUG_LOGGING           = "false"
      CONSOLE_JSON            = "true"

      # Lambda-specific configuration
      LIBRECHAT_LOG_DIR = "/tmp/logs"
      DEPLOY_TIMESTAMP  = "2025-12-27T02:00:00Z"  # Force cold start - FR-034 env var fix for S3 credentials

      # MCP configuration
      MCP_SKIP_CODE_CHALLENGE_CHECK = "true"
      MCP_OAUTH_ON_AUTH_ERROR       = "true"
      MCP_OAUTH_DETECTION_TIMEOUT   = "20000"

      # UI customization
      APP_TITLE      = "APRÓ Spjallið"
      CUSTOM_FOOTER  = "Apró ehf."
      HELP_AND_FAQ_URL = "https://www.apro.is/lausnir/gervigreindarhradall"

      # Unused but required
      SEARXNG_API_KEY = "dummy-not-used-yet"
      COHERE_API_KEY  = "dummy-not-used-yet"
      OPENAI_API_KEY  = ""

      # SSM Parameter ARN prefixes for handler to fetch secrets
      SSM_PARAM_CREDS_IV          = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/librechat/CREDS_IV"
      SSM_PARAM_CREDS_KEY         = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/librechat/CREDS_KEY"
      SSM_PARAM_JWT_SECRET        = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/librechat/JWT_SECRET"
      SSM_PARAM_JWT_REFRESH       = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/librechat/JWT_REFRESH_SECRET"
      SSM_PARAM_MONGO_URI         = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/mongo/DB_URI"
      SSM_PARAM_LITELLM_API_KEY   = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/litellm/master_key"
      SSM_PARAM_MEILI_MASTER_KEY  = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/meilisearch/MEILI_MASTER_KEY"
      SSM_PARAM_FIRECRAWL_API_KEY = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/firecrawl/test_api_key"
      SSM_PARAM_OPENID_CLIENT_ID  = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/cognito/idp/client_id"
      SSM_PARAM_OPENID_CLIENT_SECRET = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/cognito/idp/client_secret"
      SSM_PARAM_OPENID_SESSION_SECRET = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/cognito/idp/session_secret"
    }
  }

  tags = var.tags

  depends_on = [
    aws_iam_role_policy_attachment.lambda_vpc,
    aws_iam_role_policy_attachment.lambda_basic,
    aws_iam_role_policy.lambda_custom
  ]
}

# -----------------------------------------------------------------------------
# Lambda Function for Streaming (SSE endpoints)
# Uses the same image but with streamingHandler entry point
# -----------------------------------------------------------------------------

resource "aws_lambda_function" "api_streaming" {
  function_name = "librechat-api-streaming-${var.environment}"
  package_type  = "Image"
  image_uri     = var.docker_image_uri

  # Use the streaming handler that supports awslambda.streamifyResponse
  image_config {
    command = ["handler.streamingHandler"]
  }

  memory_size = 2048
  timeout     = 900

  role = aws_iam_role.lambda.arn

  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      # Domain configuration
      DOMAIN_SERVER = "https://${var.custom_domain}"
      DOMAIN_CLIENT = "https://${var.custom_domain}"

      # Config from S3 (using shared config bucket)
      CONFIG_PATH      = "/tmp/librechat.yaml"
      CONFIG_S3_BUCKET = var.config_s3_bucket
      CONFIG_S3_KEY    = var.config_s3_key

      # Redis
      USE_REDIS = "true"
      REDIS_URI = "redis://${var.redis_endpoint}:6379"

      # S3 file storage
      AWS_BUCKET_NAME = module.s3_files.s3_bucket_id

      # Cloud Map service URLs
      LITELLM_BASE_URL     = "http://litellm.${var.cloud_map_namespace}:4000/v1"
      SEARXNG_INSTANCE_URL = "http://searxng.${var.cloud_map_namespace}:8080"
      RAG_API_URL          = "http://rag-api.${var.cloud_map_namespace}:8000"
      FIRECRAWL_API_URL    = "http://firecrawl.${var.cloud_map_namespace}:3002"

      # Server configuration
      HOST       = "0.0.0.0"
      PORT       = "3080"
      NODE_ENV   = "production"
      ENV        = "dev"
      TRUST_PROXY = "2"

      # Auth configuration
      ALLOW_REGISTRATION             = "false"
      ALLOW_SOCIAL_LOGIN             = "true"
      ALLOW_SOCIAL_REGISTRATION      = "false"
      ALLOW_EMAIL_LOGIN              = "false"
      ALLOW_PASSWORD_RESET           = "false"
      ALLOW_UNVERIFIED_EMAIL_LOGIN   = "true"
      ALLOW_SHARED_LINKS             = "false"
      ALLOW_SHARED_LINKS_PUBLIC      = "false"

      # OpenID/Cognito configuration
      OPENID_ISSUER             = "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_HZelGgG25/.well-known/openid-configuration"
      OPENID_CALLBACK_URL       = "/oauth/openid/callback"
      OPENID_SCOPE              = "openid profile email"
      OPENID_BUTTON_LABEL       = "Innskráning"
      OPENID_NAME_CLAIM         = "name"
      OPENID_USERNAME_CLAIM     = "email"
      OPENID_USE_PKCE           = "true"
      OPENID_GENERATE_NONCE     = "true"
      OPENID_CLOCK_TOLERANCE    = "300"
      OPENID_REUSE_TOKENS       = "true"
      OPENID_EXPOSE_SUB_COOKIE  = "true"

      # Session configuration
      SESSION_EXPIRY        = "900000"
      REFRESH_TOKEN_EXPIRY  = "604800000"

      # Rate limiting
      LOGIN_WINDOW              = "5"
      LOGIN_MAX                 = "1000"
      LIMIT_CONCURRENT_MESSAGES = "false"
      LIMIT_MESSAGE_USER        = "false"
      LIMIT_MESSAGE_IP          = "false"
      BAN_VIOLATIONS            = "false"

      # Features
      SEARCH                  = "false"
      RAG_USE_FULL_CONTEXT    = "true"
      NO_INDEX                = "true"
      DEBUG_PLUGINS           = "false"
      DEBUG_OPENID_REQUESTS   = "false"
      DEBUG_LOGGING           = "false"
      CONSOLE_JSON            = "true"

      # Lambda-specific configuration
      LIBRECHAT_LOG_DIR = "/tmp/logs"
      DEPLOY_TIMESTAMP  = "2025-12-27T02:00:00Z"  # Force cold start - FR-034 env var fix for S3 credentials

      # MCP configuration
      MCP_SKIP_CODE_CHALLENGE_CHECK = "true"
      MCP_OAUTH_ON_AUTH_ERROR       = "true"
      MCP_OAUTH_DETECTION_TIMEOUT   = "20000"

      # UI customization
      APP_TITLE      = "APRÓ Spjallið"
      CUSTOM_FOOTER  = "Apró ehf."
      HELP_AND_FAQ_URL = "https://www.apro.is/lausnir/gervigreindarhradall"

      # Unused but required
      SEARXNG_API_KEY = "dummy-not-used-yet"
      COHERE_API_KEY  = "dummy-not-used-yet"
      OPENAI_API_KEY  = ""

      # SSM Parameter ARN prefixes for handler to fetch secrets
      SSM_PARAM_CREDS_IV          = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/librechat/CREDS_IV"
      SSM_PARAM_CREDS_KEY         = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/librechat/CREDS_KEY"
      SSM_PARAM_JWT_SECRET        = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/librechat/JWT_SECRET"
      SSM_PARAM_JWT_REFRESH       = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/librechat/JWT_REFRESH_SECRET"
      SSM_PARAM_MONGO_URI         = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/mongo/DB_URI"
      SSM_PARAM_LITELLM_API_KEY   = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/litellm/master_key"
      SSM_PARAM_MEILI_MASTER_KEY  = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/meilisearch/MEILI_MASTER_KEY"
      SSM_PARAM_FIRECRAWL_API_KEY = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/firecrawl/test_api_key"
      SSM_PARAM_OPENID_CLIENT_ID  = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/cognito/idp/client_id"
      SSM_PARAM_OPENID_CLIENT_SECRET = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/cognito/idp/client_secret"
      SSM_PARAM_OPENID_SESSION_SECRET = "arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/cognito/idp/session_secret"
    }
  }

  tags = var.tags

  depends_on = [
    aws_iam_role_policy_attachment.lambda_vpc,
    aws_iam_role_policy_attachment.lambda_basic,
    aws_iam_role_policy.lambda_custom
  ]
}
