# Frontend Module - S3 + CloudFront with dual origins
# Purpose: CDN for unified routing to S3 frontend and API Gateway backend

# -----------------------------------------------------------------------------
# S3 Bucket for Frontend Assets
# -----------------------------------------------------------------------------

module "s3_frontend" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "~> 4.0"

  bucket        = "librechat-frontend-${var.environment}"
  force_destroy = true

  versioning = {
    enabled = false
  }

  # Block all public access (OAC only)
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

  tags = var.tags
}

# -----------------------------------------------------------------------------
# CloudFront Origin Access Control for S3
# -----------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "s3_oac" {
  name                              = "librechat-s3-oac-${var.environment}"
  description                       = "OAC for LibreChat frontend S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# -----------------------------------------------------------------------------
# S3 Bucket Policy for CloudFront OAC
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "s3_policy" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${module.s3_frontend.s3_bucket_arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.main.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = module.s3_frontend.s3_bucket_id
  policy = data.aws_iam_policy_document.s3_policy.json
}

# -----------------------------------------------------------------------------
# Extract API Gateway domain from invoke URL
# -----------------------------------------------------------------------------

locals {
  # Parse API Gateway domain from invoke URL (e.g., https://abc123.execute-api.eu-west-1.amazonaws.com/prod)
  # REST API v1 with /prod stage - strip protocol and stage path suffix
  api_gateway_domain = replace(replace(var.api_gateway_endpoint, "https://", ""), "/prod", "")
}

# -----------------------------------------------------------------------------
# CloudFront Distribution (native resource for full control)
# -----------------------------------------------------------------------------

resource "aws_cloudfront_distribution" "main" {
  aliases             = [var.custom_domain]
  comment             = "LibreChat CDN - ${var.environment}"
  enabled             = true
  is_ipv6_enabled     = true
  price_class         = "PriceClass_100"
  retain_on_delete    = false
  wait_for_deployment = false

  # S3 Origin (frontend)
  origin {
    origin_id                = "s3_frontend"
    domain_name              = module.s3_frontend.s3_bucket_bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.s3_oac.id
  }

  # API Gateway Origin (REST API v1 with /prod stage)
  origin {
    origin_id   = "api_gateway"
    domain_name = local.api_gateway_domain
    origin_path = "/prod"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Default behavior: S3 frontend
  default_cache_behavior {
    target_origin_id       = "s3_frontend"
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]
    compress        = true

    # CachingOptimized managed policy
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # /api/* behavior: API Gateway
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "api_gateway"
    viewer_protocol_policy = "https-only"

    allowed_methods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods  = ["GET", "HEAD"]
    compress        = true

    # CachingDisabled managed policy
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"

    # AllViewerExceptHostHeader managed policy
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  # /oauth/* behavior: API Gateway (OpenID Connect authentication)
  ordered_cache_behavior {
    path_pattern           = "/oauth/*"
    target_origin_id       = "api_gateway"
    viewer_protocol_policy = "https-only"

    allowed_methods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods  = ["GET", "HEAD"]
    compress        = true

    # CachingDisabled managed policy
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"

    # AllViewerExceptHostHeader managed policy
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  # SSL Certificate
  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  # SPA routing: 404 -> index.html
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  # Geo restrictions (none)
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  tags = var.tags
}

# -----------------------------------------------------------------------------
# Route53 A Record (alias to CloudFront)
# -----------------------------------------------------------------------------

resource "aws_route53_record" "cloudfront" {
  zone_id = var.route53_zone_id
  name    = var.custom_domain
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

# Route53 AAAA Record for IPv6
resource "aws_route53_record" "cloudfront_ipv6" {
  zone_id = var.route53_zone_id
  name    = var.custom_domain
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}
