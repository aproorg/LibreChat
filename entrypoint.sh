#!/bin/bash

set -euo pipefail

DEFAULT_URL="https://raw.githubusercontent.com/aproorg/LibreChat/refs/heads/main/librechat.apro.yaml"
LIBRECHAT_YAML_URL="${LIBRECHAT_YAML_URL:-$DEFAULT_URL}"

if [ "$LIBRECHAT_YAML_URL" = "$DEFAULT_URL" ]; then
  echo "Warning: LIBRECHAT_YAML_URL not set. Using default URL: $DEFAULT_URL"
else
  echo "Using provided LIBRECHAT_YAML_URL: $LIBRECHAT_YAML_URL"
fi

echo "Downloading configuration..."
if output=$(curl -sSfL "$LIBRECHAT_YAML_URL" -o /app/api/librechat.yaml 2>&1); then
  echo "Configuration file downloaded successfully."
else
  exit_code=$?
  echo "Error: Failed to download the configuration file. Curl exited with status $exit_code"
  echo "Curl output: $output"
  exit $exit_code
fi

exec "$@"
