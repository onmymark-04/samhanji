#!/usr/bin/env bash
# GitHub Pages 배포: 테스트 → /samhanji/ 경로로 빌드 → dist를 gh-pages 브랜치에 올린다.
# (Actions 워크플로를 쓰려면 gh 토큰에 workflow 권한이 필요하다: gh auth refresh -s workflow)
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$(git remote get-url origin)
npm test
MSYS_NO_PATHCONV=1 BASE_PATH=/samhanji/ npm run build
touch dist/.nojekyll
cd dist
rm -rf .git
git init -q -b gh-pages
git add -A
git commit -q -m "deploy $(git -C .. rev-parse --short HEAD)"
git push -q -f "$repo" gh-pages
rm -rf .git
echo "-> https://onmymark-04.github.io/samhanji/"
