# API Gateway Module - REST API (v1) with Lambda proxy integration
# ALL endpoints use streaming mode because Lambda handler uses awslambda.streamifyResponse()
# Non-streaming endpoints write buffered response, streaming endpoints pipe SSE chunks

# -----------------------------------------------------------------------------
# REST API (v1) - Required for streaming support
# -----------------------------------------------------------------------------

resource "aws_api_gateway_rest_api" "api" {
  name        = "librechat-rest-api-${var.environment}"
  description = "LibreChat REST API with streaming support"

  endpoint_configuration {
    types = ["REGIONAL"]
  }

  tags = var.tags
}

# -----------------------------------------------------------------------------
# API Resources: /api hierarchy
# -----------------------------------------------------------------------------

resource "aws_api_gateway_resource" "api" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_rest_api.api.root_resource_id
  path_part   = "api"
}

# Standard catch-all: /api/{proxy+} - uses standard Lambda invocation
resource "aws_api_gateway_resource" "api_proxy" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "{proxy+}"
}

# -----------------------------------------------------------------------------
# Streaming Resources: /api/ask, /api/chat, /api/agents hierarchies
# These specific paths take precedence over the catch-all {proxy+}
# -----------------------------------------------------------------------------

# /api/ask resource
resource "aws_api_gateway_resource" "api_ask" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "ask"
}

resource "aws_api_gateway_resource" "api_ask_proxy" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.api_ask.id
  path_part   = "{proxy+}"
}

# /api/chat resource
resource "aws_api_gateway_resource" "api_chat" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "chat"
}

resource "aws_api_gateway_resource" "api_chat_proxy" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.api_chat.id
  path_part   = "{proxy+}"
}

# /api/agents resource
resource "aws_api_gateway_resource" "api_agents" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "agents"
}

resource "aws_api_gateway_resource" "api_agents_proxy" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.api_agents.id
  path_part   = "{proxy+}"
}

# -----------------------------------------------------------------------------
# API Resources: /oauth/{proxy+} - Required for OpenID Connect authentication
# -----------------------------------------------------------------------------

resource "aws_api_gateway_resource" "oauth" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_rest_api.api.root_resource_id
  path_part   = "oauth"
}

resource "aws_api_gateway_resource" "oauth_proxy" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_resource.oauth.id
  path_part   = "{proxy+}"
}

# -----------------------------------------------------------------------------
# Methods: Standard API endpoints (non-streaming)
# -----------------------------------------------------------------------------

resource "aws_api_gateway_method" "api_root" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.api.id
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_method" "api_proxy" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.api_proxy.id
  http_method   = "ANY"
  authorization = "NONE"
}

# -----------------------------------------------------------------------------
# Methods: Streaming API endpoints (SSE)
# -----------------------------------------------------------------------------

resource "aws_api_gateway_method" "api_ask" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.api_ask.id
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_method" "api_ask_proxy" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.api_ask_proxy.id
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_method" "api_chat" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.api_chat.id
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_method" "api_chat_proxy" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.api_chat_proxy.id
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_method" "api_agents" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.api_agents.id
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_method" "api_agents_proxy" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.api_agents_proxy.id
  http_method   = "ANY"
  authorization = "NONE"
}

# -----------------------------------------------------------------------------
# Methods: OAuth endpoints (standard)
# -----------------------------------------------------------------------------

resource "aws_api_gateway_method" "oauth_root" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.oauth.id
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_method" "oauth_proxy" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.oauth_proxy.id
  http_method   = "ANY"
  authorization = "NONE"
}

# -----------------------------------------------------------------------------
# Lambda Integrations: ALL use streaming mode (handler uses streamifyResponse)
# Non-SSE endpoints write buffered response immediately, SSE endpoints stream chunks
# -----------------------------------------------------------------------------

