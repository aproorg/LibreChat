# Feature Specification: AWS Serverless Deployment (Simplified)

**Feature Branch**: `001-aws-serverless-deploy`
**Created**: 2025-12-22
**Updated**: 2025-12-25
**Status**: Draft (Simplified)
**Input**: Deploy LibreChat frontend to S3/CloudFront and backend API to Lambda behind API Gateway REST API with SSE streaming support.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Frontend Deployment (Priority: P1)

A DevOps engineer deploys the LibreChat React frontend to AWS. The frontend is built with npm, uploaded to S3, and served via CloudFront CDN with proper caching and SPA routing.

**Why this priority**: Frontend deployment is simpler and provides immediate value - users can access the application even while backend work continues.

**Independent Test**: Run `terraform apply` and verify the CloudFront URL serves the LibreChat frontend with all assets loading correctly.

**Acceptance Scenarios**:

1. **Given** LibreChat client source code, **When** `terraform apply` runs, **Then** frontend is built, uploaded to S3, and accessible via CloudFront URL
2. **Given** a deployed frontend, **When** user navigates to any SPA route directly (e.g., `/chat/123`), **Then** CloudFront returns `index.html` enabling client-side routing
3. **Given** a new frontend deployment, **When** assets are updated, **Then** CloudFront serves fresh content without manual cache invalidation

---

### User Story 2 - Backend API Deployment (Priority: P2)

A DevOps engineer deploys the LibreChat API as a Lambda container behind API Gateway REST API. The API supports both regular HTTP requests and SSE streaming responses for AI chat.

**Why this priority**: Backend deployment requires the Lambda container setup and API Gateway streaming configuration, building on frontend infrastructure.

**Independent Test**: Run `terraform apply` and verify API endpoints respond correctly, including SSE streaming for `/api/ask/*` and `/api/chat/*` endpoints.

**Acceptance Scenarios**:

1. **Given** the librechat-api base image, **When** `terraform apply` runs, **Then** a Lambda-compatible container is built with aws-lambda-ric and deployed to ECR
2. **Given** a deployed Lambda function, **When** API Gateway receives requests to `/api/*`, **Then** requests are proxied to Lambda and responses returned
3. **Given** SSE streaming endpoints (`/api/ask/*`, `/api/chat/*`), **When** a streaming request is made, **Then** API Gateway streams the Lambda response using `InvokeWithResponseStream`

---

### User Story 3 - Unified Access via CloudFront (Priority: P3)

A DevOps engineer configures CloudFront to route all traffic - both frontend and API requests - through a single domain, eliminating CORS complexity.

**Why this priority**: Unified routing requires both frontend and backend to be deployed first, then integrating them under one CloudFront distribution.

**Independent Test**: Access the CloudFront URL and verify both frontend loads and API requests succeed without CORS errors.

**Acceptance Scenarios**:

1. **Given** CloudFront with S3 and API Gateway origins, **When** user loads the frontend, **Then** all static assets load from S3 origin
2. **Given** CloudFront routing, **When** frontend makes API requests to `/api/*`, **Then** requests route to API Gateway origin
3. **Given** same-origin setup, **When** API requests are made, **Then** no CORS preflight requests are needed

---

### Edge Cases

- What happens when Lambda cold starts during an SSE streaming request?
- How does the system handle Lambda's 15-minute timeout for very long AI responses?
- What happens when `terraform destroy` is run with S3 bucket containing objects?
- What happens when `terraform destroy` is run with ECR repository containing images?

## Requirements *(mandatory)*

### Functional Requirements

**Frontend (S3 + CloudFront)**:
- **FR-001**: Terraform MUST build frontend using npm and upload to S3 bucket
- **FR-002**: S3 bucket MUST have versioning disabled and force_destroy enabled
- **FR-003**: CloudFront MUST serve frontend with SPA routing (fallback to index.html)
- **FR-004**: CloudFront MUST use terraform-aws-modules/cloudfront/aws module
- **FR-005**: S3 bucket MUST use terraform-aws-modules/s3-bucket/aws module

