import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateOwnership,
  applyDeterministicFlags,
  extractClaims,
  indexDocument,
  makeDocument,
  validateClaimSource,
  type OwnershipClaim,
} from "./domain.js";

const accepted = {
  owner: "accepted",
  percentage: "accepted",
  targetEntity: "accepted",
  ownerType: "accepted",
  controlBasis: "accepted",
} as const;

test("indexes stable line references and validates only exact cited source text", () => {
  const document = makeDocument("Alice holds 50% of Example Ltd.\nBob holds 50% of Example Ltd.", "register.txt", 1);
  const lines = indexDocument(document);
  const [claim] = extractClaims(document, lines);

  assert.equal(lines[0].id, `${document.id}-p1-l1`);
  assert.equal(claim.lineId, lines[0].id);
  assert.equal(validateClaimSource(claim, lines), true);
  assert.equal(validateClaimSource({ ...claim, quote: "invented quote" }, lines), false);
});

test("extracts direct and indirect effective ownership and applies a configurable threshold", () => {
  const document = makeDocument(
    "Harbor Ventures Ltd holds 60% of Apex Maritime Holdings Ltd.\nElena Ward holds 40% of Apex Maritime Holdings Ltd.\nDaniel Cole holds 50% of Harbor Ventures Ltd.\nMei Lin holds 50% of Harbor Ventures Ltd.",
    "register.txt",
    1,
  );
  const claims = extractClaims(document, indexDocument(document)).map((claim) => ({
    ...claim,
    flags: [],
    fields: accepted,
  }));
  const result = calculateOwnership(claims, 25);

  assert.deepEqual(
    result.filter((path) => path.target === "Apex Maritime Holdings Ltd").map((path) => [path.person, path.effectivePercentage]),
    [["Elena Ward", 40], ["Daniel Cole", 30], ["Mei Lin", 30]],
  );
  assert.equal(calculateOwnership(claims, 35).some((path) => path.target === "Apex Maritime Holdings Ltd" && path.person === "Daniel Cole"), false);
});

test("sums parallel paths to the same person before applying the threshold", () => {
  const claims: OwnershipClaim[] = [
    { ...claim("Person", "Holding A Ltd", 50, "person"), fields: accepted, flags: [] },
    { ...claim("Holding A Ltd", "Target Ltd", 50, "entity"), fields: accepted, flags: [] },
    { ...claim("Person", "Holding B Ltd", 50, "person"), fields: accepted, flags: [] },
    { ...claim("Holding B Ltd", "Target Ltd", 50, "entity"), fields: accepted, flags: [] },
  ];
  const result = calculateOwnership(claims, 25).filter((path) => path.target === "Target Ltd");

  assert.equal(result.length, 1);
  assert.equal(result[0].effectivePercentage, 50);
  assert.equal(result[0].paths.length, 2);
});

test("cycles do not recurse indefinitely", () => {
  const cycle: OwnershipClaim[] = [
    { ...claim("Person", "Company A Ltd", 50, "person"), fields: accepted, flags: [] },
    { ...claim("Company A Ltd", "Company B Ltd", 50, "entity"), fields: accepted, flags: [] },
    { ...claim("Company B Ltd", "Company A Ltd", 50, "entity"), fields: accepted, flags: [] },
  ];
  const result = calculateOwnership(cycle, 30);
  assert.equal(result.length, 1);
  assert.equal(result[0].target, "Company A Ltd");
  assert.equal(result[0].effectivePercentage, 50);
});

test("flags conflicting declarations and unresolved corporate ownership chains", () => {
  const claims = [
    claim("Holding Ltd", "Target Ltd", 40, "entity"),
    claim("Holding Ltd", "Target Ltd", 45, "entity"),
  ];
  const flagged = applyDeterministicFlags(claims);

  assert.ok(flagged.every((item) => item.flags.includes("conflicting percentages across documents")));
  assert.ok(flagged.every((item) => item.flags.includes("corporate owner chain requires resolution")));
});

function claim(owner: string, targetEntity: string, percentage: number, ownerType: "person" | "entity"): OwnershipClaim {
  return {
    id: `${owner}-${targetEntity}`,
    documentId: "doc",
    documentName: "register.txt",
    page: 1,
    lineId: "line",
    quote: "",
    owner,
    ownerType,
    percentage,
    targetEntity,
    controlBasis: "Equity ownership",
    flags: [],
    fields: accepted,
    modelVersion: "test",
    promptVersion: "test",
    validationOutcome: "valid",
  };
}
