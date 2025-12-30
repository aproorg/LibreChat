# Frontend Module Variables

variable "environment" {
  description = "Environment name (e.g., dev, staging, prod)"
  type        = string
}

variable "custom_domain" {
  description = "Custom domain (e.g., lambda-test.sandbox.data.apro.is)"
  type        = string
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN (us-east-1)"
  type        = string
}

variable "route53_zone_id" {
  description = "Route53 hosted zone ID"
  type        = string
}

variable "api_gateway_endpoint" {
  description = "API Gateway REST API invoke URL"
  type        = string
}

variable "tags" {
  description = "Resource tags"
  type        = map(string)
  default     = {}
}
