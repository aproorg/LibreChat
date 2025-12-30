# Quickstart: AWS Serverless Deployment (Simplified Architecture)

**Branch**: `001-aws-serverless-deploy` | **Date**: 2025-12-25
**Status**: Updated - Simplified architecture

## Overview

This guide provides validation steps for the simplified AWS serverless architecture:
- **Single Lambda function** with aws-lambda-ric (not Lambda Web Adapter)
- **Single API Gateway REST API** (v1) for all endpoints including streaming
- **ElastiCache Redis** for session storage (cluster mode disabled)
- **CloudFront** with dual origins (S3 frontend, API Gateway backend)

---

## Prerequisites

### Required AWS Access
- AWS CLI configured with appropriate permissions
- Access to create: Lambda, API Gateway, S3, CloudFront, ElastiCache, ECR
- Access to existing VPC: `vpc-05e4efdfad1c2252a` (eu-west-1)
- Read access to SSM parameters under `/ecs/genai/*`

### Required Tools
```bash
# Verify AWS CLI
aws --version  # >= 2.0

# Verify Terraform
terraform --version  # >= 1.0

# Verify Docker (for Lambda container build)
docker --version  # >= 20.0

# Verify Node.js (for local testing)
node --version  # >= 20
```

---

## Validation Checklist

### 1. AWS Service Availability (eu-west-1)

```bash
# Check Lambda response streaming availability
aws lambda list-functions --region eu-west-1 --query 'Functions[0].FunctionName'

# Check ElastiCache Redis availability
aws elasticache describe-cache-clusters --region eu-west-1 --query 'CacheClusters[0].CacheClusterId'

# Verify API Gateway REST API capability
aws apigateway get-rest-apis --region eu-west-1 --query 'items[0].name'
```

**Expected**: All commands succeed without errors.

---

### 2. Lambda Quotas Verification

```bash
# Check current Lambda quotas
aws service-quotas get-service-quota \
  --service-code lambda \
  --quota-code L-B99A9384 \
  --region eu-west-1

# Output should show concurrent executions limit
# Default: 1000, request increase if needed
```

**Required Quotas**:
| Quota | Minimum Required | Purpose |
|-------|------------------|---------|
| Concurrent executions | 100 | Handle traffic |
| Function timeout | 900s | SSE streaming |
| Memory | 1024 MB | Performance |

---

### 3. VPC Connectivity Test

Verify Lambda can access required VPC resources:

```bash
# Test DocumentDB connectivity (from Lambda VPC)
nc -zv aprochat-dev-genai-docdb-cluster.cluster-cx8ui6sy4sn2.eu-west-1.docdb.amazonaws.com 27017

# Test Cloud Map DNS resolution
nslookup litellm.dev-aprochat-core.local
nslookup searxng.dev-aprochat-core.local
nslookup meilisearch.dev-aprochat-core.local
```

---

### 4. SSE Streaming Validation

Test Lambda response streaming with aws-lambda-ric:

```javascript
// handler.mjs - Test streaming handler
import awslambda from 'aws-lambda-ric';

export const handler = awslambda.streamifyResponse(
  async (event, responseStream, context) => {
    const httpResponseMetadata = {
      statusCode: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache"
      }
    };

    responseStream = awslambda.HttpResponseStream.from(responseStream, httpResponseMetadata);

    for (let i = 0; i < 10; i++) {
      responseStream.write(`data: chunk ${i}\n\n`);
      await new Promise(r => setTimeout(r, 500));
    }

    responseStream.end();
  }
);
```

Test via API Gateway:
```bash
# After deployment, test streaming endpoint
curl -N "https://lambda-test.sandbox.data.apro.is/api/test-stream"
# Should see chunks arriving every 500ms
```

**Expected**: Chunks arrive progressively (not all at once).

---

### 5. ElastiCache Redis Connectivity

```bash
# Test Redis connectivity from Lambda VPC
redis-cli -h librechat-lambda-redis.xxxxxx.eu-west-1.cache.amazonaws.com -p 6379 ping
# Expected: PONG

# Verify Redis security group allows Lambda
aws ec2 describe-security-groups \
  --group-ids sg-xxxxx \
  --query 'SecurityGroups[0].IpPermissions'
```

---

### 6. Security Validation

