# Live test sites

Public pages to run Aegis against, and what each one is actually for. Local fixtures are
written by the same person who wrote the detectors, so they prove the code does what it was
told — not that it survives real markup. Everything below is a page nobody on the team
controls.

Measured with the extension loaded in Chrome for Testing, headless, 1280×900.

---

## Results

Last run: 1 September 2026, after adding camelCase identifier splitting and `<frameset>`
traversal.

| Site | Time | Elements | Text regions | Frames | Fields classified |
|---|---:|---:|---:|---:|---|
| [demoqa practice form](https://demoqa.com/automation-practice-form) | 15 ms | 21 | 1 | 4 | name×2, email, tel, bday, street-address |
| [expandtesting register](https://practice.expandtesting.com/register) | 9 ms | 16 | 0 | 6 | password×2 |
| [the-internet login](https://the-internet.herokuapp.com/login) | 6 ms | 7 | 0 | 0 | password |
| [saucedemo login](https://www.saucedemo.com/) | 4 ms | 3 | 0 | 0 | password |
| [httpbin form](https://httpbin.org/forms/post) | 12 ms | 13 | 0 | 0 | tel, email |
| [ui.vision framesets](https://ui.vision/demo/webtest/frames/) | 28 ms | 12 | 0 | 6 | — |
| [stripe checkout demo](https://checkout.stripe.dev/) | 14 ms | 14 | 0 | 0 | — |
| [w3schools iframes](https://www.w3schools.com/html/html_iframe.asp) | 418 ms | 88 | 0 | 53 | — |

---

## What each site is for

**demoqa practice form** — the most valuable of these. Every field is `type="text"` with
`autocomplete="off"`, no `<label>` and no `name` attribute; the only signal is a camelCase
id and a placeholder. It is the page that proves the classifier works on markup that tells
you nothing willingly.

**expandtesting register** — conventional markup with real labels and
`autocomplete="new-password"`. The easy case, and worth keeping as the control.

**the-internet login / saucedemo** — minimal login forms. Fast regression checks.

**httpbin form** — `type="tel"` and `type="email"` declared honestly, so it exercises the
first branch of `classifySensitive`.

**ui.vision framesets** — legacy `<frameset>`/`<frame>` rather than `<iframe>`. Included
because it caught a real gap: those are a different DOM class and were invisible.

**stripe checkout demo** — intended as the cross-origin card-iframe case. In headless it
serves a landing page with no card frame, so it does **not** currently exercise what it was
chosen for. Needs a live Checkout session to be useful; treat the local fixture as the real
coverage until then.

**w3schools iframes** — the heavy-frame case: 53 frames, mostly advertising. The slowest
page by an order of magnitude and the one worth watching when changing frame handling.

---

## Findings this produced

Two bugs that local fixtures did not surface:

**camelCase identifiers.** `userEmail` and `dateOfBirthInput` never matched, because the
label patterns are anchored on word boundaries and camelCase has none. Real forms rely on
this far more than on labels. Splitting identifiers before matching took demoqa from 2
classified fields to 6.

**`<frame>` is not `<iframe>`.** `HTMLFrameElement` is a separate class, so a `<frameset>`
page was traversed as if it were empty — ui.vision reported 6 frames and 0 elements.

---

## Caveats

- These numbers are element and field counts, not accuracy. None of these pages carries
  real PII, so they cannot measure recall or precision — a labelled corpus is needed for
  that, with known positives *and* decoys that must survive.
- Third-party pages change without notice. A drop in counts may be the site, not us.
- Headless differs from headed: lazy content, consent banners and ad frames all behave
  differently, which is part of why w3schools varies between runs.

## Running it

Load `extension/dist` as an unpacked extension, open each page, and use the panel. For the
automated sweep, the probe harness used to produce the table lives outside the repository —
it loads `dist/content.js` in a bare extension, sends `AEGIS_SCAN` to frame 0, and reports
`elements`, `piiRegions` and `chrome.webNavigation.getAllFrames`.
