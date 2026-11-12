import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  applyDeterministicFlags,
  calculateOwnership,
  extractClaims,
  indexDocument,
  makeDocument,
  validateClaimSource,
  type ClaimFields,
  type DocumentRecord,
  type FieldState,
  type OwnershipClaim,
  type SourceLine,
} from "./domain.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const publicDirectory = join(here, "..", "public");
const port = Number(process.env.PORT ?? 3000);
const threshold = Number(process.env.OWNERSHIP_THRESHOLD ?? 25);
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool();
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const FIELD_KEYS = ["owner", "percentage", "targetEntity", "ownerType", "controlBasis"] as const;

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface AuditEvent {
  id: string;
  claimId: string | null;
  documentId: string | null;
  eventType: string;
  analystId: string;
  timestamp: string;
  fieldName: string | null;
  originalValue: unknown;
  newValue: unknown;
  reason: string;
  metadata: Record<string, unknown>;
}

const schema = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY,
  filename TEXT NOT NULL,
  version INTEGER NOT NULL,
  sha256 CHAR(64) NOT NULL,
  content TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  current BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id),
  document_name TEXT NOT NULL,
  page INTEGER NOT NULL,
  line_id TEXT NOT NULL,
  quote TEXT NOT NULL,
  owner TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  percentage NUMERIC(8,4) NOT NULL,
  target_entity TEXT NOT NULL,
  control_basis TEXT NOT NULL,
  flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  fields JSONB NOT NULL,
  model_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  validation_outcome TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID,
  document_id UUID,
  event_type TEXT NOT NULL,
  analyst_id TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  field_name TEXT,
  original_value JSONB,
  new_value JSONB,
  reason TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE INDEX IF NOT EXISTS claims_document_id_idx ON claims(document_id);