```bash
# Verify S3 bucket blocks public access
aws s3api get-public-access-block --bucket librechat-frontend-dev
# All values should be "true"

# Verify Lambda is in VPC
aws lambda get-function-configuration --function-name librechat-api \
  --query 'VpcConfig'
# Should show SubnetIds and SecurityGroupIds

# Verify Lambda has SSM access
aws lambda get-function-configuration --function-name librechat-api \
  --query 'Role'
# Then check role has ssm:GetParameter permission
```

---

### 7. API Gateway REST API Configuration

```bash
# Verify REST API exists (not HTTP API)
aws apigateway get-rest-apis --query 'items[?name==`librechat-rest-api`]'

# Check Lambda integration
aws apigateway get-integration \
  --rest-api-id <API_ID> \
  --resource-id <RESOURCE_ID> \
  --http-method ANY
# Should show type: AWS_PROXY and uri with /response-streaming-invocations
```

---

### 8. CloudFront Distribution Validation

```bash
# Verify dual-origin configuration
aws cloudfront get-distribution --id <DIST_ID> \
  --query 'Distribution.DistributionConfig.Origins.Items[*].Id'
# Should show: s3_frontend, api_gateway

# Verify /api/* behavior routes to API Gateway
aws cloudfront get-distribution --id <DIST_ID> \
  --query 'Distribution.DistributionConfig.CacheBehaviors.Items[?PathPattern==`/api/*`]'
```

---

## Validation Results Template

```markdown
## Validation Results - [DATE]

### Service Availability (eu-west-1)
- [ ] Lambda response streaming: PASS / FAIL
- [ ] ElastiCache Redis: PASS / FAIL
- [ ] API Gateway REST API: PASS / FAIL

### Quotas
- [ ] Concurrent executions: PASS / FAIL (current: ___)
- [ ] Function timeout: PASS / FAIL (current: ___)

### Connectivity
- [ ] DocumentDB: PASS / FAIL
- [ ] Cloud Map DNS: PASS / FAIL
- [ ] ElastiCache Redis: PASS / FAIL

### Streaming
- [ ] Lambda streaming works: PASS / FAIL
- [ ] API Gateway passes through: PASS / FAIL
- [ ] CloudFront routing works: PASS / FAIL

### Security
- [ ] S3 public access blocked: PASS / FAIL
- [ ] Lambda in VPC: PASS / FAIL
- [ ] Redis security group: PASS / FAIL

### Overall Status
- [ ] READY FOR IMPLEMENTATION
- [ ] BLOCKED - Issues: ___
```

---

## Common Issues and Solutions

### Issue: Lambda cold starts too slow
**Solution**: Increase memory to 1024MB+ (correlates with CPU), consider provisioned concurrency for production

### Issue: SSE streams disconnect after 29 seconds
**Solution**: Ensure API Gateway uses REST API (v1), not HTTP API (v2). Check integration timeout is 900000ms

### Issue: Redis connection failures
**Solution**: Verify Lambda security group allows egress to Redis security group on port 6379

### Issue: Cloud Map DNS resolution fails
**Solution**: Ensure Lambda is in same VPC as ECS services, VPC DNS resolution enabled

### Issue: S3 config file fetch fails at cold start
**Solution**: Verify Lambda IAM role has s3:GetObject permission for `genai-shared-config` bucket

---

## Deployment Commands

```bash
# Navigate to dev environment
cd infrastructure/terraform/environments/dev

# Initialize Terraform
terraform init

# Plan changes
terraform plan -out=tfplan

# Apply infrastructure
terraform apply tfplan

# Build and push Lambda container
cd ../../modules/backend/docker
docker build -t librechat-lambda-api:latest .
aws ecr get-login-password --region eu-west-1 | docker login --username AWS --password-stdin <ACCOUNT>.dkr.ecr.eu-west-1.amazonaws.com
docker tag librechat-lambda-api:latest <ACCOUNT>.dkr.ecr.eu-west-1.amazonaws.com/librechat-lambda-api:latest
docker push <ACCOUNT>.dkr.ecr.eu-west-1.amazonaws.com/librechat-lambda-api:latest

# Update Lambda function
aws lambda update-function-code \
  --function-name librechat-api \
  --image-uri <ACCOUNT>.dkr.ecr.eu-west-1.amazonaws.com/librechat-lambda-api:latest
```

---

## Next Steps

After validation passes:

1. Run `/speckit.tasks` to generate implementation tasks
2. Create infrastructure with `terraform apply`
3. Build and push Lambda container to ECR
4. Test streaming endpoints
5. Verify Redis session storage works
6. Test full LibreChat functionality
