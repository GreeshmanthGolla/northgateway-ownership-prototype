#!/usr/bin/env bash
# ==============================================================================
# NorthGateWay GCP Provisioning & Cloud Run Deployment Script
# ==============================================================================
# This script provisions all GCP infrastructure required by NorthGateWay:
# 1. Enables required Google Cloud APIs
# 2. Creates the Artifact Registry Docker repository
# 3. Creates the Cloud SQL PostgreSQL instance (micro tier for prototype cost-efficiency)
# 4. Seeds Secret Manager secrets for database credentials
# 5. Creates IAM Service Accounts (Deployer and Runtime) with least-privilege roles
# 6. Sets up Workload Identity Federation (WIF) for GitHub Actions CI/CD
# 7. Optionally builds and deploys Cloud Run directly or prints GitHub Actions variables
# ==============================================================================

set -euo pipefail

# Configuration Defaults
PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || echo '')}"
REGION="${GCP_REGION:-asia-south1}"
ARTIFACT_REPO="northgate-repo"
CLOUD_RUN_SERVICE="northgateway-ownership"
SQL_INSTANCE_NAME="northgateway-pg-instance"
DB_NAME="northgateway_kyc"
DB_USER="northgate_admin"
DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 16)}"
GITHUB_REPO="GreeshmanthGolla/northgateway-ownership-prototype"
WIF_POOL_NAME="github-pool"
WIF_PROVIDER_NAME="github-provider"
DEPLOY_SA_NAME="northgate-deployer"
RUNTIME_SA_NAME="northgate-runtime"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Error: PROJECT_ID is not set. Please run: gcloud config set project <YOUR_PROJECT_ID>"
  exit 1
fi

# Retrieve existing password if secret already exists in Secret Manager
if gcloud secrets describe "northgateway-db-password" --project="$PROJECT_ID" >/dev/null 2>&1; then
  EXISTING_PASS=$(gcloud secrets versions access latest --secret="northgateway-db-password" --project="$PROJECT_ID" 2>/dev/null || echo "")
  if [[ -n "$EXISTING_PASS" ]]; then
    DB_PASSWORD="$EXISTING_PASS"
  fi
fi

echo "=================================================================="
echo "NorthGateWay GCP Provisioning"
echo "Project: $PROJECT_ID"
echo "Region:  $REGION"
echo "GitHub:  $GITHUB_REPO"
echo "=================================================================="

# 1. Enable Required GCP APIs
echo "--> Enabling GCP APIs..."
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  --project="$PROJECT_ID"

# 2. Create Artifact Registry Repository
echo "--> Checking Artifact Registry repository '$ARTIFACT_REPO'..."
if ! gcloud artifacts repositories describe "$ARTIFACT_REPO" --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "--> Creating Artifact Registry repository..."
  gcloud artifacts repositories create "$ARTIFACT_REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --description="NorthGateWay ownership prototype images" \
    --project="$PROJECT_ID"
else
  echo "--> Artifact Registry repository already exists."
fi

# 3. Create Cloud SQL PostgreSQL Instance
echo "--> Checking Cloud SQL instance '$SQL_INSTANCE_NAME'..."
if ! gcloud sql instances describe "$SQL_INSTANCE_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "--> Creating Cloud SQL PostgreSQL instance conforming to lab org policies..."
  echo "    (Tier: 2 vCPU 8GB RAM, Edition: Enterprise, Zonal, Disk: 20GB)..."
  gcloud sql instances create "$SQL_INSTANCE_NAME" \
    --database-version=POSTGRES_15 \
    --tier=db-custom-2-8192 \
    --edition=enterprise \
    --availability-type=ZONAL \
    --storage-size=20GB \
    --no-storage-auto-increase \
    --region="$REGION" \
    --root-password="$DB_PASSWORD" \
    --project="$PROJECT_ID"
else
  echo "--> Cloud SQL instance already exists."
