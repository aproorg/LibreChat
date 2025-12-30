# ADR-001: Replace ElastiCache Valkey Serverless with Standard ElastiCache Redis

**Status:** Proposed
**Date:** 2024-12-24
**Decision Makers:** Infrastructure Team
**Category:** Infrastructure / Session Management

## Context

LibreChat is being deployed to AWS Lambda as a containerized application. The application requires server-side session storage for OAuth authentication state persistence across Lambda invocations. Without persistent session storage, OAuth flows fail because:

1. Lambda functions are stateless - in-memory sessions are lost between invocations
2. OAuth authentication requires session state to be preserved during the authorization code flow
3. Multiple Lambda instances may handle different requests in the same OAuth flow

### Initial Approach: ElastiCache Valkey Serverless

The initial infrastructure design used **ElastiCache Valkey Serverless** based on the following reasoning:

- **Cost efficiency**: Serverless pricing model (pay-per-use) for development environments
- **No capacity planning**: Automatic scaling without managing node types
- **Managed infrastructure**: Fully managed by AWS with no maintenance overhead
- **Valkey compatibility**: Open-source Redis fork with full protocol compatibility

### Problem Discovery

During integration testing, the application failed to initialize Redis connectivity with the following error:

```
CROSSSLOT Keys in request don't hash to the same slot
```

This error occurred during multi-key DEL operations in LibreChat's session cleanup routines.

## Technical Analysis

### Root Cause Investigation

#### 1. ElastiCache Serverless Architecture

ElastiCache Serverless **internally uses cluster mode** regardless of client configuration:

- Data is automatically sharded across multiple slots (0-16383)
- Multi-key operations must target keys in the same hash slot
- This is a fundamental architectural constraint, not a configuration option

From AWS Documentation:
> "ElastiCache Serverless caches are always designed for high availability using data replication... automatically shards and replicates data across multiple Availability Zones."

#### 2. LibreChat's Redis Usage Pattern

LibreChat uses the `ioredis` library in standalone mode. Key code analysis:

**`packages/api/src/cache/redisUtils.ts:46-54`**
```typescript
const deleteKeys = async (pattern: string): Promise<void> => {
  const client = getRedisClient();
  if (!client) return;
  const keys = await client.keys(pattern);
  if (keys.length > 0) {
    await client.del(...keys);  // Multi-key DEL operation
  }
};
```

**`packages/api/src/cache/redisUtils.ts:56-65`**
```typescript
const deleteKeysByPrefix = async (prefix: string): Promise<void> => {
  const client = getRedisClient();
  if (!client) return;
  const keys = await client.keys(`${prefix}*`);
  if (keys.length > 0) {
    await client.del(...keys);  // Multi-key DEL operation
  }
};
```

These operations retrieve keys matching a pattern and delete them in a single `DEL` command with multiple keys. In Redis cluster mode, this fails because keys are distributed across different hash slots.

#### 3. Testing Results

| Configuration | ElastiCache Serverless | Result |
|--------------|----------------------|--------|
| `USE_REDIS_CLUSTER=false` | Valkey | CROSSSLOT error on DEL |
| `USE_REDIS_CLUSTER=true` | Valkey | Cluster mode requires code changes |
| `USE_REDIS=false` | N/A | OAuth fails (no session persistence) |

**Key Finding**: There is no configuration combination that makes ElastiCache Serverless compatible with LibreChat's current codebase without source code modifications.

#### 4. Constraint: No Source Code Modifications

The deployment constraint explicitly prohibits modifying LibreChat's source code:
- Only infrastructure, Docker, and Terraform changes are allowed
- This eliminates solutions like refactoring to use hash tags `{session}:key`
- This eliminates replacing multi-key operations with pipelines/scripts

### Alternative Solutions Evaluated

| Solution | Pros | Cons | Viable? |
|----------|------|------|---------|
| **Modify LibreChat Redis code** | Proper cluster support | Violates constraint | No |
| **Use hash tags for session keys** | Compatible with cluster | Requires code changes | No |
| **ElastiCache Standard (cluster mode disabled)** | Works with existing code | Requires capacity planning | **Yes** |
| **MemoryDB for Redis** | Managed, durable | Also uses cluster mode | No |
| **Self-managed Redis on EC2/ECS** | Full control | Operational overhead | Not preferred |
| **Disable Redis entirely** | Simple | OAuth breaks | No |

## Decision

**Replace ElastiCache Valkey Serverless with Standard ElastiCache Redis (cluster mode disabled).**

### Configuration

```hcl
resource "aws_elasticache_parameter_group" "redis" {
  name   = "librechat-redis-${var.environment}"
  family = "redis7"

  parameter {
    name  = "cluster-enabled"
    value = "no"  # Critical: disable cluster mode
  }
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "librechat-redis-${var.environment}"
  description          = "LibreChat Redis - cluster mode DISABLED for session compatibility"

  engine               = "redis"
  engine_version       = "7.1"
  node_type            = "cache.t4g.micro"  # Dev: smallest instance
  num_cache_clusters   = 1                   # Single node for dev

  parameter_group_name = aws_elasticache_parameter_group.redis.name

  # Security
  transit_encryption_enabled = true  # TLS in transit
  at_rest_encryption_enabled = true  # Encryption at rest

  # Network
  subnet_group_name  = aws_elasticache_subnet_group.redis.name
  security_group_ids = [aws_security_group.redis.id]
}
```

### LibreChat Environment Variables

```bash
USE_REDIS=true
USE_REDIS_CLUSTER=false
REDIS_USE_ALTERNATIVE_DNS_LOOKUP=true  # Required for ElastiCache DNS resolution
REDIS_URI=rediss://<primary-endpoint>:6379  # TLS connection
```

