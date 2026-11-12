import { createHash, randomUUID } from "node:crypto";

export type FieldState = "pre-filled" | "accepted" | "edited" | "rejected" | "escalated";

export interface SourceLine {
  id: string;
  documentId: string;
  page: number;
  lineNumber: number;
  text: string;
  ocr: boolean;
}

export interface DocumentRecord {
  id: string;
  filename: string;
  version: number;
  sha256: string;
  content: string;
  pageCount: number;
  current: boolean;
  createdAt: string;
}

export interface ClaimFields {
  owner: FieldState;
  percentage: FieldState;
  targetEntity: FieldState;
  ownerType: FieldState;
  controlBasis: FieldState;
}

export interface OwnershipClaim {
  id: string;
  documentId: string;
  documentName: string;
  page: number;
  lineId: string;
  quote: string;
  owner: string;
  ownerType: "person" | "entity" | "unresolved";
  percentage: number;
  targetEntity: string;
  controlBasis: string;
  flags: string[];
  fields: ClaimFields;
  modelVersion: string;
  promptVersion: string;
  validationOutcome: "valid" | "invalid";
}

export interface OwnershipPath {
  person: string;
  target: string;
  effectivePercentage: number;
  paths: string[][];
}

const FIELD_NAMES = ["owner", "percentage", "targetEntity", "ownerType", "controlBasis"] as const;
const ENTITY_SUFFIX = /\b(ltd|limited|inc|incorporated|corp|corporation|llc|plc|gmbh|s\.a\.|s\.a\.s\.|bv|llp|company)\b/i;
const OWNERSHIP_LINE = /^\s*(?<owner>.+?)\s+(?:holds?|owns?)\s+(?<percentage>\d{1,3}(?:\.\d{1,4})?)\s*%\s+(?:of|in)\s+(?<target>[^(\r\n]+?)\s*(?:\([^)]*\))?\s*\.?\s*$/i;
const COMPUTED_FLAGS = new Set(["corporate owner chain requires resolution", "conflicting percentages across documents"]);

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function makeDocument(content: string, filename: string, version: number): DocumentRecord {
  const pages = content.split("\f");
  return {
    id: randomUUID(),
    filename,
    version,
    sha256: sha256(content),
    content,
    pageCount: pages.length,
    current: true,
    createdAt: new Date().toISOString(),
  };
}

export function indexDocument(document: DocumentRecord): SourceLine[] {
  return document.content.split("\f").flatMap((pageText, pageIndex) =>
    pageText.split(/\r?\n/).map((text, lineIndex) => ({
      id: `${document.id}-p${pageIndex + 1}-l${lineIndex + 1}`,
      documentId: document.id,
      page: pageIndex + 1,
      lineNumber: lineIndex + 1,
      text,
      ocr: false,
    })),
  );
}

export function extractClaims(
  document: DocumentRecord,
  lines: SourceLine[],
): OwnershipClaim[] {
  const parsed = lines.flatMap((line) => {
    const match = OWNERSHIP_LINE.exec(line.text);
    if (!match?.groups) return [];
    const owner = match.groups.owner.trim();
    const targetEntity = match.groups.target.trim();
    const percentage = Number(match.groups.percentage);
    if (!owner || !targetEntity || percentage <= 0 || percentage > 100) return [];
    return [{ line, owner, targetEntity, percentage }];
  });
  const knownTargets = new Set(parsed.map((item) => normalizeName(item.targetEntity)));

  return parsed.map(({ line, owner, targetEntity, percentage }) => {
    const ownerType = ENTITY_SUFFIX.test(owner) ? "entity" : "person";
    const normalized = line.text.toLowerCase();
    const flags: string[] = [];
    if (/\bnominee\b/.test(normalized)) flags.push("nominee arrangement");
    if (/\btrustee\b|\btrust\b/.test(normalized)) flags.push("trustee arrangement");
    if (/\bcontrol(?:s|ling)?\b/.test(normalized)) flags.push("control claim needs interpretation");
    if (ownerType === "entity" && !knownTargets.has(normalizeName(owner))) {
      flags.push("corporate owner chain requires resolution");
    }

    return {
      id: randomUUID(),
      documentId: document.id,
      documentName: document.filename,
      page: line.page,
      lineId: line.id,
      quote: line.text,
      owner,
      ownerType,
      percentage,
      targetEntity,
      controlBasis: flags.some((flag) => flag.includes("control")) ? "Interpretive control claim" : "Equity ownership",
      flags,
      fields: {
        owner: "pre-filled",
        percentage: "pre-filled",
        targetEntity: "pre-filled",
        ownerType: "pre-filled",
        controlBasis: "pre-filled",
      },
      modelVersion: "synthetic-extractor-0.1",
      promptVersion: "ownership-claims-0.1",
      validationOutcome: "valid",
    };
  });
}