# Non-streaming endpoints use standard Lambda proxy integration
# This ensures response bodies are properly delivered for non-SSE endpoints
resource "aws_api_gateway_integration" "api_root" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.api.id
  http_method             = aws_api_gateway_method.api_root.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = "arn:aws:apigateway:${var.region}:lambda:path/2015-03-31/functions/${var.lambda_function_arn}/invocations"
  timeout_milliseconds    = 29000
}

resource "aws_api_gateway_integration" "api_proxy" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.api_proxy.id
  http_method             = aws_api_gateway_method.api_proxy.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = "arn:aws:apigateway:${var.region}:lambda:path/2015-03-31/functions/${var.lambda_function_arn}/invocations"
  timeout_milliseconds    = 29000
}

# -----------------------------------------------------------------------------
# Lambda Integrations: Streaming for /api/ask/*, /api/chat/*, /api/agents/*
# Uses response-streaming-invocations for SSE support
# -----------------------------------------------------------------------------

resource "aws_api_gateway_integration" "api_ask" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.api_ask.id
  http_method             = aws_api_gateway_method.api_ask.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = "arn:aws:apigateway:${var.region}:lambda:path/2021-11-15/functions/${var.lambda_streaming_function_arn}/response-streaming-invocations"
  response_transfer_mode  = "STREAM"
  timeout_milliseconds    = 900000
}

resource "aws_api_gateway_integration" "api_ask_proxy" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.api_ask_proxy.id
  http_method             = aws_api_gateway_method.api_ask_proxy.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = "arn:aws:apigateway:${var.region}:lambda:path/2021-11-15/functions/${var.lambda_streaming_function_arn}/response-streaming-invocations"
  response_transfer_mode  = "STREAM"
  timeout_milliseconds    = 900000
}

resource "aws_api_gateway_integration" "api_chat" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.api_chat.id
  http_method             = aws_api_gateway_method.api_chat.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = "arn:aws:apigateway:${var.region}:lambda:path/2021-11-15/functions/${var.lambda_streaming_function_arn}/response-streaming-invocations"
  response_transfer_mode  = "STREAM"
  timeout_milliseconds    = 900000
}

resource "aws_api_gateway_integration" "api_chat_proxy" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.api_chat_proxy.id
  http_method             = aws_api_gateway_method.api_chat_proxy.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = "arn:aws:apigateway:${var.region}:lambda:path/2021-11-15/functions/${var.lambda_streaming_function_arn}/response-streaming-invocations"
  response_transfer_mode  = "STREAM"
  timeout_milliseconds    = 900000
}

resource "aws_api_gateway_integration" "api_agents" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.api_agents.id
  http_method             = aws_api_gateway_method.api_agents.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = "arn:aws:apigateway:${var.region}:lambda:path/2021-11-15/functions/${var.lambda_streaming_function_arn}/response-streaming-invocations"
  response_transfer_mode  = "STREAM"
  timeout_milliseconds    = 900000
}

resource "aws_api_gateway_integration" "api_agents_proxy" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.api_agents_proxy.id
  http_method             = aws_api_gateway_method.api_agents_proxy.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = "arn:aws:apigateway:${var.region}:lambda:path/2021-11-15/functions/${var.lambda_streaming_function_arn}/response-streaming-invocations"
  response_transfer_mode  = "STREAM"
  timeout_milliseconds    = 900000
}

# -----------------------------------------------------------------------------
# Lambda Integrations for OAuth (standard invocation - no streaming needed)
# -----------------------------------------------------------------------------

resource "aws_api_gateway_integration" "oauth_root" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.oauth.id
  http_method             = aws_api_gateway_method.oauth_root.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = "arn:aws:apigateway:${var.region}:lambda:path/2015-03-31/functions/${var.lambda_function_arn}/invocations"
  timeout_milliseconds    = 29000
}

resource "aws_api_gateway_integration" "oauth_proxy" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.oauth_proxy.id
  http_method             = aws_api_gateway_method.oauth_proxy.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = "arn:aws:apigateway:${var.region}:lambda:path/2015-03-31/functions/${var.lambda_function_arn}/invocations"
  timeout_milliseconds    = 29000
}

