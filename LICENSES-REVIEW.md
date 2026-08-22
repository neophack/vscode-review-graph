# License & Commercial Distribution Compliance Review

Date: 2026-08-22
Repository: Review Graph (publisher `aucneon`), a fork chain:
mhutchie/vscode-git-graph → neophack/vscode-review-graph → this repository.

This document reviews the licensing of every upstream component and assesses
whether the extension may be commercially distributed (e.g. paid VS Code
Marketplace listing or enterprise distribution).

## Summary Conclusion

**Commercial distribution is NOT permitted under the current license.**

The repository's `LICENSE` is a modified MIT license with one additional,
decisive restriction:

> "Permission is NOT GRANTED to publish, distribute, sublicense, and/or sell
> derivative works of the Software."

This restriction originates in mhutchie/vscode-git-graph (upstream, 2019) and
is carried unchanged through neophack/vscode-review-graph into this
repository's `LICENSE`. The license grants use, copying, modification, and
merging — but explicitly prohibits publishing, distributing, sublicensing, or
selling derivative works. Publishing this fork on the Marketplace (free or
paid), or distributing it inside an enterprise, is "distribution of a
derivative work" and therefore violates the license terms unless separate
permission is obtained from the copyright holders.

## Components Reviewed

### 1. This repository's code (inherited from mhutchie → neophack → here)

- File: `./LICENSE`
- License: modified MIT ("source-available", non-OSI)
- Copyright holders named in the file: mhutchie (2019–2021), hansu (2022–2025),
  gxl (2025–2026), neophack (2026–present)
- Permits: use, copy, modify, merge
- Prohibits: publish, distribute, sublicense, sell derivative works
- Commercial distribution: **prohibited**
- Note: permission would be needed from *all* copyright holders in the chain
  (each layer holds copyright in its own contributions), not just mhutchie.
  hansu and gxl appear to be intermediate contributors whose authorization
  status in this chain is unclear — an additional risk.

### 2. Microsoft VS Code Git Extension code (Askpass, Find Git Executable)

- File: `./licenses/LICENSE_MICROSOFT`
- License: MIT, Copyright (c) 2015–present Microsoft Corporation
- Permits: use, copy, modify, merge, publish, distribute, sublicense, sell
- Conditions: retain copyright and permission notice in all copies or
  substantial portions
- Commercial distribution: **allowed**, provided `licenses/LICENSE_MICROSOFT`
  is retained with the distribution

### 3. GitHub Octicons (SVG icons used in `web/utils.ts` / `media/out.min.js`)

- File: `./licenses/LICENSE_OCTICONS`
- License: MIT, Copyright (c) 2019 GitHub Inc.
- Permits: use, copy, modify, merge, publish, distribute, sublicense, sell
- Conditions: retain copyright and permission notice
- Commercial distribution: **allowed**, provided `licenses/LICENSE_OCTICONS`
  is retained

### 4. iconv-lite (sole runtime npm dependency, v0.5.0)

- File: `./licenses/LICENSE_ICONV-LITE` (added during this review; identical to
  `node_modules/iconv-lite/LICENSE`)
- License: MIT, Copyright (c) 2011 Alexander Shtuchkin
- Permits: use, copy, modify, merge, publish, distribute, sublicense, sell
- Conditions: retain copyright and permission notice
- Commercial distribution: **allowed**, MIT notice must be retained

## Risk Analysis

| Component | License | Redistribute | Modify | Commercial use | Blocker? |
|---|---|---|---|---|---|
| mhutchie/neophack/this code | Modified MIT | No | Yes | No | **Yes — blocks all distribution** |
| Microsoft Git extension code | MIT | Yes | Yes | Yes | No |
| GitHub Octicons | MIT | Yes | Yes | Yes | No |
| iconv-lite | MIT | Yes | Yes | Yes | No |

The only blocker is the top-level `LICENSE` itself. Every bundled third-party
component is permissively licensed MIT and poses no obstacle, provided their
license texts in `licenses/` ship with the extension package.

## Obligations If Permission Is Obtained

If the copyright holders (mhutchie, hansu, gxl, neophack) grant written
permission to distribute (e.g. by relicensing or an explicit waiver):

1. Retain all files in `licenses/` (MICROSOFT, OCTICONS, ICONV-LITE) in the
   distributed `.vsix` package, referenced from the main `LICENSE` notice.
2. Retain the copyright notices of all MIT components (Microsoft, GitHub,
   Shtuchkin) — MIT requires the notice accompany copies or substantial
   portions of the Software.
3. No component is copyleft; nothing forces this extension to be open sourced.
4. VS Code Marketplace policy additionally requires a proper LICENSE file and
   consistent `package.json` `license` metadata; the current
   `"license": "SEE LICENSE IN LICENSE"` is acceptable only while the file
   stays non-standard.

## Recommendations

1. **Do not distribute (free or paid) until licensing is resolved.** Any
   Marketplace publication, enterprise deployment, or sale of this fork as-is
   breaches the modified-MIT restriction.
2. Contact mhutchie (upstream author) and the intermediate copyright holders
   (hansu, gxl, neophack) to request relicensing or written distribution
   permission for the fork chain. neophack's fork publishes to the Marketplace
   itself, which suggests neophack either obtained permission or is relying on
   mhutchie's tacit tolerance — that does not automatically extend to this
   fork.
3. If permission cannot be obtained, options are: keep the fork strictly
   private/internal-use, or rewrite the inherited code so no mhutchie-licensed
   code remains (note this includes the Microsoft-derived askpass/utils code,
   which is MIT and unproblematic, but all original Git Graph code carries the
   restriction).
4. Regardless of the path chosen, keep `LICENSE`, `licenses/LICENSE_MICROSOFT`,
   `licenses/LICENSE_OCTICONS`, and `licenses/LICENSE_ICONV-LITE` intact and
   shipping with the package.

*This is an engineering compliance review, not legal advice. For a commercial
release, have counsel review the modified MIT restriction.*
