# NorthGateWay ownership intelligence prototype

A synthetic-data TypeScript prototype for source-backed ownership claim preparation and analyst review. It implements the document-to-review flow in [`workflow.txt`](../stitch_automated_kyc_ownership_mapper/workflow.txt) and [`architecture.txt`](../stitch_automated_kyc_ownership_mapper/architecture.txt).

## Run locally

Requirements: Node.js 20+ and PostgreSQL 13+.

1. Create a local database, for example `northgateway_kyc`.
2. Copy `.env.example` to `.env` and set `DATABASE_URL` for that database. The example values are local development placeholders.
3. Install packages and start the service:

   ```powershell
   npm install
   npm run dev
   ```

4. Open <http://localhost:3000>. On an empty database, the service seeds a clearly synthetic Apex Maritime case.

For a production-style build, run `npm run build` and `npm start` with the same environment variables.

## GitHub Actions and Google Cloud Run

The workflow at `.github/workflows/deploy.yml` runs `npm ci` and `npm test` for pull requests and pushes to `main`. A successful push to `main` builds the container, pushes it to Artifact Registry, and deploys a **private** Cloud Run service. It uses Workload Identity Federation; it does not store a Google service-account key in GitHub. The Cloud Run service connects to Cloud SQL through its Unix socket. No real customer documents should be used with this prototype.

Before deploying, create a GitHub repository for this folder and configure these repository **Actions variables**:

| Variable | Value |
| --- | --- |
| `GCP_PROJECT_ID` | Exact Google Cloud project ID (defaults to `slabspro-slabsuser40`) |
| `GCP_REGION` | Cloud Run, Artifact Registry, and Cloud SQL region (defaults to `asia-south1`) |
| `GCP_WIF_PROVIDER` | Full Workload Identity Provider resource name |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | Email of the GitHub Actions deployment service account |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | Email of the Cloud Run runtime service account |
| `CLOUD_SQL_INSTANCE` | Cloud SQL connection name: `project:region:instance` |
| `DB_NAME_SECRET` | Secret Manager secret containing the PostgreSQL database name (defaults to `northgateway-db-name`) |
| `DB_USER_SECRET` | Secret Manager secret containing the PostgreSQL username (defaults to `northgateway-db-user`) |
| `DB_PASSWORD_SECRET` | Secret Manager secret containing the PostgreSQL password (defaults to `northgateway-db-password`) |

Provision Cloud SQL for PostgreSQL and the three Secret Manager secrets before the first deployment. Grant the Cloud Run runtime service account `roles/cloudsql.client` and `roles/secretmanager.secretAccessor`. Grant the deployment service account the permissions to deploy Cloud Run services, push Artifact Registry images, and use the runtime service account. Configure Workload Identity Federation to trust only this GitHub repository and grant its principal `roles/iam.workloadIdentityUser` on the deployment service account. Enable the Cloud Run, Cloud Build/Artifact Registry, IAM Credentials, Secret Manager, and Cloud SQL Admin APIs as needed. Do not put credentials in workflow files or commit them.

The workflow deliberately does not allow unauthenticated Cloud Run access: this prototype has no user authentication or authorization. After deployment, grant `roles/run.invoker` only to intended users or an authenticated identity-aware proxy. Do not expose this prototype with real customer data.

Commit this folder as the root of the GitHub repository. GitHub Actions only discovers workflow files under `.github/workflows/`; the supplied root `deploy.yml` is represented by the app-specific workflow at that path.

## Prototype workflow

- Upload a synthetic `.txt` share register. Separate pages may be represented with form-feed characters.
- The deterministic extractor accepts lines in this shape: `Owner Name holds 60% of Entity Name Ltd.`
- Each extracted claim is tied to a document ID, page, stable line ID, exact quote, model version, and prompt version.
- Source validation checks the quote against the indexed line before a claim is stored.
- The analyst can accept, edit, reject, or escalate claim fields. Edits and decisions require reasons where appropriate and are written to `audit_log`.
- Corporate ownership-chain gaps and conflicting declarations are flagged for judgment. Flag resolution is itself audited.
- Effective ownership multiplies percentages along every verified path, sums parallel paths to the same person, and applies the configurable threshold.
- The confirmed-record endpoint is read-only and contains ownership data only. There is deliberately no risk-rating field or risk write route.

## Deliberate prototype boundaries

All input must be synthetic. This first runnable iteration accepts text files only; OCR, PDF extraction/viewing, production model inference, identity/access control, encryption, retention, multi-case tenancy, and case-system integration are not implemented. Extraction uses a narrow deterministic parser as a replaceable stand-in for a pinned structured-output model. Do not use this prototype with real customer data or as a production compliance decision system.

The database creates an append-only audit table enforced by a PostgreSQL trigger. The service is a prototype and does not include production hardening, authorization, migrations, or operational monitoring.
