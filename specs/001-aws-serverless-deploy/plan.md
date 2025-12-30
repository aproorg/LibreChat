# Implementation Plan: AWS Serverless Deployment

**Branch**: `001-aws-serverless-deploy` | **Date**: 2025-12-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-aws-serverless-deploy/spec.md`

## Summary

Deploy LibreChat frontend to S3/CloudFront and backend API to Lambda behind API Gateway REST API with SSE streaming support. The Lambda container wraps the LibreChat API with `aws-lambda-ric` for Lambda compatibility and connects to existing VPC resources (DocumentDB, Cloud Map services). CloudFront provides unified routing for both frontend assets and API requests under a single custom domain (`lambda-test.sandbox.data.apro.is`).

## Technical Context

**Language/Version**: HCL (Terraform ≥1.0), Node.js 20 (Lambda container), TypeScript (LibreChat)
**Primary Dependencies**:
- terraform-aws-modules/cloudfront/aws
- terraform-aws-modules/s3-bucket/aws
- terraform-aws-modules/elasticache/aws (v1.10.3)
- Native AWS resources for API Gateway REST API and Lambda
**Storage**:
- S3 (frontend assets, user file uploads)
- DocumentDB (existing - MongoDB compatible)
- ElastiCache Redis (session storage, caching)
**Testing**: `terraform validate`, `terraform plan`, Manual SSE streaming verification
**Target Platform**: AWS (Lambda, API Gateway REST API, S3, CloudFront, ElastiCache)
**Project Type**: Infrastructure-as-Code (Terraform modules)
**Performance Goals**: Frontend load <3 seconds, SSE streaming without buffering
**Constraints**: Lambda 15-minute timeout, REST API (v1) required for streaming, <500 lines Terraform
**Scale/Scope**: Single dev environment, existing VPC integration

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Gate | Applicability | Status |
|------|---------------|--------|
| ESLint passes | N/A - Infrastructure code | ✅ Exempt |
| Prettier formatting | N/A - Terraform uses HCL | ✅ Exempt |
| Unit tests pass | Limited - `terraform validate` | ⚠️ Advisory |
| No circular deps | Terraform module dependencies | ✅ Will verify |
| i18n compliance | N/A - No UI strings | ✅ Exempt |
| a11y static check | N/A - Infrastructure only | ✅ Exempt |

**Constitution Compliance Notes**:
- This feature is infrastructure-only (Terraform), not application code
- No changes to `api/`, `client/`, or `packages/` directories
- Lambda container uses existing LibreChat Docker image with aws-lambda-ric wrapper
- Security: All secrets via SSM Parameter Store (existing), no hardcoded credentials

## Project Structure

### Documentation (this feature)

```text
specs/001-aws-serverless-deploy/
├── spec.md              # Feature specification
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   ├── terraform-module-interfaces.md
│   └── lambda-handler-contract.md
├── checklists/          # Validation checklists
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
infrastructure/terraform/
├── environments/
│   └── dev/
│       ├── main.tf              # Module orchestration
│       ├── variables.tf         # Input variables
│       ├── outputs.tf           # Output values
│       └── terraform.tfvars.json # Environment config (external resources)
└── modules/
    ├── frontend/                # S3 + CloudFront (terraform-aws-modules)
    │   ├── main.tf
    │   ├── variables.tf
    │   └── outputs.tf
    ├── backend/                 # Lambda + ECR
    │   ├── main.tf
    │   ├── variables.tf
    │   ├── outputs.tf
    │   └── docker/              # Lambda container build
    │       ├── Dockerfile
    │       └── handler.mjs      # Lambda wrapper for LibreChat API
    ├── api-gateway/             # REST API (native resources)
    │   ├── main.tf
    │   ├── variables.tf
    │   └── outputs.tf
    └── redis/                   # ElastiCache Redis (terraform-aws-modules/elasticache/aws)
        ├── main.tf
        ├── variables.tf
        └── outputs.tf
```

**Structure Decision**: Infrastructure-as-Code project using Terraform modules. The `infrastructure/terraform/` directory is isolated from the LibreChat application code. Each module encapsulates a logical component (frontend, backend, api-gateway, redis) with clear interfaces. The Lambda container build context (`docker/`) is within the backend module since it's tightly coupled to Lambda configuration.

## Complexity Tracking

> **No constitution violations** - This is infrastructure code exempt from application code gates.

| Decision | Rationale | Alternative Considered |
|----------|-----------|------------------------|
| 4 Terraform modules | Clear separation of concerns | Monolithic main.tf rejected for maintainability |
| Native API Gateway resources | No terraform-aws-modules for REST API streaming | HTTP API rejected (no streaming support) |
| aws-lambda-ric approach | Standard Lambda container pattern | Lambda Web Adapter rejected (added complexity) |
| ElastiCache Redis (new cluster) | Lambda needs external session storage | Existing Valkey rejected (Lambda has no in-memory state) |
