#!/usr/bin/env bash
# GitHub Pages 배포: 테스트 → /samhanji/ 경로로 빌드 → dist를 gh-pages 브랜치에 올린다.
# (Actions 워크플로를 쓰려면 gh 토큰에 workflow 권한이 필요하다: gh auth refresh -s workflow)
set -euo pipefail
cd "$(dirname "$0")/.."
# 코드는 비공개 저장소(origin)에 두고, 공개 사이트는 PeterK-2026 저장소의 Pages로 내보낸다
repo=$(git remote get-url peterk)
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
echo "-> https://peterk-2026.github.io/samhanji/"
