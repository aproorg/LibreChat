# Backend Module Outputs

output "lambda_function_arn" {
  description = "Lambda function ARN"
  value       = aws_lambda_function.api.arn
}

output "lambda_function_name" {
  description = "Lambda function name"
  value       = aws_lambda_function.api.function_name
}

output "lambda_invoke_arn" {
  description = "Lambda invoke ARN"
  value       = aws_lambda_function.api.invoke_arn
}

output "lambda_security_group_id" {
  description = "Lambda security group ID"
  value       = aws_security_group.lambda.id
}

output "files_bucket_name" {
  description = "File storage S3 bucket name"
  value       = module.s3_files.s3_bucket_id
}

output "files_bucket_arn" {
  description = "File storage S3 bucket ARN"
  value       = module.s3_files.s3_bucket_arn
}

output "iam_role_arn" {
  description = "Lambda IAM role ARN"
  value       = aws_iam_role.lambda.arn
}

output "lambda_streaming_function_arn" {
  description = "Lambda streaming function ARN"
  value       = aws_lambda_function.api_streaming.arn
}

output "lambda_streaming_function_name" {
  description = "Lambda streaming function name"
  value       = aws_lambda_function.api_streaming.function_name
}
