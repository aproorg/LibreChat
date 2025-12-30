# Dev Environment Variables

variable "profile" {
  description = "AWS CLI profile to use"
  type        = string
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "eu-west-1"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "dev"
}

variable "vpc_id" {
  description = "VPC ID for Lambda and Redis"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for Lambda and Redis"
  type        = list(string)
}

variable "custom_domain" {
  description = "Custom domain (e.g., lambda-test.sandbox.data.apro.is)"
  type        = string
  default     = "lambda-test.sandbox.data.apro.is"
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN (us-east-1) for CloudFront"
  type        = string
}

variable "route53_zone_id" {
  description = "Route53 hosted zone ID"
  type        = string
}

variable "config_s3_bucket" {
  description = "S3 bucket for librechat.yaml config"
  type        = string
  default     = "genai-shared-config"
}

variable "config_s3_key" {
  description = "S3 key for librechat.yaml config"
  type        = string
  default     = "lambda-test/librechat/librechat.yaml"
}

variable "cloud_map_namespace" {
  description = "Cloud Map namespace for ECS services"
  type        = string
  default     = "dev-aprochat-core.local"
}

variable "ssm_parameter_arns" {
  description = "SSM parameter ARNs for secrets"
  type        = list(string)
  default = [
    "arn:aws:ssm:eu-west-1:*:parameter/ecs/genai/librechat/*",
    "arn:aws:ssm:eu-west-1:*:parameter/ecs/genai/mongo/*",
    "arn:aws:ssm:eu-west-1:*:parameter/ecs/genai/litellm/*",
    "arn:aws:ssm:eu-west-1:*:parameter/ecs/genai/meilisearch/*",
    "arn:aws:ssm:eu-west-1:*:parameter/ecs/genai/cognito/*",
    "arn:aws:ssm:eu-west-1:*:parameter/ecs/genai/firecrawl/*"
  ]
}

variable "litellm_security_group_id" {
  description = "LiteLLM ECS service security group ID"
  type        = string
}

variable "rag_api_security_group_id" {
  description = "RAG API ECS service security group ID"
  type        = string
}
