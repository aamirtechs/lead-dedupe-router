"use strict";
// Lead Dedupe Router: core logic (pure functions, no DOM).
// Duplicate detection never auto-merges. Clusters are suggestions for
// human review, flagged whenever confidence is below the threshold.
// Fuzzy matching: normalised full-name Levenshtein similarity combined
// with a ZIP match. Exact phone or exact email matches score 1.0.

function parseCSV(text) {
  const rows = [];
  let row = [], cur = "", inQ = false;
  const s = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; } }
      else { cur += c; }
    } else if (c === '"') { inQ = true; }
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (c === "\r") { /* skip */ }
    else { cur += c; }
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  const clean = rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ""; }); });
  if (!clean.length) { return { headers: [], rows: [] }; }
  const headers = clean[0].map(function (h) { return String(h).trim(); });
  const out = clean.slice(1).map(function (r) {
    const o = {};
    headers.forEach(function (h, idx) { o[h] = r[idx] !== undefined ? String(r[idx]).trim() : ""; });
    return o;
  });
  return { headers: headers, rows: out };
}
function csvEscape(v) {
  const s = String(v === null || v === undefined ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(headers, rows) {
  return [headers.join(",")].concat(rows.map(function (r) {
    return headers.map(function (h) { return csvEscape(r[h]); }).join(",");
  })).join("\n");
}
function round2(n) { return Math.round(n * 100) / 100; }

function normalizePhone(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.length === 11 && d.charAt(0) === "1") { d = d.slice(1); }
  return d;
}
function normalizeEmail(v) { return String(v || "").trim().toLowerCase(); }
function normalizeName(v) { return String(v || "").trim().toLowerCase().replace(/\s+/g, " "); }
function fullName(lead) { return normalizeName(((lead.first_name || "") + " " + (lead.last_name || "")).trim()); }

function levenshtein(a, b) {
  const s = String(a || ""), t = String(b || "");
  if (s === t) { return 0; }
  if (!s.length) { return t.length; }
  if (!t.length) { return s.length; }
  let prev = [], cur = [];
  for (let j = 0; j <= t.length; j++) { prev[j] = j; }
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[t.length];
}
function nameSimilarity(a, b) {
  const s = normalizeName(a), t = normalizeName(b);
  if (!s || !t) { return 0; }
  if (s === t) { return 1; }
  // Token overlap helps when name order or a middle token differs.
  const sTok = new Set(s.split(" ")), tTok = new Set(t.split(" "));
  let shared = 0; sTok.forEach(function (x) { if (tTok.has(x)) { shared += 1; } });
  const tokenScore = shared / Math.max(sTok.size, tTok.size);
  const levScore = 1 - levenshtein(s, t) / Math.max(s.length, t.length);
  return round2(Math.max(tokenScore, levScore));
}

// Confidence that two leads are the same person.
function pairScore(a, b) {
  const phoneA = normalizePhone(a.phone), phoneB = normalizePhone(b.phone);
  if (phoneA && phoneB && phoneA === phoneB) { return { score: 1, reasons: ["exact phone"] }; }
  const emailA = normalizeEmail(a.email), emailB = normalizeEmail(b.email);
  if (emailA && emailB && emailA === emailB) { return { score: 1, reasons: ["exact email"] }; }
  const zipA = String(a.zip || "").trim(), zipB = String(b.zip || "").trim();
  if (zipA && zipB && zipA === zipB) {
    const sim = nameSimilarity(fullName(a), fullName(b));
    if (sim > 0) {
      // Name carries 70 percent, the shared ZIP carries 30 percent.
      return { score: round2(sim * 0.7 + 0.3), reasons: ["fuzzy name and ZIP, name similarity " + sim] };
    }
  }
  return { score: 0, reasons: [] };
}

function parseLeads(text) {
  const parsed = parseCSV(text);
  return parsed.rows.map(function (r) {
    return {
      lead_id: r.lead_id || "", first_name: r.first_name || "", last_name: r.last_name || "",
      phone: r.phone || "", email: r.email || "", zip: r.zip || "", state: String(r.state || "").toUpperCase(),
      debt_amount: r.debt_amount === "" || r.debt_amount === undefined ? null : Number(r.debt_amount),
      vendor: r.vendor || "", source: r.source || "", received_at: r.received_at || ""
    };
  }).filter(function (l) { return l.lead_id !== "" || l.phone !== "" || l.email !== ""; });
}

function detectDuplicates(leads, options) {
  const opts = options || {};
  const threshold = opts.threshold !== undefined ? Number(opts.threshold) : 0.8;
  const fuzzyMin = opts.fuzzyMin !== undefined ? Number(opts.fuzzyMin) : 0.75;
  const list = leads || [];
  const parent = list.map(function (_, i) { return i; });
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) { parent[rb] = ra; } }
  const pairInfo = {};
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const ps = pairScore(list[i], list[j]);
      const isExact = ps.reasons.some(function (r) { return r.indexOf("exact") === 0; });
      if (isExact || ps.score >= fuzzyMin) {
        union(i, j);
        const key = find(i);
        if (!pairInfo[key] || ps.score < pairInfo[key].score) {
          // Cluster confidence is the weakest link, so weak fuzzy links stay visible.
          if (!pairInfo[key]) { pairInfo[key] = { score: ps.score, reasons: ps.reasons.slice() }; }
          else { pairInfo[key].score = Math.min(pairInfo[key].score, ps.score); pairInfo[key].reasons = pairInfo[key].reasons.concat(ps.reasons); }
        }
      }
    }
  }
  const groups = {};
  list.forEach(function (_, i) { const r = find(i); if (!groups[r]) { groups[r] = []; } groups[r].push(i); });
  const clusters = [];
  Object.keys(groups).forEach(function (k, idx) {
    const idxs = groups[k];
    if (idxs.length < 2) { return; }
    const info = pairInfo[k] || { score: 1, reasons: ["exact match"] };
    clusters.push({
      clusterId: "C" + (clusters.length + 1),
      leadIds: idxs.map(function (i) { return list[i].lead_id; }),
      leads: idxs.map(function (i) { return list[i]; }),
      confidence: info.score,
      reasons: Array.from(new Set(info.reasons)),
      needsReview: info.score < threshold
    });
  });
  return clusters;
}