# -----------------------------------------------------------------------------
# CORS Support - OPTIONS for /api and /api/{proxy+}
# -----------------------------------------------------------------------------

resource "aws_api_gateway_method" "api_root_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.api.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_method" "api_proxy_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.api_proxy.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "api_root_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api.id
  http_method = aws_api_gateway_method.api_root_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_integration" "api_proxy_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_proxy.id
  http_method = aws_api_gateway_method.api_proxy_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "api_root_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api.id
  http_method = aws_api_gateway_method.api_root_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_method_response" "api_proxy_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_proxy.id
  http_method = aws_api_gateway_method.api_proxy_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "api_root_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api.id
  http_method = aws_api_gateway_method.api_root_options.http_method
  status_code = aws_api_gateway_method_response.api_root_options.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,Cookie'"
    "method.response.header.Access-Control-Allow-Methods" = "'DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT'"
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }
}

resource "aws_api_gateway_integration_response" "api_proxy_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_proxy.id
  http_method = aws_api_gateway_method.api_proxy_options.http_method
  status_code = aws_api_gateway_method_response.api_proxy_options.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,Cookie'"
    "method.response.header.Access-Control-Allow-Methods" = "'DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT'"
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }
}

# -----------------------------------------------------------------------------
# CORS Support - OPTIONS for streaming endpoints
# -----------------------------------------------------------------------------

# /api/ask OPTIONS
resource "aws_api_gateway_method" "api_ask_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.api_ask.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_method" "api_ask_proxy_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.api_ask_proxy.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "api_ask_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_ask.id
  http_method = aws_api_gateway_method.api_ask_options.http_method
  type        = "MOCK"
  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_integration" "api_ask_proxy_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_ask_proxy.id
  http_method = aws_api_gateway_method.api_ask_proxy_options.http_method
  type        = "MOCK"
  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "api_ask_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_ask.id
  http_method = aws_api_gateway_method.api_ask_options.http_method
  status_code = "200"
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_method_response" "api_ask_proxy_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_ask_proxy.id
  http_method = aws_api_gateway_method.api_ask_proxy_options.http_method
  status_code = "200"
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "api_ask_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_ask.id
  http_method = aws_api_gateway_method.api_ask_options.http_method
  status_code = aws_api_gateway_method_response.api_ask_options.status_code
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,Cookie'"
    "method.response.header.Access-Control-Allow-Methods" = "'DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT'"
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }
}

resource "aws_api_gateway_integration_response" "api_ask_proxy_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_ask_proxy.id
  http_method = aws_api_gateway_method.api_ask_proxy_options.http_method
  status_code = aws_api_gateway_method_response.api_ask_proxy_options.status_code
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,Cookie'"
    "method.response.header.Access-Control-Allow-Methods" = "'DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT'"
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }
}

# /api/chat OPTIONS
resource "aws_api_gateway_method" "api_chat_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.api_chat.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_method" "api_chat_proxy_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.api_chat_proxy.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "api_chat_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_chat.id
  http_method = aws_api_gateway_method.api_chat_options.http_method
  type        = "MOCK"
  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_integration" "api_chat_proxy_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_chat_proxy.id
  http_method = aws_api_gateway_method.api_chat_proxy_options.http_method
  type        = "MOCK"
  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "api_chat_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_chat.id
  http_method = aws_api_gateway_method.api_chat_options.http_method
  status_code = "200"
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_method_response" "api_chat_proxy_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_chat_proxy.id
  http_method = aws_api_gateway_method.api_chat_proxy_options.http_method
  status_code = "200"
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "api_chat_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_chat.id
  http_method = aws_api_gateway_method.api_chat_options.http_method
  status_code = aws_api_gateway_method_response.api_chat_options.status_code
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,Cookie'"
    "method.response.header.Access-Control-Allow-Methods" = "'DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT'"
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }
}

