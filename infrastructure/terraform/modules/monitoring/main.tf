# CloudWatch Monitoring Module for LibreChat
# Provides alarms for Lambda, API Gateway, and Redis health monitoring

# -----------------------------------------------------------------------------
# SNS Topic for Alarm Notifications
# -----------------------------------------------------------------------------

resource "aws_sns_topic" "alerts" {
  name = "librechat-${var.environment}-alerts"
  tags = var.tags
}

# Optional: Email subscription (uncomment and set email)
# resource "aws_sns_topic_subscription" "email" {
#   topic_arn = aws_sns_topic.alerts.arn
#   protocol  = "email"
#   endpoint  = var.alert_email
# }

# -----------------------------------------------------------------------------
# Lambda Function Alarms
# -----------------------------------------------------------------------------

# Lambda Errors - triggers on any errors
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "librechat-${var.environment}-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  alarm_description   = "Lambda function errors exceed threshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = var.lambda_function_name
  }

  tags = var.tags
}

# Lambda Duration - detect slow responses
resource "aws_cloudwatch_metric_alarm" "lambda_duration" {
  alarm_name          = "librechat-${var.environment}-lambda-duration"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 300
  extended_statistic  = "p95"
  threshold           = 25000 # 25 seconds (API Gateway timeout is ~29s)
  alarm_description   = "Lambda p95 duration approaching API Gateway timeout"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = var.lambda_function_name
  }

  tags = var.tags
}

# Lambda Throttles
resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  alarm_name          = "librechat-${var.environment}-lambda-throttles"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Throttles"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "Lambda function is being throttled"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = var.lambda_function_name
  }

  tags = var.tags
}

# Lambda Concurrent Executions - approaching limit
resource "aws_cloudwatch_metric_alarm" "lambda_concurrent" {
  alarm_name          = "librechat-${var.environment}-lambda-concurrent"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ConcurrentExecutions"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.lambda_concurrency_threshold
  alarm_description   = "Lambda concurrent executions approaching limit"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = var.lambda_function_name
  }

  tags = var.tags
}

# -----------------------------------------------------------------------------
# API Gateway Alarms
# -----------------------------------------------------------------------------

# API Gateway 5xx Errors
resource "aws_cloudwatch_metric_alarm" "api_5xx_errors" {
  alarm_name          = "librechat-${var.environment}-api-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "5XXError"
  namespace           = "AWS/ApiGateway"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "API Gateway 5xx errors exceed threshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    ApiName = var.api_gateway_name
    Stage   = var.api_gateway_stage
  }

  tags = var.tags
}

# API Gateway 4xx Errors (high rate may indicate auth issues)
resource "aws_cloudwatch_metric_alarm" "api_4xx_errors" {
  alarm_name          = "librechat-${var.environment}-api-4xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "4XXError"
  namespace           = "AWS/ApiGateway"
  period              = 300
  statistic           = "Sum"
  threshold           = 100
  alarm_description   = "API Gateway 4xx errors elevated - possible auth or client issues"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    ApiName = var.api_gateway_name
    Stage   = var.api_gateway_stage
  }

  tags = var.tags
}

# API Gateway Latency (p95)
resource "aws_cloudwatch_metric_alarm" "api_latency" {
  alarm_name          = "librechat-${var.environment}-api-latency"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "Latency"
  namespace           = "AWS/ApiGateway"
  period              = 300
  extended_statistic  = "p95"
  threshold           = 10000 # 10 seconds
  alarm_description   = "API Gateway p95 latency is high"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    ApiName = var.api_gateway_name
    Stage   = var.api_gateway_stage
  }

  tags = var.tags
}

# -----------------------------------------------------------------------------
# ElastiCache Redis Alarms
# -----------------------------------------------------------------------------

# Redis CPU Utilization
resource "aws_cloudwatch_metric_alarm" "redis_cpu" {
  alarm_name          = "librechat-${var.environment}-redis-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Average"
  threshold           = 75
  alarm_description   = "Redis CPU utilization is high"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    CacheClusterId = var.redis_cluster_id
  }

  tags = var.tags
}

# Redis Memory Usage
resource "aws_cloudwatch_metric_alarm" "redis_memory" {
  alarm_name          = "librechat-${var.environment}-redis-memory"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "DatabaseMemoryUsagePercentage"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Redis memory usage is high"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    CacheClusterId = var.redis_cluster_id
  }

  tags = var.tags
}

# Redis Connection Count
resource "aws_cloudwatch_metric_alarm" "redis_connections" {
  alarm_name          = "librechat-${var.environment}-redis-connections"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CurrConnections"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Maximum"
  threshold           = var.redis_max_connections
  alarm_description   = "Redis connection count approaching limit"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    CacheClusterId = var.redis_cluster_id
  }

  tags = var.tags
}

# -----------------------------------------------------------------------------
# CloudWatch Dashboard
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "LibreChat-${var.environment}"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Lambda Invocations & Errors"
          region = var.region
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", var.lambda_function_name, { stat = "Sum", period = 60 }],
            [".", "Errors", ".", ".", { stat = "Sum", period = 60, color = "#d62728" }]
          ]
          view = "timeSeries"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Lambda Duration (ms)"
          region = var.region
          metrics = [
            ["AWS/Lambda", "Duration", "FunctionName", var.lambda_function_name, { stat = "p50", period = 60 }],
            ["...", { stat = "p95", period = 60, color = "#ff7f0e" }],
            ["...", { stat = "Maximum", period = 60, color = "#d62728" }]
          ]
          view = "timeSeries"
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "API Gateway Requests"
          region = var.region
          metrics = [
            ["AWS/ApiGateway", "Count", "ApiName", var.api_gateway_name, "Stage", var.api_gateway_stage, { stat = "Sum", period = 60 }],
            [".", "4XXError", ".", ".", ".", ".", { stat = "Sum", period = 60, color = "#ff7f0e" }],
            [".", "5XXError", ".", ".", ".", ".", { stat = "Sum", period = 60, color = "#d62728" }]
          ]
          view = "timeSeries"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "API Gateway Latency (ms)"
          region = var.region
          metrics = [
            ["AWS/ApiGateway", "Latency", "ApiName", var.api_gateway_name, "Stage", var.api_gateway_stage, { stat = "p50", period = 60 }],
            ["...", { stat = "p95", period = 60, color = "#ff7f0e" }]
          ]
          view = "timeSeries"
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "Redis CPU & Memory"
          region = var.region
          metrics = [
            ["AWS/ElastiCache", "CPUUtilization", "CacheClusterId", var.redis_cluster_id, { stat = "Average", period = 60 }],
            [".", "DatabaseMemoryUsagePercentage", ".", ".", { stat = "Average", period = 60, color = "#ff7f0e" }]
          ]
          view = "timeSeries"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "Redis Connections"
          region = var.region
          metrics = [
            ["AWS/ElastiCache", "CurrConnections", "CacheClusterId", var.redis_cluster_id, { stat = "Maximum", period = 60 }]
          ]
          view = "timeSeries"
        }
      }
    ]
  })
}