**Backend (Lambda + API Gateway)**:
- **FR-006**: Lambda container MUST use `ghcr.io/danny-avila/librechat-api:v0.8.2-rc1` as base image
- **FR-007**: Lambda container MUST include aws-lambda-ric (Node.js runtime interface client) for Lambda compatibility
- **FR-008**: Lambda handler MUST wrap LibreChat API to comply with API Gateway streaming response schema
- **FR-009**: API Gateway MUST be REST API (v1), not HTTP API (v2), for streaming support
- **FR-010**: API Gateway MUST use Lambda proxy integration with `responseTransferMode: STREAM` for SSE endpoints
- **FR-011**: API Gateway MUST NOT create custom stages (only `$default` stage at `/` root path)
- **FR-012**: ECR repository MUST have force_delete enabled for cleanup

**CloudFront Routing**:
- **FR-013**: CloudFront MUST route `/api/*` requests to API Gateway origin
- **FR-014**: CloudFront MUST route all other requests to S3 origin (frontend)
- **FR-015**: CloudFront MUST disable caching for API requests

**Infrastructure**:
- **FR-016**: ALL infrastructure MUST be managed by Terraform - no manual scripts required
- **FR-017**: Reusable modules MUST use latest terraform-aws-modules where available
- **FR-018**: API Gateway module MUST use native AWS resources (aws_api_gateway_rest_api) - no terraform-aws-modules exists
- **FR-019**: Security group rules MUST be created after dependent resources and destroyed before them
- **FR-020**: Lambda MUST connect to VPC resources (DocumentDB, Cloud Map services, ElastiCache Redis)

**Custom Domain & DNS**:
- **FR-021**: CloudFront MUST use custom domain `lambda-test.sandbox.data.apro.is`
- **FR-022**: Terraform MUST create Route53 A record (alias) pointing to CloudFront distribution
- **FR-023**: Terraform MUST use existing ACM certificate for `*.sandbox.data.apro.is`

**Lambda Configuration**:
- **FR-024**: Lambda MUST use SSM parameters from `aprochat-api` ECS task definition for secrets
- **FR-025**: Lambda MUST use environment variables matching `aprochat-api` task definition
- **FR-026**: Lambda MUST fetch `librechat.yaml` from `s3://genai-shared-config/lambda-test/librechat/librechat.yaml` at cold start
- **FR-027**: Config file MUST replace all `genai.sandbox.data.apro.is` with `lambda-test.sandbox.data.apro.is`
- **FR-028**: Lambda VPC configuration MUST enable DNS resolution for Cloud Map services (`.local` domains)
- **FR-028a**: Lambda handler MUST poll LibreChat health endpoint with max 60 attempts at 500ms intervals (30s total timeout) during cold start
- **FR-029**: Lambda IAM role MUST have read access to `s3://genai-shared-config/lambda-test/*`

**File Storage (S3)**:
- **FR-030**: Lambda MUST use S3 for user file uploads (not EFS like ECS deployment)
- **FR-031**: Terraform MUST create a dedicated S3 bucket for file storage with force_destroy enabled
- **FR-032**: Lambda environment MUST include AWS_BUCKET_NAME and AWS_REGION for LibreChat S3 integration
- **FR-033**: Lambda IAM role MUST have read/write access to the file storage S3 bucket
- **FR-034**: File storage bucket MUST use terraform-aws-modules/s3-bucket/aws module

**Session Storage (ElastiCache Redis)**:
- **FR-035**: Terraform MUST create ElastiCache Redis cluster for Lambda session storage (Lambda has no in-memory state)
- **FR-036**: ElastiCache MUST use terraform-aws-modules/elasticache/aws module version 1.10.3
- **FR-037**: Redis cluster MUST have cluster mode disabled (single node, small instance)
- **FR-038**: Redis cluster MUST be deployed in private subnets within the existing VPC
- **FR-039**: Lambda environment MUST include USE_REDIS=true and REDIS_URI pointing to ElastiCache endpoint
- **FR-040**: Lambda security group MUST allow outbound access to Redis security group on port 6379
- **FR-041**: Redis MUST have a dedicated security group allowing inbound from Lambda security group

