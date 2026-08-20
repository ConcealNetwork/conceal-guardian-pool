#!/usr/bin/env bash
# Thin wrapper around the Node implementation.
exec node "$(dirname "$0")/check-pending-adrs.mjs" "$@"