CREATE INDEX IF NOT EXISTS audit_log_timestamp_idx ON audit_log(timestamp DESC);
`;

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    if (error instanceof RequestError) {
      sendJson(response, error.status, { error: error.message });
      return;
    }
    console.error(error);
    sendJson(response, 500, { error: "Internal server error" });
  });
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url);
    return;
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url);
    return;
  }
  await serveStatic(url.pathname, response);
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  if (request.method === "GET" && url.pathname === "/api/state") {
    const [documents, claims, audit] = await Promise.all([loadDocuments(), loadClaims(), loadAudit()]);
    const confirmed = calculateOwnership(claims, threshold);
    sendJson(response, 200, {
      documents: documents.map(({ content, ...document }) => document),
      claims,
      audit,
      confirmed,
      threshold,
      summary: {
        documents: documents.length,
        totalClaims: claims.length,
        flaggedClaims: claims.filter(isJudgmentClaim).length,
        unverifiedFields: claims.reduce((total, claim) =>
          total + FIELD_KEYS.filter((field) => claim.fields[field] === "pre-filled").length, 0),
        confirmedOwners: confirmed.length,
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/documents/") && url.pathname.endsWith("/lines")) {
    const documentId = url.pathname.split("/")[3];
    const document = await loadDocument(documentId);
    if (!document) return sendJson(response, 404, { error: "Document not found" });
    return sendJson(response, 200, { lines: indexDocument(document) });
  }

  if (request.method === "POST" && url.pathname === "/api/documents") {
    const input = await readJson<{ filename?: string; content?: string }>(request);
    if (!input.filename || typeof input.content !== "string" || input.content.trim().length === 0) {
      return sendJson(response, 400, { error: "Provide a filename and non-empty synthetic text content" });
    }
    if (input.content.length > MAX_BODY_BYTES) {
      return sendJson(response, 413, { error: "Document exceeds the 5 MB prototype limit" });
    }
    const existing = await pool.query<{ version: number }>(
      "SELECT COALESCE(MAX(version), 0)::int AS version FROM documents",
    );
    const document = makeDocument(input.content, input.filename, Number(existing.rows[0]?.version ?? 0) + 1);
    const lines = indexDocument(document);
    const extracted = extractClaims(document, lines);
    const sourceValidated = extracted.filter((claim) => validateClaimSource(claim, lines));
    const discarded = extracted.filter((claim) => !validateClaimSource(claim, lines));
    const existingClaims = await loadClaims();
    const allClaims = applyDeterministicFlags([...existingClaims, ...sourceValidated]);
    const newIds = new Set(sourceValidated.map((claim) => claim.id));
    const validated = allClaims.filter((claim) => newIds.has(claim.id));
    const changedExisting = allClaims.filter((claim) => {
      const previous = existingClaims.find((item) => item.id === claim.id);
      return previous && JSON.stringify(previous.flags) !== JSON.stringify(claim.flags);
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE documents SET current = FALSE WHERE current = TRUE");
      await client.query(
        `INSERT INTO documents (id, filename, version, sha256, content, page_count, current, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)`,
        [document.id, document.filename, document.version, document.sha256, document.content, document.pageCount, document.createdAt],
      );
      for (const claim of validated) await insertClaim(client, claim);
      for (const claim of changedExisting) {
        const previous = existingClaims.find((item) => item.id === claim.id);
        if (!previous) continue;
        await updateClaim(client, claim);
        await appendAudit(client, {
          claimId: claim.id,
          documentId: claim.documentId,
          eventType: "flag_engine_updated",
          analystId: "system",
          originalValue: previous.flags,
          newValue: claim.flags,
          reason: "Deterministic ownership-chain and cross-document conflict checks",
          metadata: { triggeringDocumentId: document.id },
        });
      }
      await appendAudit(client, {
        documentId: document.id,
        eventType: "document_ingested",
        analystId: "system",
        reason: "",
        metadata: { filename: document.filename, sha256: document.sha256, pageCount: document.pageCount, extracted: extracted.length, validated: validated.length },
      });
      for (const claim of discarded) {
        await appendAudit(client, {
          claimId: claim.id,
          documentId: document.id,
          eventType: "extraction_failed_source_validation",
          analystId: "system",
          reason: "Source quote could not be verified against the page and line index",
          metadata: { lineId: claim.lineId, quote: claim.quote },
        });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return sendJson(response, 201, { document, extractedClaims: validated.length, discardedClaims: discarded.length });
  }

  const reviewMatch = /^\/api\/claims\/([0-9a-f-]+)\/review$/i.exec(url.pathname);
  if (request.method === "POST" && reviewMatch) {
    const input = await readJson<{ action?: string; values?: Record<string, unknown>; analystId?: string; reason?: string }>(request);
    const action = input.action;
    if (action !== "accept" && action !== "edit" && action !== "reject" && action !== "escalate") {
      return sendJson(response, 400, { error: "Action must be accept, edit, reject, or escalate" });
    }
    const claimId = reviewMatch[1];
    if (!claimId) return sendJson(response, 400, { error: "Claim ID is required" });
    const claim = await loadClaim(claimId);
    if (!claim) return sendJson(response, 404, { error: "Claim not found" });
    if ((action === "edit" || action === "reject" || action === "escalate") && !input.reason?.trim()) {
      return sendJson(response, 400, { error: "A reason is required for edit, reject, and escalate decisions" });
    }
    const update = applyReviewAction(claim, action, input.values ?? {}, input.reason ?? "");
    if ("error" in update) return sendJson(response, 400, { error: update.error });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await updateClaim(client, update.claim);
      for (const event of update.events) {
        await appendAudit(client, {
          claimId: claim.id,
          documentId: claim.documentId,
          eventType: `field_${event.state}`,
          analystId: input.analystId?.trim() || "AC-8821",
          fieldName: event.field,
          originalValue: event.originalValue,
          newValue: event.newValue,
          reason: input.reason ?? "",
          metadata: { modelVersion: claim.modelVersion, promptVersion: claim.promptVersion, validationOutcome: claim.validationOutcome },
        });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return sendJson(response, 200, { claim: update.claim });
  }

  const resolveMatch = /^\/api\/claims\/([0-9a-f-]+)\/resolve-flag$/i.exec(url.pathname);
  if (request.method === "POST" && resolveMatch) {
    const input = await readJson<{ flag?: string; reason?: string; analystId?: string }>(request);
    if (!input.flag?.trim() || !input.reason?.trim()) {
      return sendJson(response, 400, { error: "A flag and resolution reason are required" });
    }
    const claimId = resolveMatch[1];
    if (!claimId) return sendJson(response, 400, { error: "Claim ID is required" });
    const claim = await loadClaim(claimId);
    if (!claim) return sendJson(response, 404, { error: "Claim not found" });
    if (!claim.flags.includes(input.flag)) return sendJson(response, 404, { error: "Flag not found on claim" });
    const updated = { ...claim, flags: claim.flags.filter((flag) => flag !== input.flag) };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await updateClaim(client, updated);
      await appendAudit(client, {
        claimId: claim.id,
        documentId: claim.documentId,
        eventType: "flag_resolved",
        analystId: input.analystId?.trim() || "AC-8821",
        originalValue: input.flag,
        newValue: null,
        reason: input.reason,
        metadata: {},
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return sendJson(response, 200, { claim: updated });
  }

  if (request.method === "GET" && url.pathname === "/api/confirmed-record") {
    const claims = await loadClaims();
    return sendJson(response, 200, {
      caseId: "KYC-94021",
      ownershipThreshold: threshold,
      owners: calculateOwnership(claims, threshold),
      generatedAt: new Date().toISOString(),
    });
  }

  sendJson(response, 404, { error: "API route not found" });
}

function applyReviewAction(
  claim: OwnershipClaim,
  action: string,
  values: Record<string, unknown>,
  reason: string,
): { claim: OwnershipClaim; events: Array<{ field: keyof ClaimFields; state: FieldState; originalValue: unknown; newValue: unknown }> } | { error: string } {
  if (action === "edit" && Object.keys(values).length === 0) return { error: "Provide at least one field value to edit" };
  const updated = { ...claim, fields: { ...claim.fields } };
  const events: Array<{ field: keyof ClaimFields; state: FieldState; originalValue: unknown; newValue: unknown }> = [];
  const state: FieldState = action === "accept" ? "accepted" : action === "edit" ? "edited" : action === "reject" ? "rejected" : "escalated";
  const allowedTransitions: Record<FieldState, FieldState[]> = {
    "pre-filled": ["accepted", "edited", "rejected", "escalated"],
    accepted: ["edited", "rejected", "escalated"],
    edited: ["accepted", "edited", "rejected", "escalated"],
    rejected: ["escalated"],
    escalated: ["accepted", "edited", "rejected"],
  };

  for (const field of FIELD_KEYS) {
    if (action === "edit" && !(field in values)) continue;
    const previous = updated[field];
    let next: unknown = previous;
    if (action === "edit") {
      next = values[field];
      if (field === "percentage") {
        if (typeof next !== "number" || !Number.isFinite(next) || next <= 0 || next > 100) return { error: "Percentage must be a number greater than 0 and no greater than 100" };
      } else if (field === "ownerType") {
        if (next !== "person" && next !== "entity" && next !== "unresolved") return { error: "Owner type must be person, entity, or unresolved" };
      } else if (typeof next !== "string" || !next.trim()) {
        return { error: `${field} must be a non-empty string` };
      }
      if (typeof next === "string") next = next.trim();
      if (next === previous) continue;
      (updated as unknown as Record<string, unknown>)[field] = next;
    }
    if (claim.fields[field] === state) continue;
    if (!allowedTransitions[claim.fields[field]].includes(state)) {
      return { error: `Cannot move ${field} from ${claim.fields[field]} to ${state}` };
    }
    updated.fields[field] = state;
    events.push({ field, state, originalValue: previous, newValue: next });
  }
  if (events.length === 0) return { error: action === "edit" ? "Edit must change at least one field" : "No field transitions are available for this action" };
  if (!reason && action !== "accept") return { error: "A reason is required for this decision" };
  return { claim: updated, events };
}

function isJudgmentClaim(claim: OwnershipClaim): boolean {
  return claim.flags.length > 0 || Object.values(claim.fields).includes("escalated");
}

async function insertClaim(client: import("pg").PoolClient, claim: OwnershipClaim): Promise<void> {
  await client.query(
    `INSERT INTO claims (
      id, document_id, document_name, page, line_id, quote, owner, owner_type, percentage,
      target_entity, control_basis, flags, fields, model_version, prompt_version, validation_outcome
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16)`,
    [
      claim.id, claim.documentId, claim.documentName, claim.page, claim.lineId, claim.quote, claim.owner,
      claim.ownerType, claim.percentage, claim.targetEntity, claim.controlBasis, JSON.stringify(claim.flags),
      JSON.stringify(claim.fields), claim.modelVersion, claim.promptVersion, claim.validationOutcome,
    ],
  );
}

async function updateClaim(client: import("pg").PoolClient, claim: OwnershipClaim): Promise<void> {
  await client.query(
    `UPDATE claims SET owner=$2, owner_type=$3, percentage=$4, target_entity=$5, control_basis=$6,
      flags=$7::jsonb, fields=$8::jsonb WHERE id=$1`,
    [claim.id, claim.owner, claim.ownerType, claim.percentage, claim.targetEntity, claim.controlBasis, JSON.stringify(claim.flags), JSON.stringify(claim.fields)],
  );
}

async function appendAudit(client: import("pg").PoolClient, event: Partial<AuditEvent> & Pick<AuditEvent, "eventType" | "analystId">): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (claim_id, document_id, event_type, analyst_id, field_name, original_value, new_value, reason, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb)`,
    [
      event.claimId ?? null,
      event.documentId ?? null,
      event.eventType,
      event.analystId,
      event.fieldName ?? null,
      event.originalValue === undefined ? null : JSON.stringify(event.originalValue),
      event.newValue === undefined ? null : JSON.stringify(event.newValue),
      event.reason ?? "",
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}

