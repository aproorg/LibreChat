# LibreChat Development Guidelines

Auto-generated from all feature plans. Last updated: 2025-12-26

## Active Technologies

- Terraform ≥1.0 (001-aws-serverless-deploy)
- HCL (infrastructure-as-code)
- Node.js 20 (Lambda container)
- aws-lambda-ric (Lambda Runtime Interface Client)

## Project Structure

```text
infrastructure/terraform/
├── environments/dev/    # Environment configuration
└── modules/
    ├── frontend/        # S3 + CloudFront
    ├── backend/         # Lambda + ECR + IAM
    │   └── docker/      # Lambda container (handler.js, Dockerfile)
    ├── api-gateway/     # REST API (v1) with streaming
    ├── redis/           # ElastiCache Redis
    └── monitoring/      # CloudWatch alarms + dashboard

specs/001-aws-serverless-deploy/
├── spec.md              # Feature specification
├── plan.md              # Implementation plan
├── research.md          # Technical research findings
├── data-model.md        # AWS resource definitions
├── quickstart.md        # Validation checklist
├── deployment-runbook.md # Deployment guide
└── contracts/           # Interface contracts
    ├── terraform-module-interfaces.md
    └── lambda-handler-contract.md
```

## Commands

```bash
# Taskfile commands (from repository root)
task login:dev      # AWS SSO login
task init:dev       # Initialize Terraform
task plan:dev       # Plan changes
task apply:dev      # Apply changes
task output:dev     # Show outputs
task destroy:dev    # Destroy resources
task fmt            # Format Terraform files

# Docker build (local testing)
task docker:build   # Build Lambda container locally
```

See `specs/001-aws-serverless-deploy/deployment-runbook.md` for complete deployment guide.

## Code Style

- Terraform: Follow HashiCorp conventions (terraform fmt)
- Lambda handler (handler.mjs): ES modules, async/await patterns
- Infrastructure code uses terraform-aws-modules where available

## AWS Serverless Architecture (001-aws-serverless-deploy)

**Key Components**:
- Single Lambda function with aws-lambda-ric (not Lambda Web Adapter)
- Single REST API (v1) for all endpoints including SSE streaming
- ElastiCache Redis for session storage (cluster mode disabled)
- CloudFront with dual origins (S3 frontend, API Gateway backend)
- Custom domain: lambda-test.sandbox.data.apro.is

**SSE Streaming**:
- API Gateway integration uses `/response-streaming-invocations` suffix
- Lambda handler uses `awslambda.streamifyResponse()` decorator
- Streaming endpoints: `/api/ask/*`, `/api/chat/*`, `/api/agents/*`

**VPC Integration**:
- Lambda in private subnets with existing DocumentDB access
- Cloud Map DNS for ECS services (.local domains)
- ElastiCache Redis in same VPC

## Recent Changes

- 001-aws-serverless-deploy: Dev environment deployed and operational
  - Lambda + API Gateway with SSE streaming
  - ElastiCache Redis for sessions
  - CloudFront with custom domain
  - CloudWatch monitoring (10 alarms + dashboard)

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