fi

CLOUD_SQL_CONNECTION_NAME="${PROJECT_ID}:${REGION}:${SQL_INSTANCE_NAME}"

# Create Database and Application User
echo "--> Ensuring database '$DB_NAME' exists..."
if ! gcloud sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE_NAME" --project="$PROJECT_ID"
fi

echo "--> Ensuring database user '$DB_USER' exists..."
if ! gcloud sql users list --instance="$SQL_INSTANCE_NAME" --project="$PROJECT_ID" | grep -q "$DB_USER"; then
  gcloud sql users create "$DB_USER" --instance="$SQL_INSTANCE_NAME" --password="$DB_PASSWORD" --project="$PROJECT_ID"
fi

# 4. Secret Manager for Database Credentials
create_or_update_secret() {
  local name="$1"
  local value="$2"
  if ! gcloud secrets describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "--> Creating secret '$name' in location $REGION..."
    printf "%s" "$value" | gcloud secrets create "$name" \
      --replication-policy="user-managed" \
      --locations="$REGION" \
      --data-file=- \
      --project="$PROJECT_ID"
  else
    echo "--> Updating secret '$name'..."
    printf "%s" "$value" | gcloud secrets versions add "$name" --data-file=- --project="$PROJECT_ID"
  fi
}

create_or_update_secret "northgateway-db-name" "$DB_NAME"
create_or_update_secret "northgateway-db-user" "$DB_USER"
create_or_update_secret "northgateway-db-password" "$DB_PASSWORD"

# 5. Create Service Accounts
DEPLOY_SA="${DEPLOY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "--> Setting up Deployer Service Account ($DEPLOY_SA)..."
if ! gcloud iam service-accounts describe "$DEPLOY_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$DEPLOY_SA_NAME" \
    --display-name="NorthGateWay GitHub Actions Deployer" \
    --project="$PROJECT_ID"
fi

echo "--> Setting up Runtime Service Account ($RUNTIME_SA)..."
if ! gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$RUNTIME_SA_NAME" \
    --display-name="NorthGateWay Cloud Run Runtime" \
    --project="$PROJECT_ID"
fi

# Assign IAM roles to Deployer SA (if permitted by lab account)
echo "--> Setting IAM permissions (skipping if restricted by lab policy)..."
for role in roles/run.admin roles/artifactregistry.writer roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOY_SA}" \
    --role="$role" \
    --condition=None >/dev/null 2>&1 || true
done

# Assign IAM roles to Runtime SA (if permitted by lab account)
for role in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="$role" \
    --condition=None >/dev/null 2>&1 || true
done

# 6. Workload Identity Federation for GitHub Actions
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
WIF_PROVIDER_RESOURCE=""

echo "--> Checking Workload Identity Federation for GitHub Actions..."
if ! gcloud iam workload-identity-pools describe "$WIF_POOL_NAME" --location="global" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$WIF_POOL_NAME" \
    --location="global" \
    --display-name="GitHub Actions Pool" \
    --project="$PROJECT_ID" 2>/dev/null || echo "--> Note: WIF Pool creation skipped (restricted by lab policy)."
fi

if gcloud iam workload-identity-pools describe "$WIF_POOL_NAME" --location="global" --project="$PROJECT_ID" >/dev/null 2>&1; then
  if ! gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER_NAME" \
    --workload-identity-pool="$WIF_POOL_NAME" \
    --location="global" \
    --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER_NAME" \
      --workload-identity-pool="$WIF_POOL_NAME" \
      --location="global" \
      --issuer-uri="https://token.actions.githubusercontent.com" \
      --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
      --project="$PROJECT_ID" 2>/dev/null || true
  fi

  # Allow GitHub Actions repository to impersonate the Deployer Service Account
  gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_NAME}/attribute.repository/${GITHUB_REPO}" \
    --project="$PROJECT_ID" >/dev/null 2>&1 || true

  WIF_PROVIDER_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_NAME}/providers/${WIF_PROVIDER_NAME}"
