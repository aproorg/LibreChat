# API Gateway Module Outputs (REST API v1)

output "rest_api_id" {
  description = "REST API ID"
  value       = aws_api_gateway_rest_api.api.id
}

output "rest_api_execution_arn" {
  description = "REST API execution ARN"
  value       = aws_api_gateway_rest_api.api.execution_arn
}

output "invoke_url" {
  description = "API Gateway invoke URL (includes /prod stage)"
  value       = aws_api_gateway_stage.prod.invoke_url
}

output "stage_name" {
  description = "API Gateway stage name"
  value       = aws_api_gateway_stage.prod.stage_name
}

output "api_name" {
  description = "API Gateway REST API name"
  value       = aws_api_gateway_rest_api.api.name
}
