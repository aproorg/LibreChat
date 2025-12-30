# LibreChat Lambda Container
# Strategy: Use AWS Lambda Node.js 20 base (has aws-lambda-ric), copy LibreChat app

# Stage 1: Extract LibreChat app from official image
FROM ghcr.io/danny-avila/librechat-api:v0.8.2-rc1 AS librechat

# Stage 2: Final image with AWS Lambda base (FR-006)
FROM public.ecr.aws/lambda/nodejs:20

# Set working directory to Lambda's default
WORKDIR ${LAMBDA_TASK_ROOT}

# Copy LibreChat application from official image (FR-007)
# Copy node_modules first (includes all LibreChat dependencies)
COPY --from=librechat /app/node_modules /var/task/node_modules
COPY --from=librechat /app/api /var/task/api
COPY --from=librechat /app/packages /var/task/packages
COPY --from=librechat /app/package.json /var/task/package.json

# Install missing dependencies
# LibreChat v0.8.2-rc1 already includes @aws-sdk/client-s3@3.758.0 - DO NOT override to avoid middleware conflicts
# Only install @aws-sdk/client-ssm at a compatible version (3.758.0 to match existing AWS SDK)
# winston-daily-rotate-file is required by packages/data-schemas but may be missing from extracted image
# @opentelemetry/* packages required by @langfuse/otel for agents instrumentation
# Use npm install --legacy-peer-deps to handle version conflicts
RUN npm install --legacy-peer-deps --ignore-scripts \
    @aws-sdk/client-ssm@3.758.0 \
    winston-daily-rotate-file@^5.0.0 \
    @opentelemetry/exporter-trace-otlp-http@^0.57.0 \
    @opentelemetry/sdk-node@^0.57.0 \
    @opentelemetry/api@^1.9.0

# Create symlinks for @librechat internal packages (monorepo module resolution)
# LibreChat uses module-alias but Lambda needs explicit node_modules symlinks
RUN mkdir -p /var/task/node_modules/@librechat && \
    ln -sf /var/task/packages/data-schemas /var/task/node_modules/@librechat/data-schemas && \
    ln -sf /var/task/packages/mcp /var/task/node_modules/@librechat/mcp && \
    ln -sf /var/task/packages/agents /var/task/node_modules/@librechat/agents && \
    ln -sf /var/task/packages/api /var/task/node_modules/@librechat/api && \
    ln -sf /var/task/packages/data-provider /var/task/node_modules/@librechat/data-provider

# Download DocumentDB/RDS SSL certificate bundle (required for MongoDB TLS connections)
RUN mkdir -p /ssl && \
    curl -sS "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem" -o /ssl/global-bundle.pem && \
    chmod 644 /ssl/global-bundle.pem

# Create placeholder client files (FR-031)
# LibreChat server reads index.html at startup for runtime config injection
# Frontend is served from CloudFront/S3, but server needs this file to exist
RUN mkdir -p /var/task/client/dist && \
    echo '<!DOCTYPE html><html><head><meta charset="utf-8"><title>API Only</title></head><body>Frontend served from CloudFront</body></html>' > /var/task/client/dist/index.html

# Copy Lambda handler wrapper (FR-008) - CommonJS format for compatibility
COPY --chmod=644 handler.js /var/task/handler.js

# Lambda handler location
CMD ["handler.handler"]