async function loadDocuments(): Promise<DocumentRecord[]> {
  const result = await pool.query("SELECT * FROM documents ORDER BY created_at DESC");
  return result.rows.map(mapDocument);
}

async function loadDocument(id: string): Promise<DocumentRecord | null> {
  const result = await pool.query("SELECT * FROM documents WHERE id=$1", [id]);
  return result.rows[0] ? mapDocument(result.rows[0]) : null;
}

async function loadClaims(): Promise<OwnershipClaim[]> {
  const result = await pool.query("SELECT * FROM claims ORDER BY page, owner");
  return result.rows.map(mapClaim);
}

async function loadClaim(id: string): Promise<OwnershipClaim | null> {
  const result = await pool.query("SELECT * FROM claims WHERE id=$1", [id]);
  return result.rows[0] ? mapClaim(result.rows[0]) : null;
}

async function loadAudit(): Promise<AuditEvent[]> {
  const result = await pool.query(
    `SELECT id, claim_id, document_id, event_type, analyst_id, timestamp, field_name,
      original_value, new_value, reason, metadata FROM audit_log ORDER BY timestamp DESC LIMIT 300`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    claimId: row.claim_id,
    documentId: row.document_id,
    eventType: row.event_type,
    analystId: row.analyst_id,
    timestamp: new Date(row.timestamp).toISOString(),
    fieldName: row.field_name,
    originalValue: row.original_value,
    newValue: row.new_value,
    reason: row.reason,
    metadata: row.metadata,
  }));
}