resource "aws_api_gateway_integration_response" "api_chat_proxy_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_chat_proxy.id
  http_method = aws_api_gateway_method.api_chat_proxy_options.http_method
  status_code = aws_api_gateway_method_response.api_chat_proxy_options.status_code
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,Cookie'"
    "method.response.header.Access-Control-Allow-Methods" = "'DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT'"
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }
}

# /api/agents OPTIONS
resource "aws_api_gateway_method" "api_agents_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.api_agents.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_method" "api_agents_proxy_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.api_agents_proxy.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "api_agents_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_agents.id
  http_method = aws_api_gateway_method.api_agents_options.http_method
  type        = "MOCK"
  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_integration" "api_agents_proxy_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_agents_proxy.id
  http_method = aws_api_gateway_method.api_agents_proxy_options.http_method
  type        = "MOCK"
  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "api_agents_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_agents.id
  http_method = aws_api_gateway_method.api_agents_options.http_method
  status_code = "200"
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_method_response" "api_agents_proxy_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_agents_proxy.id
  http_method = aws_api_gateway_method.api_agents_proxy_options.http_method
  status_code = "200"
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "api_agents_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_agents.id
  http_method = aws_api_gateway_method.api_agents_options.http_method
  status_code = aws_api_gateway_method_response.api_agents_options.status_code
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,Cookie'"
    "method.response.header.Access-Control-Allow-Methods" = "'DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT'"
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }
}

resource "aws_api_gateway_integration_response" "api_agents_proxy_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.api_agents_proxy.id
  http_method = aws_api_gateway_method.api_agents_proxy_options.http_method
  status_code = aws_api_gateway_method_response.api_agents_proxy_options.status_code
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,Cookie'"
    "method.response.header.Access-Control-Allow-Methods" = "'DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT'"
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }
}

# -----------------------------------------------------------------------------
# CORS Support - OPTIONS for OAuth routes
# -----------------------------------------------------------------------------

resource "aws_api_gateway_method" "oauth_root_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.oauth.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_method" "oauth_proxy_options" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.oauth_proxy.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "oauth_root_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.oauth.id
  http_method = aws_api_gateway_method.oauth_root_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_integration" "oauth_proxy_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.oauth_proxy.id
  http_method = aws_api_gateway_method.oauth_proxy_options.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "oauth_root_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.oauth.id
  http_method = aws_api_gateway_method.oauth_root_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_method_response" "oauth_proxy_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.oauth_proxy.id
  http_method = aws_api_gateway_method.oauth_proxy_options.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "oauth_root_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.oauth.id
  http_method = aws_api_gateway_method.oauth_root_options.http_method
  status_code = aws_api_gateway_method_response.oauth_root_options.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,Cookie'"
    "method.response.header.Access-Control-Allow-Methods" = "'DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT'"
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }
}

resource "aws_api_gateway_integration_response" "oauth_proxy_options" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.oauth_proxy.id
  http_method = aws_api_gateway_method.oauth_proxy_options.http_method
  status_code = aws_api_gateway_method_response.oauth_proxy_options.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,Cookie'"
    "method.response.header.Access-Control-Allow-Methods" = "'DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT'"
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }
}

# -----------------------------------------------------------------------------
# Deployment and Stage
# -----------------------------------------------------------------------------

