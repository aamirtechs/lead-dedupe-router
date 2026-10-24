# Changelog

## 1.0.0 - 2026-10-23

- Normalisation for phone (digits, country code stripped), email (lowercase, trimmed) and names (lowercase, clean spacing).
- Duplicate clusters from exact phone or email matches plus fuzzy name and ZIP matches with a documented confidence score; nothing is auto-merged and low-confidence clusters are flagged for human review.
- Editable routing rules in JSON: eligible states, debt bands and a partner priority list, with a per-lead route decision and reason.
- Duplicate-credit ledger with vendor, lead, duplicate-of and a pending credit status per duplicate.
- Funnel counts by source (total, routed, duplicates, ineligible) plus downloadable routed-leads and credit-ledger CSVs. Synthetic sample leads only.
