#!/bin/bash
# Push the two Worker secrets from the operator's passage store. Values go
# straight from passage into wrangler's stdin; nothing is printed or written.
set -euo pipefail
cd "$(dirname "$0")/.."
passage show tokens/cloudflare/personal/acta/rtk-admin | tr -d '\n' | bunx wrangler secret put RTK_API_TOKEN
passage show tokens/cloudflare/personal/acta/acta-token | tr -d '\n' | bunx wrangler secret put ACTA_TOKEN
bunx wrangler secret list
