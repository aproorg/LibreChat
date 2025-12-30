# Monitoring Module Variables

variable "environment" {
  description = "Environment name (e.g., dev, staging, prod)"
  type        = string
}

variable "region" {
  description = "AWS region"
  type        = string
}

variable "lambda_function_name" {
  description = "Name of the Lambda function to monitor"
  type        = string
}

variable "lambda_concurrency_threshold" {
  description = "Threshold for Lambda concurrent executions alarm"
  type        = number
  default     = 50
}

variable "api_gateway_name" {
  description = "Name of the API Gateway REST API"
  type        = string
}

variable "api_gateway_stage" {
  description = "API Gateway stage name"
  type        = string
  default     = "prod"
}

variable "redis_cluster_id" {
  description = "ElastiCache Redis cluster ID"
  type        = string
}

variable "redis_max_connections" {
  description = "Maximum Redis connections threshold"
  type        = number
  default     = 100
}

variable "alert_email" {
  description = "Email address for alarm notifications (optional)"
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
