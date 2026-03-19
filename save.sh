#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

git add -A

if git diff --cached --quiet; then
  echo "Nothing new to save."
  read -n1 -r -p "Press any key to close..."
  exit 0
fi

TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
git commit -m "Save $TIMESTAMP"
git push

echo ""
echo "Saved and pushed to GitHub."
read -n1 -r -p "Press any key to close..."
