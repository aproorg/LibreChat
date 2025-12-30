# Backend Module Variables

variable "environment" {
  description = "Environment name (e.g., dev, staging, prod)"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID for Lambda"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for Lambda"
  type        = list(string)
}

variable "redis_endpoint" {
  description = "ElastiCache Redis endpoint"
  type        = string
}

variable "redis_security_group_id" {
  description = "Redis security group ID"
  type        = string
}

variable "custom_domain" {
  description = "Custom domain for DOMAIN_SERVER/CLIENT"
  type        = string
}

variable "config_s3_bucket" {
  description = "S3 bucket for librechat.yaml"
  type        = string
}

variable "config_s3_key" {
  description = "S3 key for librechat.yaml"
  type        = string
}

variable "cloud_map_namespace" {
  description = "Cloud Map namespace for ECS services (e.g., dev-aprochat-core.local)"
  type        = string
}

variable "ssm_parameter_arns" {
  description = "SSM parameter ARNs for secrets"
  type        = list(string)
}

variable "docker_image_uri" {
  description = "Docker image URI with digest from ECR (ensures Lambda updates on image changes)"
  type        = string
}

variable "litellm_security_group_id" {
  description = "LiteLLM ECS service security group ID (to allow Lambda ingress)"
  type        = string
}

variable "rag_api_security_group_id" {
  description = "RAG API ECS service security group ID (to allow Lambda ingress)"
  type        = string
}

variable "tags" {
  description = "Resource tags"
  type        = map(string)
  default     = {}
}
