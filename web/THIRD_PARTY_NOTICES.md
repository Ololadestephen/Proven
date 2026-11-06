# UI sources

React Bits SpotlightCard, StarBorder and AnimatedList are adapted from David Haz's React Bits repository, revision `c83b5e7e026f003af33ff9ebc3d93afb5c86ad22`:

- https://github.com/DavidHDev/react-bits/tree/c83b5e7e026f003af33ff9ebc3d93afb5c86ad22/src/content/Components/SpotlightCard
- https://github.com/DavidHDev/react-bits/tree/c83b5e7e026f003af33ff9ebc3d93afb5c86ad22/src/content/Animations/StarBorder
- https://github.com/DavidHDev/react-bits/tree/c83b5e7e026f003af33ff9ebc3d93afb5c86ad22/src/content/Components/AnimatedList

Their original MIT + Commons Clause license is preserved in `licenses/react-bits-LICENSE.md`; those adapted files are governed by that notice rather than solely by Proven's root license. Adaptations add TypeScript contracts, Proven's palette, fixed link semantics and reduced-motion behavior, and remove unused customization options.

Reviso (https://revisoagent.xyz/) supplies the requested visual reference for the navy/violet landing page and pale workspace palette. Confam (https://useconfam.vercel.app/) supplies the requested visual reference for outlined evidence cards. No Reviso or Confam source code, logos, screenshots or illustrations are bundled. Their product content and results are not presented as Proven's.

React and React DOM retain their package licenses in their distributions. The browser bundle uses their production runtime.

AnimatedList is adapted as native anchor navigation with local keyboard handling, active-section fragments and a shared selection pill. It retains React Bits' in-view animation pattern using Motion. The upstream global Tab interception and unused scrolling/gradient options are removed. React, React DOM, Motion, Framer Motion, motion-dom and motion-utils license notices are preserved in `licenses/` and the built `/third-party-notices.txt` asset.

NEAR Connect (`@hot-labs/near-connect` 0.12.0) is published by HOT Labs with an MIT license declaration in its package metadata. Package source: https://www.npmjs.com/package/@hot-labs/near-connect. Its declared license, package attribution and standard MIT permission text are included in `licenses/near-connect-LICENSE.txt` and the built notices asset; the published archive did not include a standalone copyright notice. It loads wallet manifests and executor implementations at runtime; their publishers remain responsible for their respective terms.