## Rationale

### Why Standard Redis Over Serverless

1. **No cluster mode**: Standard ElastiCache with cluster mode disabled operates as a single logical Redis instance
2. **Multi-key operations work**: All keys reside in a single hash space, eliminating CROSSSLOT errors
3. **Immediate compatibility**: Works with LibreChat's existing Redis code without modifications
4. **Production-ready**: Can scale up node types for production workloads

### Why Not Other Solutions

| Alternative | Why Not |
|-------------|---------|
| MemoryDB | Uses cluster mode internally (same CROSSSLOT issue) |
| EC2/ECS Redis | Unnecessary operational complexity |
| Code modification | Violates deployment constraints |
| In-memory only | OAuth authentication breaks |

## Consequences

### Positive

- **OAuth works**: Session state persists across Lambda invocations
- **No code changes**: Works with LibreChat as-is
- **Security maintained**: TLS in-transit, encryption at-rest
- **Proven solution**: Standard Redis is a mature, well-understood technology
- **Scalable**: Can upgrade node types or add read replicas for production

### Negative

- **Capacity planning required**: Must choose node type (unlike serverless auto-scaling)
- **Fixed costs**: Pay for provisioned capacity even when idle
- **Manual scaling**: Must resize node type for traffic spikes
- **Single AZ in dev**: Single-node configuration has no HA (acceptable for dev)

### Cost Comparison

| Configuration | Monthly Cost (eu-west-1) | Notes |
|--------------|-------------------------|-------|
| Valkey Serverless | ~$0-50 (usage-based) | Doesn't work with LibreChat |
| cache.t4g.micro (1 node) | ~$12 | Dev environment |
| cache.t4g.small (2 nodes) | ~$48 | Staging with HA |
| cache.r6g.large (2 nodes) | ~$260 | Production with HA |

### Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Node failure (single-node dev) | Acceptable for dev; use Multi-AZ for staging/prod |
| Memory exhaustion | Monitor via CloudWatch; implement session TTL |
| Connection limits | Configure connection pooling in Lambda |
| Cost overruns | Use Reserved Instances for production |

## Implementation

### Files Created/Modified

1. **New ElastiCache Module**
   - `infrastructure/terraform/modules/elasticache/main.tf`
   - `infrastructure/terraform/modules/elasticache/variables.tf`
   - `infrastructure/terraform/modules/elasticache/outputs.tf`
   - `infrastructure/terraform/modules/elasticache/versions.tf`

2. **Backend Module Updates**
   - `infrastructure/terraform/modules/backend/lambda.tf` - Redis env vars
   - `infrastructure/terraform/modules/backend/lambda-env.tf` - redis_uri variable

3. **Environment Configuration**
   - `infrastructure/terraform/environments/dev/main.tf` - ElastiCache module
   - `infrastructure/terraform/environments/dev/variables.tf` - create_elasticache flag
   - `infrastructure/terraform/environments/dev/outputs.tf` - ElastiCache outputs
   - `infrastructure/terraform/environments/dev/terraform.tfvars.json` - Configuration values

### Deployment Steps

```bash
cd infrastructure/terraform/environments/dev

# Initialize new module
terraform init

# Preview changes
terraform plan

# Apply (creates ElastiCache cluster ~5-10 min)
terraform apply
```

### Validation

1. Check ElastiCache cluster status in AWS Console
2. Verify Lambda environment variables include `USE_REDIS=true`
3. Test OAuth flow: Login → Cognito redirect → Callback → Success
4. Monitor CloudWatch Logs for Redis connection success

## References

- [AWS ElastiCache Serverless Documentation](https://docs.aws.amazon.com/AmazonElastiCache/latest/mem-ug/serverless.html)
- [Redis CROSSSLOT Error Explanation](https://redis.io/docs/manual/scaling/#redis-cluster-data-sharding)
- [LibreChat Redis Configuration](https://www.librechat.ai/docs/configuration/dotenv#redis)
- [ioredis Cluster Mode](https://github.com/redis/ioredis#cluster)

## Appendix A: CROSSSLOT Error Details

### Error Message
```
ReplyError: CROSSSLOT Keys in request don't hash to the same slot
    at parseError (/var/task/node_modules/ioredis/built/...)
```

### Why It Happens

Redis Cluster divides the key space into 16384 hash slots. Each key is assigned to a slot using:
```
HASH_SLOT = CRC16(key) mod 16384
```

Multi-key commands like `DEL key1 key2 key3` require all keys to be in the same slot. When keys have different prefixes (e.g., `session:abc123`, `cache:xyz789`), they hash to different slots, causing the CROSSSLOT error.

### Hash Tag Solution (Not Used - Requires Code Changes)

Redis supports hash tags `{tag}` to force key colocation:
```
{session}:abc123  → slot of "session"
{session}:xyz789  → slot of "session"
```

This would require modifying LibreChat's key naming conventions, which violates our constraint.

## Appendix B: ElastiCache Serverless vs Standard

| Feature | Serverless | Standard (Cluster Mode Disabled) |
|---------|-----------|--------------------------------|
| Pricing Model | Pay-per-use | Provisioned capacity |
| Scaling | Automatic | Manual node resize |
| Cluster Mode | Always enabled (internal) | Configurable |
| Multi-key Operations | Limited (hash slot restriction) | Full support |
| High Availability | Built-in | Optional (Multi-AZ) |
| Maintenance | Automatic | Managed (patching windows) |
| LibreChat Compatible | **No** | **Yes** |
