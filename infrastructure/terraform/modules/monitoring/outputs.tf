# Monitoring Module Outputs

output "sns_topic_arn" {
  description = "ARN of the SNS topic for alerts"
  value       = aws_sns_topic.alerts.arn
}

output "dashboard_name" {
  description = "Name of the CloudWatch dashboard"
  value       = aws_cloudwatch_dashboard.main.dashboard_name
}

output "alarm_arns" {
  description = "ARNs of all CloudWatch alarms"
  value = {
    lambda_errors     = aws_cloudwatch_metric_alarm.lambda_errors.arn
    lambda_duration   = aws_cloudwatch_metric_alarm.lambda_duration.arn
    lambda_throttles  = aws_cloudwatch_metric_alarm.lambda_throttles.arn
    lambda_concurrent = aws_cloudwatch_metric_alarm.lambda_concurrent.arn
    api_5xx_errors    = aws_cloudwatch_metric_alarm.api_5xx_errors.arn
    api_4xx_errors    = aws_cloudwatch_metric_alarm.api_4xx_errors.arn
    api_latency       = aws_cloudwatch_metric_alarm.api_latency.arn
    redis_cpu         = aws_cloudwatch_metric_alarm.redis_cpu.arn
    redis_memory      = aws_cloudwatch_metric_alarm.redis_memory.arn
    redis_connections = aws_cloudwatch_metric_alarm.redis_connections.arn
  }
}
