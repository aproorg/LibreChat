# Redis Module Outputs

output "replication_group_id" {
  description = "Redis replication group ID"
  value       = module.redis.replication_group_id
}

output "primary_endpoint_address" {
  description = "Redis primary endpoint address"
  value       = module.redis.replication_group_primary_endpoint_address
}

output "security_group_id" {
  description = "Redis security group ID"
  value       = module.redis.security_group_id
}

output "cluster_id" {
  description = "Redis cluster ID (first node)"
  value       = "${module.redis.replication_group_id}-001"
}
