<#
.SYNOPSIS
    NorthGateWay GCP Provisioning and Cloud Run Deployment Setup
#>
param(
    [string]$ProjectId = $env:GCP_PROJECT_ID,
    [string]$Region = "asia-south1",
    [string]$GitHubRepo = "GreeshmanthGolla/northgateway-ownership-prototype"
)

$ErrorActionPreference = "Stop"

if (-not $ProjectId) {
    $ProjectId = (gcloud config get-value project 2>$null).Trim()
}

if (-not $ProjectId) {
    Write-Error "GCP Project ID is required. Please pass -ProjectId <id> or set default gcloud project."
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "NorthGateWay GCP Setup" -ForegroundColor Cyan
Write-Host "Project: $ProjectId"
Write-Host "Region:  $Region"
Write-Host "GitHub:  $GitHubRepo"
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Enable APIs
Write-Host "--> Enabling GCP APIs..." -ForegroundColor Yellow
gcloud services enable `
  run.googleapis.com `
  artifactregistry.googleapis.com `
  cloudbuild.googleapis.com `
  sqladmin.googleapis.com `
  secretmanager.googleapis.com `
  iam.googleapis.com `
  iamcredentials.googleapis.com `
  --project=$ProjectId

# 2. Artifact Registry
Write-Host "--> Ensuring Artifact Registry repository..." -ForegroundColor Yellow
$repoCheck = gcloud artifacts repositories describe northgate-repo --location=$Region --project=$ProjectId 2>$null
if (-not $repoCheck) {
    gcloud artifacts repositories create northgate-repo `
      --repository-format=docker `
      --location=$Region `
      --description="NorthGateWay prototype images" `
      --project=$ProjectId
}

# 3. Cloud SQL
$sqlInstance = "northgateway-pg-instance"
Write-Host "--> Checking Cloud SQL instance $sqlInstance..." -ForegroundColor Yellow
$sqlCheck = gcloud sql instances describe $sqlInstance --project=$ProjectId 2>$null
$dbPass = [System.Guid]::NewGuid().ToString("N").Substring(0, 16)

if (-not $sqlCheck) {
    Write-Host "--> Creating Cloud SQL instance (approx 4-6 minutes, Org Policy compliant)..." -ForegroundColor Yellow
    gcloud sql instances create $sqlInstance `
      --database-version=POSTGRES_15 `
      --tier=db-custom-2-8192 `
      --edition=enterprise `
      --availability-type=ZONAL `
      --storage-size=20GB `
      --no-storage-auto-increase `
      --region=$Region `
      --root-password=$dbPass `
      --project=$ProjectId
}

$sqlConnection = "${ProjectId}:${Region}:${sqlInstance}"

# Databases & Users
gcloud sql databases create northgateway_kyc --instance=$sqlInstance --project=$ProjectId 2>$null
gcloud sql users create northgate_admin --instance=$sqlInstance --password=$dbPass --project=$ProjectId 2>$null

# 4. Secrets
function Set-GcpSecret($name, $val) {
    $sec = gcloud secrets describe $name --project=$ProjectId 2>$null
    if (-not $sec) {
        $val | gcloud secrets create $name --replication-policy="user-managed" --locations=$Region --data-file=- --project=$ProjectId
    } else {
        $val | gcloud secrets versions add $name --data-file=- --project=$ProjectId
    }
}

Set-GcpSecret "northgateway-db-name" "northgateway_kyc"
Set-GcpSecret "northgateway-db-user" "northgate_admin"
Set-GcpSecret "northgateway-db-password" $dbPass

# 5. Service Accounts
$deploySa = "northgate-deployer@${ProjectId}.iam.gserviceaccount.com"
$runtimeSa = "northgate-runtime@${ProjectId}.iam.gserviceaccount.com"

gcloud iam service-accounts create northgate-deployer --display-name="NorthGateWay Deployer" --project=$ProjectId 2>$null
gcloud iam service-accounts create northgate-runtime --display-name="NorthGateWay Runtime" --project=$ProjectId 2>$null

foreach ($role in @("roles/run.admin", "roles/artifactregistry.writer", "roles/iam.serviceAccountUser")) {
    gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:${deploySa}" --role=$role --condition=None | Out-Null
}
foreach ($role in @("roles/cloudsql.client", "roles/secretmanager.secretAccessor")) {
    gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:${runtimeSa}" --role=$role --condition=None | Out-Null
}

# 6. Workload Identity Federation
$projectNum = (gcloud projects describe $ProjectId --format="value(projectNumber)").Trim()
$wifPool = "github-pool"
$wifProvider = "github-provider"

gcloud iam workload-identity-pools create $wifPool --location="global" --display-name="GitHub Actions Pool" --project=$ProjectId 2>$null
gcloud iam workload-identity-pools providers create-oidc $wifProvider `
  --workload-identity-pool=$wifPool `
  --location="global" `
  --issuer-uri="https://token.actions.githubusercontent.com" `
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" `
  --project=$ProjectId 2>$null

gcloud iam service-accounts add-iam-policy-binding $deploySa `
  --role="roles/iam.workloadIdentityUser" `
  --member="principalSet://iam.googleapis.com/projects/${projectNum}/locations/global/workloadIdentityPools/${wifPool}/attribute.repository/${GitHubRepo}" `
  --project=$ProjectId | Out-Null

$wifResource = "projects/${projectNum}/locations/global/workloadIdentityPools/${wifPool}/providers/${wifProvider}"

Write-Host "==========================================================" -ForegroundColor Green
Write-Host "SUCCESS! Configure these variables in GitHub Repository:" -ForegroundColor Green
Write-Host "URL: https://github.com/${GitHubRepo}/settings/variables/actions" -ForegroundColor Green
Write-Host "GCP_PROJECT_ID:              $ProjectId"
Write-Host "GCP_REGION:                  $Region"
Write-Host "GCP_WIF_PROVIDER:            $wifResource"
Write-Host "GCP_DEPLOY_SERVICE_ACCOUNT:  $deploySa"
Write-Host "GCP_RUNTIME_SERVICE_ACCOUNT: $runtimeSa"
Write-Host "CLOUD_SQL_INSTANCE:          $sqlConnection"
Write-Host "==========================================================" -ForegroundColor Green
