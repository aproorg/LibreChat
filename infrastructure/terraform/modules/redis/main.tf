# Redis Module - ElastiCache Redis for session storage
# Uses terraform-aws-modules/elasticache/aws v1.10.3

module "redis" {
  source  = "terraform-aws-modules/elasticache/aws"
  version = "1.10.3"

  replication_group_id = "librechat-lambda-redis-${var.environment}"

  # Cluster mode disabled (FR-037)
  cluster_mode_enabled = false
  num_cache_clusters   = 1

  engine         = "redis"
  engine_version = "7.1"
  node_type      = "cache.t4g.micro"

  # VPC configuration (FR-038)
  vpc_id     = var.vpc_id
  subnet_ids = var.private_subnet_ids

  # Security group (FR-041)
  create_security_group = true
  security_group_rules = {
    ingress_lambda = {
      type                          = "ingress"
      from_port                     = 6379
      to_port                       = 6379
      protocol                      = "tcp"
      referenced_security_group_id  = var.lambda_security_group_id
      description                   = "Lambda access"
    }
  }

  # Encryption
  at_rest_encryption_enabled = true
  transit_encryption_enabled = false # LibreChat uses redis:// not rediss://

  apply_immediately = true

  tags = var.tags
}