const DEFAULT_CONFIG = {
  eligibleStates: ["CA", "TX", "FL", "NY", "WA", "IL", "DE", "ID", "MD", "MT"],
  debtBands: [
    { min: 0, max: 9999, partner: "Partner Hold Queue" },
    { min: 10000, max: 24999, partner: "Partner Alpha" },
    { min: 25000, max: null, partner: "Partner Beta" }
  ],
  partnerPriority: ["Partner Alpha", "Partner Beta", "Partner Hold Queue"]
};

function routeLead(lead, config) {
  const cfg = config || DEFAULT_CONFIG;
  const state = String(lead.state || "").toUpperCase();
  const eligible = (cfg.eligibleStates || []).map(function (s) { return String(s).toUpperCase(); });
  if (!state || eligible.indexOf(state) === -1) {
    return { lead_id: lead.lead_id, route: "ineligible", partner: "", reason: "State " + (state || "(blank)") + " is not in the eligible state list." };
  }
  const debt = lead.debt_amount === null || lead.debt_amount === undefined || isNaN(lead.debt_amount) ? null : Number(lead.debt_amount);
  if (debt === null) {
    return { lead_id: lead.lead_id, route: "hold", partner: "", reason: "No debt amount supplied, so no debt band can be matched." };
  }
  const bands = (cfg.debtBands || []).slice().sort(function (a, b) {
    const pa = (cfg.partnerPriority || []).indexOf(a.partner);
    const pb = (cfg.partnerPriority || []).indexOf(b.partner);
    return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
  });
  // Bands are checked in file order first for range fit; priority documents preference.
  const ordered = cfg.debtBands || [];
  for (let i = 0; i < ordered.length; i++) {
    const band = ordered[i];
    const max = band.max === null || band.max === undefined ? Infinity : Number(band.max);
    if (debt >= Number(band.min) && debt <= max) {
      return { lead_id: lead.lead_id, route: "routed", partner: band.partner, reason: "Debt " + debt + " falls in band " + band.min + " to " + (band.max === null || band.max === undefined ? "no cap" : band.max) + " for state " + state + "." };
    }
  }
  return { lead_id: lead.lead_id, route: "hold", partner: "", reason: "Debt " + debt + " does not fall in any configured debt band." };
}
function routeLeads(leads, config) {
  return (leads || []).map(function (l) {
    const r = routeLead(l, config);
    return Object.assign({}, l, r);
  });
}