function mapDocument(row: Record<string, unknown>): DocumentRecord {
  return {
    id: String(row.id),
    filename: String(row.filename),
    version: Number(row.version),
    sha256: String(row.sha256).trim(),
    content: String(row.content),
    pageCount: Number(row.page_count),
    current: Boolean(row.current),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function mapClaim(row: Record<string, unknown>): OwnershipClaim {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    documentName: String(row.document_name),
    page: Number(row.page),
    lineId: String(row.line_id),
    quote: String(row.quote),
    owner: String(row.owner),
    ownerType: row.owner_type as OwnershipClaim["ownerType"],
    percentage: Number(row.percentage),
    targetEntity: String(row.target_entity),
    controlBasis: String(row.control_basis),
    flags: row.flags as string[],
    fields: row.fields as ClaimFields,
    modelVersion: String(row.model_version),
    promptVersion: String(row.prompt_version),
    validationOutcome: row.validation_outcome as OwnershipClaim["validationOutcome"],
  };
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new RequestError(413, "Request body exceeds the 5 MB limit");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new RequestError(400, "Invalid JSON request body");
  }
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const safePath = normalize(pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
  if (safePath.startsWith("..")) return sendJson(response, 404, { error: "Not found" });
  const path = join(publicDirectory, safePath);
  try {
    const content = await readFile(path);
    const type = extname(path) === ".css" ? "text/css" : extname(path) === ".js" ? "text/javascript" : "text/html";
    response.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
    response.end(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (pathname.startsWith("/api/")) return sendJson(response, 404, { error: "Not found" });
    const content = await readFile(join(publicDirectory, "index.html"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(content);
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function start(): Promise<void> {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error("OWNERSHIP_THRESHOLD must be a number between 0 and 100");
  }
  await pool.query(schema);
  const count = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM documents");
  if (Number(count.rows[0]?.count ?? 0) === 0) await seedSyntheticCase();
  server.listen(port, () => console.log(`NorthGateWay prototype listening at http://localhost:${port}`));
}

async function seedSyntheticCase(): Promise<void> {
  const content = [
    "Harbor Ventures Ltd holds 60% of Apex Maritime Holdings Ltd.",
    "Elena Ward holds 40% of Apex Maritime Holdings Ltd.",
    "Daniel Cole holds 50% of Harbor Ventures Ltd.",
    "Mei Lin holds 50% of Harbor Ventures Ltd.",
  ].join("\n");
  const document = makeDocument(content, "apex-shareholder-register.txt", 1);
  const lines = indexDocument(document);
  const claims = extractClaims(document, lines).filter((claim) => validateClaimSource(claim, lines));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO documents (id, filename, version, sha256, content, page_count, current, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7)`,
      [document.id, document.filename, document.version, document.sha256, document.content, document.pageCount, document.createdAt],
    );
    for (const claim of claims) await insertClaim(client, claim);
    await appendAudit(client, {
      documentId: document.id,
      eventType: "synthetic_case_seeded",
      analystId: "system",
      reason: "Synthetic prototype data",
      metadata: { modelVersion: "synthetic-extractor-0.1", promptVersion: "ownership-claims-0.1" },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

void start().catch((error: unknown) => {
  console.error("Could not start the service. Check DATABASE_URL and PostgreSQL availability.", error);
  process.exitCode = 1;
});
