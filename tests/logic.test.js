"use strict";
const test = require("node:test");
const assert = require("node:assert");
const L = require("../src/logic.js");

function lead(over) {
  return Object.assign({
    lead_id: "L1", first_name: "Lead", last_name: "Person 1", phone: "555-010-1000",
    email: "person1@example.com", zip: "10001", state: "NY", debt_amount: 15000,
    vendor: "Vendor A", source: "web", received_at: "2026-10-01"
  }, over || {});
}

test("phone normalisation strips punctuation and a leading country code 1", () => {
  assert.strictEqual(L.normalizePhone("+1 (555) 010-1000"), "5550101000");
  assert.strictEqual(L.normalizePhone("555.010.1000"), "5550101000");
  assert.strictEqual(L.normalizeEmail("  Person1@Example.COM "), "person1@example.com");
});

test("levenshtein and name similarity behave on known pairs", () => {
  assert.strictEqual(L.levenshtein("kitten", "sitting"), 3);
  assert.strictEqual(L.levenshtein("", "abc"), 3);
  assert.strictEqual(L.nameSimilarity("Lead Person", "Lead Person"), 1);
  assert.ok(L.nameSimilarity("Lead Person", "Lead Persn") >= 0.8);
  assert.ok(L.nameSimilarity("Lead Person", "Other Name") < 0.5);
});

test("exact phone and exact email each create a confidence 1 cluster", () => {
  const leads = [
    lead({ lead_id: "L1" }),
    lead({ lead_id: "L2", email: "different@example.com" }),
    lead({ lead_id: "L3", phone: "555-010-9999", email: "person1@example.com" })
  ];
  const clusters = L.detectDuplicates(leads, { threshold: 0.8 });
  assert.strictEqual(clusters.length, 1);
  assert.deepStrictEqual(clusters[0].leadIds.slice().sort(), ["L1", "L2", "L3"]);
  assert.strictEqual(clusters[0].confidence, 1);
  assert.strictEqual(clusters[0].needsReview, false);
});

test("fuzzy name plus ZIP cluster is flagged for human review below threshold", () => {
  const leads = [
    lead({ lead_id: "L1", phone: "555-010-1000", email: "a@example.com" }),
    lead({ lead_id: "L2", phone: "555-010-2000", email: "b@example.com", last_name: "Persn 1" })
  ];
  const clusters = L.detectDuplicates(leads, { threshold: 0.99 });
  assert.strictEqual(clusters.length, 1);
  assert.ok(clusters[0].confidence < 0.99);
  assert.strictEqual(clusters[0].needsReview, true);
  assert.ok(clusters[0].reasons.join(" ").indexOf("fuzzy") !== -1);
});

test("different people in different ZIPs do not cluster", () => {
  const leads = [
    lead({ lead_id: "L1" }),
    lead({ lead_id: "L2", phone: "555-010-2000", email: "b@example.com", first_name: "Other", last_name: "Human 9", zip: "90210" })
  ];
  assert.strictEqual(L.detectDuplicates(leads).length, 0);
});

test("routing respects state eligibility and debt bands", () => {
  const ny = L.routeLead(lead({ state: "NY", debt_amount: 15000 }), L.DEFAULT_CONFIG);
  assert.strictEqual(ny.route, "routed");
  assert.strictEqual(ny.partner, "Partner Alpha");
  const big = L.routeLead(lead({ state: "TX", debt_amount: 40000 }), L.DEFAULT_CONFIG);
  assert.strictEqual(big.partner, "Partner Beta");
  const ct = L.routeLead(lead({ state: "CT", debt_amount: 15000 }), L.DEFAULT_CONFIG);
  assert.strictEqual(ct.route, "ineligible");
  const noDebt = L.routeLead(lead({ state: "NY", debt_amount: null }), L.DEFAULT_CONFIG);
  assert.strictEqual(noDebt.route, "hold");
});

test("credit ledger credits later duplicates to the earliest original as pending", () => {
  const leads = [
    lead({ lead_id: "L2", received_at: "2026-10-02", vendor: "Vendor B" }),
    lead({ lead_id: "L1", received_at: "2026-10-01", vendor: "Vendor A" })
  ];
  const clusters = L.detectDuplicates(leads);
  const ledger = L.buildCreditLedger(clusters);
  assert.strictEqual(ledger.length, 1);
  assert.strictEqual(ledger[0].lead_id, "L2");
  assert.strictEqual(ledger[0].duplicate_of, "L1");
  assert.strictEqual(ledger[0].vendor, "Vendor B");
  assert.strictEqual(ledger[0].credit_status, "pending");
});

test("funnel counts and CSV exports are consistent", () => {
  const leads = [
    lead({ lead_id: "L1", source: "web" }),
    lead({ lead_id: "L2", source: "web", email: "x@example.com" }),
    lead({ lead_id: "L3", source: "affiliate", state: "CT", phone: "555-010-3000", email: "c@example.com", first_name: "Other", last_name: "Human 9", zip: "06001" })
  ];
  const routed = L.routeLeads(leads, L.DEFAULT_CONFIG);
  const clusters = L.detectDuplicates(leads);
  const funnel = L.funnelCounts(leads, routed, clusters);
  assert.strictEqual(funnel.total, 3);
  assert.strictEqual(funnel.duplicates, 1);
  assert.strictEqual(funnel.ineligible, 1);
  assert.strictEqual(funnel.routed, 2);
  const web = funnel.bySource.find(s => s.source === "web");
  assert.strictEqual(web.total, 2);
  assert.strictEqual(web.duplicates, 1);
  assert.ok(L.buildRoutedCSV(routed).indexOf("Partner Alpha") !== -1);
  assert.ok(L.buildLedgerCSV(L.buildCreditLedger(clusters)).indexOf("pending") !== -1);
});

test("parseLeads reads a CSV with the documented columns", () => {
  const csv = "lead_id,first_name,last_name,phone,email,zip,state,debt_amount,vendor,source,received_at\nL9,Lead,Person 9,555-010-9000,person9@example.com,10001,ny,12000,Vendor A,web,2026-10-03";
  const leads = L.parseLeads(csv);
  assert.strictEqual(leads.length, 1);
  assert.strictEqual(leads[0].state, "NY");
  assert.strictEqual(leads[0].debt_amount, 12000);
});

test("address signal raises a fuzzy score but never creates one", () => {
  const a = { first_name: "Jane", last_name: "Doe", zip: "10001", address: "12 Main Street" };
  const b = { first_name: "Jane", last_name: "Does", zip: "10001", address: "12 Main St" };
  const base = L.pairScore(a, b, {});
  const raised = L.pairScore(a, b, { addressSignal: true });
  assert.ok(raised.score > base.score);
  assert.ok(raised.reasons.some((r) => r.indexOf("address similarity") === 0));

  const c = { first_name: "Jane", last_name: "Doe", zip: "99999", address: "12 Main Street" };
  const alone = L.pairScore(a, c, { addressSignal: true });
  assert.equal(alone.score, 0);
});