function buildCreditLedger(clusters) {
  const rows = [];
  (clusters || []).forEach(function (c) {
    const sorted = c.leads.slice().sort(function (a, b) { return String(a.received_at).localeCompare(String(b.received_at)); });
    const original = sorted[0];
    sorted.slice(1).forEach(function (l) {
      rows.push({ vendor: l.vendor, lead_id: l.lead_id, duplicate_of: original.lead_id, cluster_id: c.clusterId, confidence: c.confidence, credit_status: "pending" });
    });
  });
  return rows;
}

function funnelCounts(leads, routed, clusters) {
  const dupIds = new Set();
  (clusters || []).forEach(function (c) {
    const sorted = c.leads.slice().sort(function (a, b) { return String(a.received_at).localeCompare(String(b.received_at)); });
    sorted.slice(1).forEach(function (l) { dupIds.add(l.lead_id); });
  });
  const by = {};
  (leads || []).forEach(function (l) {
    const src = l.source || "(unknown)";
    if (!by[src]) { by[src] = { source: src, total: 0, routed: 0, duplicates: 0, ineligible: 0 }; }
    by[src].total += 1;
    if (dupIds.has(l.lead_id)) { by[src].duplicates += 1; }
  });
  (routed || []).forEach(function (r) {
    const lead = (leads || []).find(function (l) { return l.lead_id === r.lead_id; });
    const src = (lead && lead.source) || "(unknown)";
    if (!by[src]) { by[src] = { source: src, total: 0, routed: 0, duplicates: 0, ineligible: 0 }; }
    if (r.route === "routed") { by[src].routed += 1; }
    if (r.route === "ineligible") { by[src].ineligible += 1; }
  });
  const bySource = Object.values(by);
  return {
    total: (leads || []).length,
    routed: (routed || []).filter(function (r) { return r.route === "routed"; }).length,
    duplicates: dupIds.size,
    ineligible: (routed || []).filter(function (r) { return r.route === "ineligible"; }).length,
    bySource: bySource
  };
}

function buildRoutedCSV(routed) {
  const rows = (routed || []).map(function (r) {
    return { lead_id: r.lead_id, first_name: r.first_name, last_name: r.last_name, phone: r.phone, email: r.email, zip: r.zip, state: r.state, debt_amount: r.debt_amount, vendor: r.vendor, source: r.source, received_at: r.received_at, route: r.route, partner: r.partner, reason: r.reason };
  });
  return toCSV(["lead_id", "first_name", "last_name", "phone", "email", "zip", "state", "debt_amount", "vendor", "source", "received_at", "route", "partner", "reason"], rows);
}
function buildLedgerCSV(ledger) {
  return toCSV(["vendor", "lead_id", "duplicate_of", "cluster_id", "confidence", "credit_status"], ledger || []);
}
function parseConfigJSON(text) {
  const cfg = JSON.parse(String(text || "{}"));
  return {
    eligibleStates: Array.isArray(cfg.eligibleStates) ? cfg.eligibleStates : DEFAULT_CONFIG.eligibleStates,
    debtBands: Array.isArray(cfg.debtBands) ? cfg.debtBands : DEFAULT_CONFIG.debtBands,
    partnerPriority: Array.isArray(cfg.partnerPriority) ? cfg.partnerPriority : DEFAULT_CONFIG.partnerPriority
  };
}

const api = { parseCSV: parseCSV, parseLeads: parseLeads, normalizePhone: normalizePhone, normalizeEmail: normalizeEmail, normalizeName: normalizeName, levenshtein: levenshtein, nameSimilarity: nameSimilarity, pairScore: pairScore, detectDuplicates: detectDuplicates, DEFAULT_CONFIG: DEFAULT_CONFIG, defaultConfig: DEFAULT_CONFIG, routeLead: routeLead, routeLeads: routeLeads, buildCreditLedger: buildCreditLedger, funnelCounts: funnelCounts, buildRoutedCSV: buildRoutedCSV, buildLedgerCSV: buildLedgerCSV, parseConfigJSON: parseConfigJSON };
if (typeof module !== "undefined" && module.exports) { module.exports = api; }
if (typeof window !== "undefined") { window.LeadDedupeRouter = api; }
