#!/bin/bash
# deploy.sh - Build a Web Store-ready zip with production OAuth client_id
# Usage: ./deploy.sh

set -e  # Exit on any error

DEV_CLIENT="585655852429-kcv07ebhtmfpbn4tktg37v56321ivaf4.apps.googleusercontent.com"
PROD_CLIENT="585655852429-73ftr53o0t9hsn8a6f42ocb73t9i2sif.apps.googleusercontent.com"
MANIFEST="manifest.json"
BACKUP="manifest.json.backup"
ZIP_NAME="ai-detector-extension.zip"

echo "🔍 Pre-flight checks..."

# Verify we're in the right folder
if [ ! -f "$MANIFEST" ]; then
  echo "❌ manifest.json not found. Run from extension folder."
  exit 1
fi

# Verify current manifest uses DEV client (sanity check)
if ! grep -q "$DEV_CLIENT" "$MANIFEST"; then
  echo "⚠️  manifest.json doesn't contain dev client_id."
  echo "   Expected: $DEV_CLIENT"
  echo "   Aborting to prevent overwriting an unexpected state."
  exit 1
fi

# Show current version
VERSION=$(grep -o '"version": *"[^"]*"' "$MANIFEST" | sed 's/.*"\([^"]*\)"$/\1/')
echo "📦 Building version: $VERSION"
echo ""

# Backup the dev manifest
cp "$MANIFEST" "$BACKUP"
echo "✅ Backed up dev manifest"

# Swap to prod client_id
sed -i.tmp "s|$DEV_CLIENT|$PROD_CLIENT|g" "$MANIFEST"
rm -f "${MANIFEST}.tmp"
echo "✅ Swapped to prod client_id"

# Remove any old zip
rm -f "$ZIP_NAME"

# Create zip (excluding dev-only files)
zip -r "$ZIP_NAME" . \
  -x ".*" \
  -x "*.backup" \
  -x "deploy.sh" \
  -x "DEPLOY.md" \
  -x "manifest.prod.json" \
  -x "node_modules/*" \
  -x ".git/*" \
  -x "*.zip" > /dev/null

echo "✅ Created $ZIP_NAME"

# Restore dev manifest
mv "$BACKUP" "$MANIFEST"
echo "✅ Restored dev manifest"

echo ""
echo "🎉 Ready to upload!"
echo "   File: $(pwd)/$ZIP_NAME"
echo "   Version: $VERSION"
echo ""
echo "Next steps:"
echo "  1. Go to Chrome Web Store devconsole"
echo "  2. Upload $ZIP_NAME"
echo "  3. Submit for review"
