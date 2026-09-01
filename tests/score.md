# Scoring redaction

`tests/corpus/` is a page carrying known identifiers and known decoys, so recall and
precision can be measured rather than eyeballed. Both are rubric lines — 20% for PII
recall/precision, 20% for redaction precision — and neither can be read off a screenshot.

## Running it

```sh
cd extension && npm run build     # the scorer reads dist/content.js
node tests/score.mjs
```

Chrome for Testing is used, because branded Chrome refuses `--load-extension`. Set
`AEGIS_CHROME` if yours is elsewhere. The run exits non-zero only on a **false positive** —
a miss is a known gap recorded below, while a decoy being masked is a regression.

## How ground truth is encoded

Every identifier sits in `<span data-pii="kind">`; every decoy sits in
`<span data-decoy="why">`. The `why` is recorded so a failure explains itself: "16 digits,
fails Luhn" is a more useful test name than "decoy 4".

Declared fields carry their own truth in their attributes — `type="password"`,
`autocomplete="cc-number"` — so they need no marking.

## What counts

- **Recall** — of the `data-pii` spans, how many are covered by a redaction region.
- **Precision** — of the regions produced, how many land on a `data-pii` span rather than a
  `data-decoy` or ordinary prose.

A region is credited to a span when their rectangles intersect. Intersection rather than
containment, because masks are dilated by 3px on purpose.

## Why the decoys matter more than the positives

Recall is easy to buy: match `\d{12}` and every Aadhaar is caught, along with every order
number, timestamp and tracking id on the page. The decoy set is what stops that trade
being invisible. It holds, deliberately:

- a 12-digit order number that fails Verhoeff
- an Aadhaar with two digits transposed — one edit away from valid
- a 16-digit tracking number that fails Luhn
- `ABCDE1234F`, a PAN shape whose fourth character is not a valid entity type
- epoch milliseconds, a price, a time, a room number
- a 10-digit run beginning with 1, so not an Indian mobile

Each is a string a naive detector takes. Every one that survives is a precision mark held.

## Current result

Measured 1 September 2026:

```
corpus: 11 identifiers, 11 decoys, 21 regions painted

RECALL     90.9%   (10/11 identifiers covered)
PRECISION  100.0%  (0 decoys wrongly covered)

missed:  name  "Ravi Menon"
```

The single miss is the declared gap: a person's name in prose, with no pattern and no
label. Nothing short of a model catches it, which is the honest answer rather than a
detector to be tuned.

Building this immediately found a bug the fixtures had not. `+91 98765 43210` was missed
because the pattern demanded ten consecutive digits, while the conventional Indian format
breaks after five — the one format most likely to appear on an Indian page. Recall went
from 81.8% to 90.9%.

## Coverage the corpus is built to exercise

| Section | Exercises |
|---|---|
| 1 | layer 1 on declared fields |
| 2 | camelCase ids with no label — the demoqa case that broke us |
| 3 | fields that must not be classified |
| 4 | layer 2 in prose: Aadhaar, PAN, GSTIN, IFSC, card, email, phone |
| 5 | decoys in prose |
| 6 | a scroll container |
| 7 | an open shadow root |
| 8 | an iframe |

## What it does not cover

The values are synthetic, and they are laid out by the same hand that wrote the detectors —
so this measures precision and recall against *known* shapes, not robustness against markup
nobody anticipated. `tests/live-sites.md` covers that half, and found two real bugs the
corpus never would have.

Faces and text rendered into images are absent entirely, since nothing detects them yet.
[dlptest.com](https://dlptest.com/sample-data/) publishes fabricated driver's licence and
passport images that would exercise exactly that, if a face detector lands.

## Other public sources of fabricated PII

- [dlptest.com/sample-data](https://dlptest.com/sample-data/) — purpose-built for data-loss
  testing: names, SSNs, card numbers, DOBs and emails as viewable tables and downloads,
  plus licence and passport images. **US formats** — no Aadhaar, PAN, GSTIN or IFSC.
- [pii-tools.com/pii-examples](https://pii-tools.com/pii-examples/) — downloadable files
  with fake PII by category.
- UIDAI publishes official **test** Aadhaar numbers and licence keys in its developer
  section, which is the authoritative source for Verhoeff-valid examples.

Indian identifiers are the gap in all the public sets, which is the reason this corpus
exists rather than pointing at someone else's.
