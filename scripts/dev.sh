#!/bin/bash

GIT_ROOT=$(git rev-parse --show-toplevel)
source "${GIT_ROOT}/.env"

API_WORKSPACE="@librechat/backend"
CLIENT_WORKSPACE="@librechat/frontend"

kill_port() {
  local port=$1
  if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    lsof -ti tcp:$port | xargs kill -9
  else
    # Linux
    fuser -k $port/tcp
  fi
}

# Check if an argument is provided
if [ $# -eq 0 ]; then
  echo "Usage: $0 <backend|frontend>"
  exit 1
fi

source "${GIT_ROOT}/.env"

case "$1" in
backend)
  echo "Restarting backend..."
  kill_port 3080
  PORT=3080 yarn workspace $API_WORKSPACE run dev
  ;;
frontend)
  echo "Restarting frontend..."
  kill_port 3090
  PORT=3090 yarn workspace $CLIENT_WORKSPACE run dev
  ;;
*)
  echo "Invalid argument. Use 'backend' or 'frontend'."
  exit 1
  ;;
esac
