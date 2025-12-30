# Deployment Runbook: AWS Serverless LibreChat

**Branch**: `001-aws-serverless-deploy` | **Last Updated**: 2025-12-26

## Architecture Overview

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                    CloudFront                            │
                    │         lambda-test.sandbox.data.apro.is                 │
                    └────────────────────┬────────────────────────────────────┘
                                         │
                    ┌────────────────────┴────────────────────┐
                    │                                         │
                    ▼                                         ▼
            ┌───────────────┐                      ┌────────────────────┐
            │   S3 Bucket   │                      │   API Gateway      │
            │   (Frontend)  │                      │   REST API (v1)    │
            │   /*, !/api/* │                      │   /api/*           │
            └───────────────┘                      └─────────┬──────────┘
                                                             │
                                                             ▼
                                                  ┌────────────────────┐
                                                  │   Lambda Function  │
                                                  │   (Container)      │
                                                  │   aws-lambda-ric   │
                                                  └─────────┬──────────┘
                                                            │
                              ┌──────────────────┬──────────┴──────────┬──────────────────┐
                              │                  │                     │                  │
                              ▼                  ▼                     ▼                  ▼
                       ┌──────────┐       ┌──────────┐         ┌──────────┐       ┌──────────┐
                       │ Redis    │       │DocumentDB│         │ Cloud Map│       │   SSM    │
                       │(session) │       │(MongoDB) │         │   DNS    │       │Parameters│
                       └──────────┘       └──────────┘         └──────────┘       └──────────┘
```

## Prerequisites

### Required Tools

```bash
# Verify all tools are installed
aws --version          # >= 2.0
terraform --version    # >= 1.5.0
docker --version       # >= 20.0
task --version         # go-task
```

### AWS Access

- **Profile**: `apro-datalake-sandbox`
- **Region**: `eu-west-1`
- **VPC**: `vpc-05e4efdfad1c2252a`

```bash
# Login to AWS SSO
task login:dev

# Verify credentials
aws sts get-caller-identity --profile apro-datalake-sandbox
```

---

## Initial Deployment (First Time)

### Step 1: Initialize Terraform

```bash
# From repository root
task init:dev
```

This initializes Terraform with the S3 backend configuration.

### Step 2: Plan and Review Changes

```bash
task plan:dev
```

Review the plan output carefully. Initial deployment creates:
- ECR repository
- Lambda function with VPC configuration
- API Gateway REST API with streaming
- S3 bucket for frontend
- CloudFront distribution
- ElastiCache Redis cluster
- CloudWatch alarms and dashboard

### Step 3: Apply Infrastructure

```bash
task apply:dev
```

**Note**: Initial deployment takes ~15-20 minutes, primarily waiting for:
- ElastiCache Redis cluster creation (~10 min)
- CloudFront distribution deployment (~5-10 min)

### Step 4: Deploy Frontend

After infrastructure is deployed, sync the frontend:

```bash
# Build frontend (from LibreChat root)
npm run frontend

# Get S3 bucket and CloudFront distribution ID
task output:dev

# Sync to S3
aws s3 sync client/dist/ s3://librechat-frontend-dev-<ACCOUNT_ID>/ \
  --profile apro-datalake-sandbox

# Invalidate CloudFront cache
aws cloudfront create-invalidation \
  --distribution-id <DISTRIBUTION_ID> \
  --paths "/*" \
  --profile apro-datalake-sandbox
```

---

## Code Update Workflow

### Lambda Code Updates

Lambda container updates are handled automatically by Terraform:

```bash
# 1. Make changes to handler.js or Dockerfile
cd infrastructure/terraform/modules/backend/docker

# 2. Plan and apply (Terraform builds and pushes automatically)
task plan:dev
task apply:dev
```

Terraform automatically:
1. Builds Docker image with `kreuzwerker/docker` provider
2. Pushes to ECR
3. Updates Lambda function code
4. Uses SHA256 digest for immutable deployments

### Manual Docker Build (Optional)

For local testing or debugging:

```bash
task docker:build

# Or manually:
cd infrastructure/terraform/modules/backend/docker
docker build -t librechat-lambda-api:latest --platform linux/amd64 .
```

### Frontend Updates

```bash
# Build frontend
npm run frontend

# Sync to S3 (get bucket name from terraform output)
aws s3 sync client/dist/ s3://<BUCKET_NAME>/ --profile apro-datalake-sandbox

# Invalidate CloudFront
aws cloudfront create-invalidation \
  --distribution-id <DISTRIBUTION_ID> \
  --paths "/*" \
  --profile apro-datalake-sandbox
```

---

## Terraform Commands Reference

| Command | Description |
|---------|-------------|
| `task init:dev` | Initialize Terraform backend |
| `task plan:dev` | Plan infrastructure changes |
| `task apply:dev` | Apply infrastructure changes |
| `task output:dev` | Show all outputs |
| `task destroy:dev` | Destroy all resources |
| `task validate:dev` | Validate configuration |
| `task refresh:dev` | Refresh state |
| `task clean:dev` | Remove .terraform directory |
| `task fmt` | Format all Terraform files |
| `task list` | List available environments |

---

## Key Outputs

After deployment, retrieve important values:

```bash
task output:dev

# Individual outputs
task output:dev -- api_gateway_invoke_url
task output:dev -- cloudfront_domain_name
task output:dev -- frontend_bucket_name
task output:dev -- lambda_function_name
task output:dev -- redis_endpoint
```

### Current Endpoints

| Resource | Endpoint |
|----------|----------|
| CloudFront | `lambda-test.sandbox.data.apro.is` |
| API Gateway | `https://<API_ID>.execute-api.eu-west-1.amazonaws.com/prod` |
| Redis | `librechat-lambda-redis-dev.llyaoy.ng.0001.euw1.cache.amazonaws.com:6379` |

---

## Monitoring

### CloudWatch Dashboard

Access the monitoring dashboard:
1. Go to AWS CloudWatch Console (eu-west-1)
2. Dashboards -> `LibreChat-dev`

Dashboard includes:
- Lambda invocations, errors, duration
- API Gateway requests, 4xx, 5xx
- Redis CPU, memory, connections

### CloudWatch Alarms

| Alarm | Threshold | Description |
|-------|-----------|-------------|
| Lambda Errors | > 5 in 5 min | Function errors |
| Lambda Duration | > 10s avg | Slow responses |
| Lambda Throttles | > 0 | Throttling events |
| Lambda Concurrent | > 50 | High concurrency |
| API 5xx Errors | > 1% | Server errors |
| API 4xx Errors | > 10% | Client errors |
| API Latency | > 5000ms | High latency |
| Redis CPU | > 75% | CPU utilization |
| Redis Memory | > 80% | Memory pressure |
| Redis Connections | > 100 | Connection count |

### Log Groups

```bash
# Lambda logs
aws logs tail /aws/lambda/librechat-api-dev --follow --profile apro-datalake-sandbox

# API Gateway logs (if enabled)
aws logs tail API-Gateway-Execution-Logs_<API_ID>/prod --follow --profile apro-datalake-sandbox
```

### CloudWatch Logs Insights Queries

```sql
-- Recent errors
fields @timestamp, @message
| filter @message like /error|Error|ERROR/
| sort @timestamp desc
| limit 50

-- Redis connections
fields @timestamp, @message
| filter @message like /redis|Redis|ioredis/
| sort @timestamp desc
| limit 20

-- Cold starts
fields @timestamp, @message, @duration
| filter @type = "REPORT"
| filter @duration > 1000
| sort @timestamp desc
| limit 20
```

---

## Troubleshooting

### Lambda Timeout / 502 Errors

1. Check Lambda logs for errors:
   ```bash
   aws logs tail /aws/lambda/librechat-api-dev --since 5m --profile apro-datalake-sandbox
   ```

2. Verify Lambda has VPC access to dependencies:
   - DocumentDB
   - Redis
   - Cloud Map DNS

3. Check memory/timeout settings:
   ```bash
   aws lambda get-function-configuration \
     --function-name librechat-api-dev \
     --profile apro-datalake-sandbox
   ```

### SSE Streaming Issues

1. Verify API Gateway uses streaming integration:
   ```bash
   # Check integration URI ends with /response-streaming-invocations
   aws apigateway get-integration \
     --rest-api-id <API_ID> \
     --resource-id <RESOURCE_ID> \
     --http-method ANY \
     --profile apro-datalake-sandbox
   ```

2. Test streaming endpoint directly:
   ```bash
   curl -N "https://lambda-test.sandbox.data.apro.is/api/health"
   ```

### Redis Connection Failures

1. Check Redis cluster status:
   ```bash
   aws elasticache describe-cache-clusters \
     --cache-cluster-id librechat-lambda-redis-dev-001 \
     --profile apro-datalake-sandbox
   ```

2. Verify security group rules allow Lambda -> Redis (port 6379)

3. Check Lambda environment variables:
   ```bash
   aws lambda get-function-configuration \
     --function-name librechat-api-dev \
     --query 'Environment.Variables' \
     --profile apro-datalake-sandbox
   ```

### CloudFront Cache Issues

```bash
# Create cache invalidation
aws cloudfront create-invalidation \
  --distribution-id <DISTRIBUTION_ID> \
  --paths "/*" \
  --profile apro-datalake-sandbox

# Check invalidation status
aws cloudfront list-invalidations \
  --distribution-id <DISTRIBUTION_ID> \
  --profile apro-datalake-sandbox
```

---

## Rollback Procedures

### Lambda Rollback

Lambda versions are immutable (using SHA256 digest). To rollback:

```bash
# Get previous image digest from ECR
aws ecr describe-images \
  --repository-name librechat-lambda-api-dev \
  --profile apro-datalake-sandbox

# Update Lambda to previous image
aws lambda update-function-code \
  --function-name librechat-api-dev \
  --image-uri <ACCOUNT>.dkr.ecr.eu-west-1.amazonaws.com/librechat-lambda-api-dev@sha256:<PREVIOUS_DIGEST> \
  --profile apro-datalake-sandbox
```

### Infrastructure Rollback

Use Terraform state to rollback:

```bash
# View state history
task output:dev

# Rollback to previous state (if using S3 versioning)
# Restore previous state file from S3 bucket versioning
```

### Frontend Rollback

```bash
# List S3 versions (if versioning enabled)
aws s3api list-object-versions \
  --bucket <BUCKET_NAME> \
  --profile apro-datalake-sandbox

# Or redeploy from Git
git checkout <previous-commit>
npm run frontend
aws s3 sync client/dist/ s3://<BUCKET_NAME>/ --profile apro-datalake-sandbox
```

---

## Destroy Environment

**Warning**: This destroys all resources including data!

```bash
# Plan destruction
task plan:dev  # Review what will be destroyed

# Destroy
task destroy:dev
```

ECR images are retained with `force_delete = true`. To fully clean up:

```bash
aws ecr delete-repository \
  --repository-name librechat-lambda-api-dev \
  --force \
  --profile apro-datalake-sandbox
```

---

## Environment Variables Reference

Lambda environment variables set by Terraform:

| Variable | Source | Description |
|----------|--------|-------------|
| `USE_REDIS` | Hardcoded | Enable Redis sessions |
| `REDIS_URI` | Module output | Redis connection string |
| `CONFIG_S3_BUCKET` | Variable | S3 bucket for librechat.yaml |
| `CONFIG_S3_KEY` | Variable | S3 key for config file |
| `CLOUD_MAP_NAMESPACE` | Variable | Service discovery namespace |

Additional variables from SSM Parameters (`/ecs/genai/*`):
- Database credentials
- API keys
- Service endpoints

---

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Lambda runtime | Container | Consistent with local dev, easier debugging |
| API Gateway | REST API v1 | Supports streaming (HTTP API v2 does not for Lambda) |
| Redis | ElastiCache (non-serverless) | Cost effective for dev, cluster mode disabled |
| Streaming | aws-lambda-ric | Native Lambda streaming support |
| Docker build | Terraform provider | Atomic deployments, SHA256 pinning |

---

## Cost Considerations

Monthly estimated costs (dev environment):

| Resource | Est. Cost |
|----------|-----------|
| Lambda | ~$5-20 (usage based) |
| API Gateway | ~$5-10 (usage based) |
| CloudFront | ~$5-10 (usage based) |
| S3 | < $1 |
| ElastiCache (cache.t4g.micro) | ~$12 |
| CloudWatch | ~$5 |
| **Total** | **~$30-60/month** |

---

## Contact

For issues with this deployment, check:
1. CloudWatch logs
2. CloudWatch alarms
3. SNS topic: `librechat-dev-alerts`