fi

# 7. Build & Deploy to Cloud Run from Cloud Shell
echo ""
echo "--> Building container image with Google Cloud Build..."
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/${CLOUD_RUN_SERVICE}:latest"
if ! gcloud builds submit --tag "$IMAGE" . --project="$PROJECT_ID"; then
  echo "--> Cloud Build fallback: building with local docker in Cloud Shell..."
  docker build -t "$IMAGE" .
  docker push "$IMAGE"
fi

echo "--> Deploying NorthGateWay to Google Cloud Run..."
SERVICE_URL=""
if gcloud run deploy "$CLOUD_RUN_SERVICE" \
  --image="$IMAGE" \
  --region="$REGION" \
  --platform=managed \
  --port=8080 \
  --memory=512Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=5 \
  --allow-unauthenticated \
  --add-cloudsql-instances="$CLOUD_SQL_CONNECTION_NAME" \
  --set-env-vars="NODE_ENV=production,PORT=8080,OWNERSHIP_THRESHOLD=25,PGHOST=/cloudsql/${CLOUD_SQL_CONNECTION_NAME},PGPORT=5432,PGDATABASE=${DB_NAME},PGUSER=${DB_USER},PGPASSWORD=${DB_PASSWORD}" \
  --project="$PROJECT_ID"; then
  SERVICE_URL=$(gcloud run services describe "$CLOUD_RUN_SERVICE" --region="$REGION" --project="$PROJECT_ID" --format="value(status.url)")
else
  echo "--> Note: Retrying deployment with private access (org policy restricted allUsers)..."
  gcloud run deploy "$CLOUD_RUN_SERVICE" \
    --image="$IMAGE" \
    --region="$REGION" \
    --platform=managed \
    --port=8080 \
    --memory=512Mi \
    --cpu=1 \
    --min-instances=0 \
    --max-instances=5 \
    --no-allow-unauthenticated \
    --add-cloudsql-instances="$CLOUD_SQL_CONNECTION_NAME" \
    --set-env-vars="NODE_ENV=production,PORT=8080,OWNERSHIP_THRESHOLD=25,PGHOST=/cloudsql/${CLOUD_SQL_CONNECTION_NAME},PGPORT=5432,PGDATABASE=${DB_NAME},PGUSER=${DB_USER},PGPASSWORD=${DB_PASSWORD}" \
    --project="$PROJECT_ID"
  SERVICE_URL=$(gcloud run services describe "$CLOUD_RUN_SERVICE" --region="$REGION" --project="$PROJECT_ID" --format="value(status.url)")
fi

echo ""
echo "=================================================================="
echo "DEPLOYMENT COMPLETE!"
if [[ -n "$SERVICE_URL" ]]; then
  echo "Live Cloud Run URL: $SERVICE_URL"
fi
echo "=================================================================="
echo "GitHub Actions CI/CD Configuration"
echo "Add these 5 Variables in your GitHub Repository Settings:"
echo "URL: https://github.com/${GITHUB_REPO}/settings/variables/actions"
echo ""
echo "Variable Name                 Value"
echo "----------------------------  -------------------------------------"
echo "GCP_PROJECT_ID                $PROJECT_ID"
echo "GCP_REGION                    $REGION"
echo "GCP_WIF_PROVIDER              $WIF_PROVIDER_RESOURCE"
echo "GCP_DEPLOY_SERVICE_ACCOUNT    $DEPLOY_SA"
echo "GCP_RUNTIME_SERVICE_ACCOUNT   $RUNTIME_SA"
echo "CLOUD_SQL_INSTANCE            $CLOUD_SQL_CONNECTION_NAME"
echo "=================================================================="
echo ""
echo "Once these variables are set in GitHub, every push to 'main'"
echo "will automatically test and deploy to Cloud Run!"