resource "aws_api_gateway_deployment" "api" {
  rest_api_id = aws_api_gateway_rest_api.api.id

  depends_on = [
    aws_api_gateway_integration.api_root,
    aws_api_gateway_integration.api_proxy,
    aws_api_gateway_integration.api_root_options,
    aws_api_gateway_integration.api_proxy_options,
    aws_api_gateway_integration.api_ask,
    aws_api_gateway_integration.api_ask_proxy,
    aws_api_gateway_integration.api_ask_options,
    aws_api_gateway_integration.api_ask_proxy_options,
    aws_api_gateway_integration.api_chat,
    aws_api_gateway_integration.api_chat_proxy,
    aws_api_gateway_integration.api_chat_options,
    aws_api_gateway_integration.api_chat_proxy_options,
    aws_api_gateway_integration.api_agents,
    aws_api_gateway_integration.api_agents_proxy,
    aws_api_gateway_integration.api_agents_options,
    aws_api_gateway_integration.api_agents_proxy_options,
    aws_api_gateway_integration.oauth_root,
    aws_api_gateway_integration.oauth_proxy,
    aws_api_gateway_integration.oauth_root_options,
    aws_api_gateway_integration.oauth_proxy_options
  ]

  # Force new deployment when integrations change
  # IMPORTANT: Include integration URIs so deployment triggers when Lambda ARN changes
  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_resource.api.id,
      aws_api_gateway_resource.api_proxy.id,
      aws_api_gateway_resource.api_ask.id,
      aws_api_gateway_resource.api_ask_proxy.id,
      aws_api_gateway_resource.api_chat.id,
      aws_api_gateway_resource.api_chat_proxy.id,
      aws_api_gateway_resource.api_agents.id,
      aws_api_gateway_resource.api_agents_proxy.id,
      aws_api_gateway_resource.oauth.id,
      aws_api_gateway_resource.oauth_proxy.id,
      aws_api_gateway_method.api_root.id,
      aws_api_gateway_method.api_proxy.id,
      aws_api_gateway_method.api_ask.id,
      aws_api_gateway_method.api_ask_proxy.id,
      aws_api_gateway_method.api_chat.id,
      aws_api_gateway_method.api_chat_proxy.id,
      aws_api_gateway_method.api_agents.id,
      aws_api_gateway_method.api_agents_proxy.id,
      aws_api_gateway_method.oauth_root.id,
      aws_api_gateway_method.oauth_proxy.id,
      aws_api_gateway_integration.api_root.id,
      aws_api_gateway_integration.api_proxy.id,
      aws_api_gateway_integration.api_ask.id,
      aws_api_gateway_integration.api_ask_proxy.id,
      aws_api_gateway_integration.api_chat.id,
      aws_api_gateway_integration.api_chat_proxy.id,
      aws_api_gateway_integration.api_agents.id,
      aws_api_gateway_integration.api_agents_proxy.id,
      aws_api_gateway_integration.oauth_root.id,
      aws_api_gateway_integration.oauth_proxy.id,
      # Include URIs so deployment triggers when Lambda ARN changes
      aws_api_gateway_integration.api_root.uri,
      aws_api_gateway_integration.api_proxy.uri,
      aws_api_gateway_integration.api_ask.uri,
      aws_api_gateway_integration.api_ask_proxy.uri,
      aws_api_gateway_integration.api_chat.uri,
      aws_api_gateway_integration.api_chat_proxy.uri,
      aws_api_gateway_integration.api_agents.uri,
      aws_api_gateway_integration.api_agents_proxy.uri,
      aws_api_gateway_integration.oauth_root.uri,
      aws_api_gateway_integration.oauth_proxy.uri
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "prod" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  deployment_id = aws_api_gateway_deployment.api.id
  stage_name    = "prod"

  tags = var.tags
}

# -----------------------------------------------------------------------------
# Lambda Permission
# -----------------------------------------------------------------------------

# Streaming permission for SSE endpoints (chat, ask, agents)
# Uses the dedicated streaming Lambda function
resource "aws_lambda_permission" "api_gateway_streaming" {
  statement_id  = "AllowAPIGatewayInvokeWithStreaming"
  action        = "lambda:InvokeFunctionWithResponseStreaming"
  function_name = var.lambda_streaming_function_arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/*"
}

# Standard invoke permission for streaming Lambda (required for AWS_PROXY integration)
resource "aws_lambda_permission" "api_gateway_streaming_invoke" {
  statement_id  = "AllowAPIGatewayInvokeStreaming"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_streaming_function_arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/*"
}

# Standard invoke permission (required for API Gateway to invoke Lambda)
resource "aws_lambda_permission" "api_gateway_standard" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_function_arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/*"
}
