#!/bin/sh
# Publish the Pix Remote relay (phone page + Worker). Uses CLOUDFLARE_API_TOKEN if set, else wrangler's saved login.
set -e
cd "$(dirname "$0")/../relay"
exec npx wrangler deploy "$@"