export function validateClaimSource(claim: OwnershipClaim, lines: SourceLine[]): boolean {
  const source = lines.find((line) => line.id === claim.lineId && line.documentId === claim.documentId);
  return Boolean(source && source.page === claim.page && source.text.includes(claim.quote));
}

export function applyDeterministicFlags(claims: OwnershipClaim[]): OwnershipClaim[] {
  const knownTargets = new Set(claims.map((claim) => normalizeName(claim.targetEntity)));
  const percentagesByHolding = new Map<string, Set<number>>();
  for (const claim of claims) {
    const key = `${normalizeName(claim.owner)}|${normalizeName(claim.targetEntity)}`;
    const percentages = percentagesByHolding.get(key) ?? new Set<number>();
    percentages.add(claim.percentage);
    percentagesByHolding.set(key, percentages);
  }

  return claims.map((claim) => {
    const flags = claim.flags.filter((flag) => !COMPUTED_FLAGS.has(flag));
    if (claim.ownerType === "entity" && !knownTargets.has(normalizeName(claim.owner))) {
      flags.push("corporate owner chain requires resolution");
    }
    const holdingKey = `${normalizeName(claim.owner)}|${normalizeName(claim.targetEntity)}`;
    if ((percentagesByHolding.get(holdingKey)?.size ?? 0) > 1) {
      flags.push("conflicting percentages across documents");
    }
    return { ...claim, flags: [...new Set(flags)] };
  });
}

export function calculateOwnership(
  claims: OwnershipClaim[],
  threshold: number,
): OwnershipPath[] {
  const verified = claims.filter((claim) =>
    claim.validationOutcome === "valid" &&
    claim.flags.length === 0 &&
    FIELD_NAMES.every((field) => claim.fields[field] === "accepted" || claim.fields[field] === "edited"),
  );
  const byTarget = new Map<string, OwnershipClaim[]>();
  for (const claim of verified) {
    const key = normalizeName(claim.targetEntity);
    byTarget.set(key, [...(byTarget.get(key) ?? []), claim]);
  }

  const result: OwnershipPath[] = [];
  for (const target of new Set(verified.map((claim) => claim.targetEntity))) {
    const rawPaths = walkOwners(target, 100, [target], byTarget, new Set<string>());
    const grouped = new Map<string, OwnershipPath>();
    for (const path of rawPaths) {
      const key = normalizeName(path.person);
      const existing = grouped.get(key);
      if (existing) {
        existing.effectivePercentage = roundPercentage(existing.effectivePercentage + path.effectivePercentage);
        existing.paths.push(path.paths[0]);
      } else {
        grouped.set(key, path);
      }
    }
    result.push(...[...grouped.values()].filter((path) => path.effectivePercentage >= threshold));
  }
  return result.sort((a, b) => a.target.localeCompare(b.target) || b.effectivePercentage - a.effectivePercentage);
}

function walkOwners(
  target: string,
  multiplier: number,
  path: string[],
  byTarget: Map<string, OwnershipClaim[]>,
  visited: Set<string>,
): OwnershipPath[] {
  const normalizedTarget = normalizeName(target);
  if (visited.has(normalizedTarget)) return [];
  const nextVisited = new Set(visited).add(normalizedTarget);
  const directOwners = byTarget.get(normalizedTarget) ?? [];
  if (directOwners.length === 0) return [];

  const paths: OwnershipPath[] = [];
  for (const holding of directOwners) {
    const effectivePercentage = multiplier * holding.percentage / 100;
    const ownerPath = [...path, holding.owner];
    if (holding.ownerType === "person") {
      paths.push({
        person: holding.owner,
        target: path[0],
        effectivePercentage: roundPercentage(effectivePercentage),
        paths: [ownerPath],
      });
    } else {
      paths.push(...walkOwners(holding.owner, effectivePercentage, ownerPath, byTarget, nextVisited));
    }
  }
  return paths;
}

export function getFieldValue(claim: OwnershipClaim, field: keyof ClaimFields): string | number {
  return claim[field];
}

export function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function roundPercentage(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}
