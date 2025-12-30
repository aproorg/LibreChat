# Frontend Module Outputs

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID"
  value       = aws_cloudfront_distribution.main.id
}

output "cloudfront_distribution_arn" {
  description = "CloudFront distribution ARN"
  value       = aws_cloudfront_distribution.main.arn
}

output "cloudfront_domain_name" {
  description = "CloudFront domain name"
  value       = aws_cloudfront_distribution.main.domain_name
}

output "s3_bucket_name" {
  description = "Frontend S3 bucket name"
  value       = module.s3_frontend.s3_bucket_id
}

output "s3_bucket_arn" {
  description = "Frontend S3 bucket ARN"
  value       = module.s3_frontend.s3_bucket_arn
}

output "s3_bucket_regional_domain_name" {
  description = "Frontend S3 bucket regional domain name"
  value       = module.s3_frontend.s3_bucket_bucket_regional_domain_name
}