**API Gateway CORS**:
- **FR-042**: API Gateway MUST implement OPTIONS method with MOCK integration for CORS preflight requests

### Key Entities

- **S3 Bucket (Frontend)**: Frontend static assets storage with CloudFront OAC access
- **S3 Bucket (File Storage)**: User file uploads storage with Lambda read/write access
- **CloudFront Distribution**: CDN for frontend (S3) and API (API Gateway) routing with custom domain
- **Lambda Function**: Containerized LibreChat API with aws-lambda-ric, VPC-connected
- **ECR Repository**: Docker image storage for Lambda container
- **API Gateway REST API**: Lambda proxy integration with streaming support
- **ElastiCache Redis**: Session storage for Lambda (cluster mode disabled, small instance)
- **Route53 A Record**: Alias record for `lambda-test.sandbox.data.apro.is` → CloudFront
- **Existing VPC**: `vpc-05e4efdfad1c2252a` in `eu-west-1` (referenced, not created)
- **Existing DocumentDB**: `aprochat-dev-genai-docdb-cluster.cluster-cx8ui6sy4sn2.eu-west-1.docdb.amazonaws.com:27017`
- **Existing ACM Certificate**: Wildcard cert for `*.sandbox.data.apro.is` (referenced, not created)
- **Existing Route53 Hosted Zone**: Zone for `sandbox.data.apro.is` (referenced, not created)
- **Existing S3 Config Bucket**: `genai-shared-config` (cross-account, upload via AWS_PROFILE=apro-shared)

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `terraform apply` successfully deploys all resources without manual intervention
- **SC-002**: Frontend loads in browser within 3 seconds via CloudFront URL
- **SC-003**: API health endpoint (`/api/health`) returns 200 OK
- **SC-004**: SSE streaming works for AI chat responses (no buffering, chunks arrive progressively)
- **SC-005**: `terraform destroy` successfully removes all resources including non-empty S3 bucket and ECR images
- **SC-006**: Total Terraform files under 500 lines (excluding comments and variable definitions)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     CloudFront Distribution                  │
│  ┌─────────────────────┐    ┌─────────────────────────────┐ │
│  │  S3 Origin          │    │  API Gateway Origin         │ │
│  │  (/* default)       │    │  (/api/*)                   │ │
│  └──────────┬──────────┘    └──────────────┬──────────────┘ │
└─────────────┼───────────────────────────────┼───────────────┘
              │                               │
              ▼                               ▼
┌─────────────────────────┐    ┌─────────────────────────────┐
│     S3 Bucket           │    │   API Gateway REST API      │
│  (Frontend Assets)      │    │  (Lambda Proxy Integration) │
│  - No versioning        │    │  - Stream mode for SSE      │
│  - Force destroy        │    │  - $default stage only      │
└─────────────────────────┘    └──────────────┬──────────────┘
                                              │
                                              ▼
                               ┌─────────────────────────────┐
                               │     Lambda Function         │
                               │  (Container Image)          │
                               │  - aws-lambda-ric           │
                               │  - LibreChat API wrapper    │
                               │  - VPC connected            │
                               └──────────────┬──────────────┘
                                              │
                     ┌────────────────────────┼────────────────────────┐
                     │                        │                        │
                     ▼                        ▼                        ▼
            ┌────────────────┐    ┌────────────────┐    ┌────────────────┐
            │   DocumentDB   │    │  ElastiCache   │    │ Cloud Map DNS  │
            │   (MongoDB)    │    │   (Redis)      │    │  (Services)    │
            └────────────────┘    └────────────────┘    └────────────────┘
```

## Terraform Module Structure

```
infrastructure/terraform/
├── environments/
│   └── dev/
│       ├── main.tf              # Module orchestration
│       ├── variables.tf         # Input variables
│       ├── outputs.tf           # Output values
│       └── terraform.tfvars.json # Environment config
└── modules/
    ├── frontend/                # S3 + CloudFront (terraform-aws-modules)
    │   ├── main.tf
    │   ├── variables.tf
    │   └── outputs.tf
    ├── backend/                 # Lambda + ECR
    │   ├── main.tf
    │   ├── variables.tf
    │   └── outputs.tf
    ├── api-gateway/             # REST API (native resources)
    │   ├── main.tf
    │   ├── variables.tf
    │   └── outputs.tf
    └── redis/                   # ElastiCache Redis (terraform-aws-modules/elasticache/aws)
        ├── main.tf
        ├── variables.tf
        └── outputs.tf
```

## Lambda Container Configuration

The Lambda container must:

1. **Base Image**: Start from `ghcr.io/danny-avila/librechat-api:v0.8.2-rc1`
2. **Runtime Interface Client**: Install `aws-lambda-ric` npm package
3. **Handler Wrapper**: Create a wrapper that:
   - Receives API Gateway events
   - Invokes LibreChat API
   - Formats responses for API Gateway streaming (metadata + delimiter + payload)

**Streaming Response Format** (per AWS docs):
```
{
  "statusCode": 200,
  "headers": {"Content-Type": "text/event-stream"}
}<8 null bytes>data: chunk1\n\ndata: chunk2\n\n
```

## API Gateway Streaming Configuration

For SSE endpoints (`/api/ask/*`, `/api/chat/*`, `/api/agents/*`):

- **Integration Type**: `AWS_PROXY`
- **Integration URI**: Lambda ARN with `/response-streaming-invocations` suffix
- **Response Transfer Mode**: `STREAM`
- **Timeout**: Up to 900 seconds (15 minutes)

## External Resources (Referenced, Not Created)

All external resources are passed via `terraform.tfvars.json`:

```json
{
  "vpc_id": "vpc-05e4efdfad1c2252a",
  "private_subnet_ids": [
    "subnet-0b336ffd64e2358e8",
    "subnet-005e834e314ffdd6c",
    "subnet-0cd1448a488983eda"
  ],
  "security_group_ids": {
    "shared_services": "sg-07d152120863401c2"
  },
  "database_endpoints": {
    "documentdb": "aprochat-dev-genai-docdb-cluster.cluster-cx8ui6sy4sn2.eu-west-1.docdb.amazonaws.com"
  },
  "route53_zone_id": "Z094499229C0ZN7M8OFEE",
  "acm_certificate_arn": "arn:aws:acm:us-east-1:515966504419:certificate/ca7a072b-830c-427f-ae2b-c49418366489",
  "custom_domain": "lambda-test.sandbox.data.apro.is",
  "config_s3_bucket": "genai-shared-config",
  "config_s3_key": "lambda-test/librechat/librechat.yaml"
}
```

## Lambda SSM Parameters (from aprochat-api task definition)

**Secrets (from SSM Parameter Store)**:
| Name | SSM Parameter ARN |
|------|-------------------|
| CREDS_IV | `arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/librechat/CREDS_IV` |
| CREDS_KEY | `arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/librechat/CREDS_KEY` |
| FIRECRAWL_API_KEY | `arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/firecrawl/test_api_key` |
| JWT_REFRESH_SECRET | `arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/librechat/JWT_REFRESH_SECRET` |
| JWT_SECRET | `arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/librechat/JWT_SECRET` |
| LITELLM_API_KEY | `arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/litellm/master_key` |
| MEILI_MASTER_KEY | `arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/meilisearch/MEILI_MASTER_KEY` |
| MONGO_URI | `arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/mongo/DB_URI` |
| OPENID_CLIENT_ID | `arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/cognito/idp/client_id` |
| OPENID_CLIENT_SECRET | `arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/cognito/idp/client_secret` |
| OPENID_SESSION_SECRET | `arn:aws:ssm:eu-west-1:515966504419:parameter/ecs/genai/cognito/idp/session_secret` |

**Key Environment Variables** (subset - full list in task definition):
| Name | Value | Notes |
|------|-------|-------|
| DOMAIN_SERVER | `https://lambda-test.sandbox.data.apro.is` | Updated from genai.sandbox |
| DOMAIN_CLIENT | `https://lambda-test.sandbox.data.apro.is` | Updated from genai.sandbox |
| CONFIG_PATH | `/tmp/librechat.yaml` | Fetched from S3 at cold start |
| LITELLM_BASE_URL | `http://litellm.dev-aprochat-core.local:4000/v1` | Via Cloud Map DNS |
| SEARXNG_INSTANCE_URL | `http://searxng.dev-aprochat-core.local:8080` | Via Cloud Map DNS |
| RAG_API_URL | `http://rag-api.dev-aprochat-core.local:8000` | Via Cloud Map DNS |
| MEILI_HOST | `http://meilisearch.dev-aprochat-core.local:7700` | Via Cloud Map DNS |
| FIRECRAWL_API_URL | `http://firecrawl.dev-aprochat-core.local:3002` | Via Cloud Map DNS |
| AWS_BUCKET_NAME | `librechat-lambda-files-{env}` | File storage bucket (Terraform-created) |
| AWS_REGION | `eu-west-1` | S3 region for file uploads |
| USE_REDIS | `true` | Enable Redis for session storage and caching |
| REDIS_URI | `redis://{elasticache-endpoint}:6379` | ElastiCache Redis connection string |

**Excluded Environment Variables** (from ECS task definition):
| Name | Reason |
|------|--------|
| ASSETS_URL | Use LibreChat default (assets served from same domain) |
| HOST | Lambda handles networking differently |
| PORT | Lambda handles networking differently |
| TRUST_PROXY | Lambda/API Gateway handles proxying |

## Assumptions

1. LibreChat API can run with aws-lambda-ric without significant code changes
2. API Gateway REST API streaming works with CloudFront as frontend
3. Existing VPC has NAT gateway for Lambda outbound internet access
4. DocumentDB security groups allow access from Lambda security group
5. SSM parameters for secrets already exist from ECS deployment

## Out of Scope

- WebSocket support for MCP servers (Lambda limitation)
- Multiple environments (only dev environment)
- CI/CD pipeline (manual `terraform apply`)
- Monitoring and alerting setup
- Cost optimization (provisioned concurrency, reserved capacity)

## Clarifications

### Session 2025-12-25

- Q: How should Lambda access internal Cloud Map services (litellm, searxng, firecrawl, rag-api, meilisearch)? → A: Full VPC integration - Lambda accesses all services via VPC and Cloud Map DNS resolution
- Q: What SSM parameters and environment variables should Lambda use? → A: Use SSM parameters and env vars from `aprochat-api` ECS task definition
- Q: What configuration file should Lambda use? → A: Use `tmp/apro-datalake-sandbox/librechat/librechat.yaml`
- Q: What custom domain should CloudFront use? → A: `lambda-test.sandbox.data.apro.is` with Route53 record (replaces `genai.sandbox.data.apro.is`)
- Q: How should librechat.yaml config be provided to Lambda? → A: Store in S3 at `s3://genai-shared-config/lambda-test/librechat/librechat.yaml`, fetch at cold start (upload via AWS_PROFILE=apro-shared)
- Q: Should Lambda use ASSETS_URL from ECS task definition? → A: No, remove ASSETS_URL and use LibreChat default behavior (assets served from same domain)
- Q: What storage should Lambda use for file uploads? → A: S3 using LibreChat's native S3 support (unlike ECS which uses EFS)
- Q: What cache/session storage should Lambda use? → A: Create a new ElastiCache Redis cluster (cluster mode disabled) using terraform-aws-modules/elasticache/aws v1.10.3. Lambda needs Redis for session storage since it has no in-memory state like ECS containers. Do not use the existing Valkey cluster.
- Q: What Redis environment variables does LibreChat require? → A: USE_REDIS=true (enable Redis), REDIS_URI=redis://{endpoint}:6379 (connection string). LibreChat uses Redis for session storage, caching, and rate limiting.
