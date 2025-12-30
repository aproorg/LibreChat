# API Gateway Module Variables

variable "environment" {
  description = "Environment name (e.g., dev, staging, prod)"
  type        = string
}

variable "lambda_function_arn" {
  description = "Lambda function ARN (for standard endpoints)"
  type        = string
}

variable "lambda_streaming_function_arn" {
  description = "Lambda function ARN (for streaming/SSE endpoints)"
  type        = string
}

variable "region" {
  description = "AWS region"
  type        = string
}

variable "tags" {
  description = "Resource tags"
  type        = map(string)
  default     = {}
}
