#!/bin/sh
# This script is an endpoint used to check if container is running in ECS and if so copy files from S3 bucket to container

CONTAINER_RUN_COMMAND=$1

echo "This run.sh will run container command: $CONTAINER_RUN_COMMAND"

# Set variables
S3_BUCKET=$SERVICE_BUCKET_NAME
CONTAINER_DIR=/app
PREFIX=$S3_prefix
VERSION=$VERSION

# Sync files from an S3 bucket to a docker volume
echo "Syncing files from S3 bucket $S3_BUCKET to $CONTAINER_DIR"
echo "S3 bucket: $S3_BUCKET"
echo "Prefix: $PREFIX"
echo "Container directory: $CONTAINER_DIR"

#Librechat Config file
aws s3 cp s3://"$S3_BUCKET"/"$PREFIX"/librechat.yaml "$CONTAINER_DIR/api/"
#Assets
aws s3 sync s3://"$S3_BUCKET"/"$PREFIX"/assets "$CONTAINER_DIR/client/dist/assets"

# Run container command
echo "Running container command: $CONTAINER_RUN_COMMAND"
exec "$@"
