# Lead Dedupe Router
Live page: https://aamirtechs.github.io/lead-dedupe-router/

Dedupe and route inbound leads by phone, email and fuzzy name plus ZIP, route by state and debt band, and track duplicate-lead vendor credits in one browser tool. Operations teams currently do this by hand, one row at a time, in spreadsheets. This tool does the whole batch in the browser for free.

## Features
- Normalisation for phone (digits, country code stripped), email (lowercase, trimmed) and names (lowercase, clean spacing).
- Duplicate clusters from exact phone or email matches plus fuzzy name and ZIP matches with a documented confidence score; nothing is auto-merged and low-confidence clusters are flagged for human review.
- Editable routing rules in JSON: eligible states, debt bands and a partner priority list, with a per-lead route decision and reason.
- Duplicate-credit ledger with vendor, lead, duplicate-of and a pending credit status per duplicate.
- Funnel counts by source (total, routed, duplicates, ineligible) plus downloadable routed-leads and credit-ledger CSVs. Synthetic sample leads only.

## How it works
Paste or upload a lead file, set the review threshold and routing config, and run. Leads are normalised and clustered as possible duplicates for human review, each lead gets a route decision with a reason, and duplicates generate pending credit rows for their vendor. It runs entirely in the browser.

## Privacy
Runs 100% in your browser. Your files never leave this device, nothing is uploaded,
and there is no tracking.

## Development
Core logic lives in `src/logic.js` and is shared by the page and the tests.
Run the tests with `npm test`.

## License
MIT, Copyright 2026 Amir Hussain.
