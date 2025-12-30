# Dev Environment Outputs

# -----------------------------------------------------------------------------
# Frontend Outputs
# -----------------------------------------------------------------------------

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID"
  value       = module.frontend.cloudfront_distribution_id
}

output "cloudfront_domain_name" {
  description = "CloudFront domain name"
  value       = module.frontend.cloudfront_domain_name
}

output "frontend_s3_bucket" {
  description = "Frontend S3 bucket name"
  value       = module.frontend.s3_bucket_name
}

# -----------------------------------------------------------------------------
# Backend Outputs
# -----------------------------------------------------------------------------

output "lambda_function_name" {
  description = "Lambda function name"
  value       = module.backend.lambda_function_name
}

output "lambda_function_arn" {
  description = "Lambda function ARN"
  value       = module.backend.lambda_function_arn
}

output "ecr_repository_url" {
  description = "ECR repository URL"
  value       = aws_ecr_repository.api.repository_url
}

output "files_bucket_name" {
  description = "File storage S3 bucket name"
  value       = module.backend.files_bucket_name
}

# -----------------------------------------------------------------------------
# API Gateway Outputs
# -----------------------------------------------------------------------------

output "api_gateway_invoke_url" {
  description = "API Gateway invoke URL"
  value       = module.api_gateway.invoke_url
}

output "api_gateway_rest_api_id" {
  description = "API Gateway REST API ID"
  value       = module.api_gateway.rest_api_id
}

# -----------------------------------------------------------------------------
# Redis Outputs
# -----------------------------------------------------------------------------

output "redis_endpoint" {
  description = "Redis primary endpoint address"
  value       = module.redis.primary_endpoint_address
}

# -----------------------------------------------------------------------------
# URLs
# -----------------------------------------------------------------------------

output "application_url" {
  description = "Application URL"
  value       = "https://${var.custom_domain}"
}

output "api_url" {
  description = "API URL"
  value       = "https://${var.custom_domain}/api"
}
