#!/usr/bin/env bash
# Deploy the hosted Gobiman to Google Cloud Run.
#
#   GCP_PROJECT=my-project bash scripts/deploy.sh --setup   # once: a service account with no roles
#   GCP_PROJECT=my-project bash scripts/deploy.sh           # build in Cloud Build, deploy, health check
#
# Settings come from the environment or from a .env next to server.js (never committed):
#   GCP_PROJECT   required
#   GCP_REGION    default us-central1
#   GCP_SERVICE   default gobiman
#   GCP_REPO      default <region>-docker.pkg.dev/<project>/apps   (an Artifact Registry repository)
#   GOBIMAN_LAUNCHER_URL, GOBIMAN_LAUNCHER_ELEMENT   optional: your site's apps launcher (see server.js)
# The service runs with GOBIMAN_HOSTED=1 (see server.js) and holds no secrets at all.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
PROJECT="${GCP_PROJECT:?set GCP_PROJECT (in the environment or in .env)}"
REGION="${GCP_REGION:-us-central1}"
SERVICE="${GCP_SERVICE:-gobiman}"
REPO="${GCP_REPO:-$REGION-docker.pkg.dev/$PROJECT/apps}"
SA="$SERVICE-app@$PROJECT.iam.gserviceaccount.com"

if [[ "${1:-}" == "--setup" ]]; then
  # a service account with no roles: the hosted tool needs nothing from the cloud project
  gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 || gcloud iam service-accounts create "$SERVICE-app" --project "$PROJECT" --display-name "Gobiman (hosted)"
  echo "setup done: $SA"; exit 0
fi

echo "· check"; node --check server.js
TAG=$(date +%Y%m%d-%H%M%S)
echo "· build $TAG"
gcloud builds submit --project "$PROJECT" --config cloudbuild.yaml --substitutions "_REPO=$REPO,_TAG=$TAG" . > .deploy-build.log 2>&1 || { tail -40 .deploy-build.log; exit 1; }
echo "· deploy"
gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" --image "$REPO/gobiman:$TAG" --service-account "$SA" \
  --allow-unauthenticated --port 8080 --cpu 1 --memory 256Mi --max-instances 2 --min-instances 0 --cpu-boost --concurrency 80 \
  --set-env-vars "^|^GOBIMAN_HOSTED=1|GOBIMAN_LAUNCHER_URL=${GOBIMAN_LAUNCHER_URL:-}|GOBIMAN_LAUNCHER_ELEMENT=${GOBIMAN_LAUNCHER_ELEMENT:-}" --quiet
URL=$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')
echo "· health"; curl -s "$URL/health"; echo
echo "live: $URL"
