# Third-party notices

[LICENSE](LICENSE) covers the code in this repository. It does not cover everything the repository
distributes: a font, a set of screenshots, and three runtime dependencies come from elsewhere and
carry their own terms. This file says which, and where each one came from.

## Font

**Atkinson Hyperlegible Next**, © 2020–2024 The Atkinson Hyperlegible Next Project Authors,
under the [SIL Open Font License 1.1](https://openfontlicense.org/open-font-license-official-text/).
It reaches the two distributions by two different roads:

| Where | What |
| --- | --- |
| The application | `@fontsource-variable/atkinson-hyperlegible-next` (5.3.0), a runtime dependency. Its `LICENSE` ships inside the package, and Vite inlines the WOFF2 into `out/renderer/assets/`. |
| The landing site | [`server/public/assets/atkinson.woff2`](server/public/assets/atkinson.woff2), a copy of `atkinson-hyperlegible-next-latin-wght-normal.woff2` from that same package — byte for byte, which a test checks. Its licence sits beside it as [`atkinson-OFL.txt`](server/public/assets/atkinson-OFL.txt). |

The OFL asks that the copyright notice and the licence travel with the font wherever it goes.
The site copy had neither until now; that is what `atkinson-OFL.txt` is for. The name
"Atkinson Hyperlegible" is a reserved font name under that licence: a modified version of the font
may not be distributed under it. This project ships it unmodified.

## Runtime dependencies

Three packages ship inside the installers, and their licence files ship with them under
`node_modules/`:

| Package | Licence |
| --- | --- |
| `hls.js` | Apache-2.0 |
| `electron-updater` | MIT |
| `@fontsource-variable/atkinson-hyperlegible-next` | OFL-1.1 |

Electron itself, and Chromium and Node inside it, carry their own notices in the packaged
application (`LICENSES.chromium.html` and `LICENSE` beside the binary).

Everything else in `package.json` is a development dependency: it builds or tests the project and
is not distributed.

## Images

**The logo** (`src/renderer/public/twichat-logo.png`, `twichat-logo-light.png`,
`server/public/assets/`, `build/icon.png`) and **the interface icons** (`src/renderer/icons.ts`,
drawn as SVG paths in code) belong to this project and are covered by [LICENSE](LICENSE).

**The landing-site screenshots** (`server/public/assets/app-*.png` and `.webp`) are captures of the
real application, produced by [`scripts/landing-capture.ts`](scripts/landing-capture.ts). What they
show is staged — see below — with one exception: the emotes in them are the real ones.

## The screenshots are staged, and what that means

The captures show a channel that does not exist, `mila_pixel`, with invented viewers and invented
messages. No Twitch account, viewer, face or message in them is real. That is deliberate: a
screenshot of a real chat publishes what people wrote somewhere they did not expect to be
advertising, and a real channel's viewers did not agree to appear on this site.

Two consequences worth being explicit about.

**The emotes are real.** The showcase would be dishonest with invented ones — it exists to show
what the application actually renders — so `landing-capture.ts` loads them from the same four
hosts the application does, and they end up baked into the images:

| Source | Emotes shown |
| --- | --- |
| Twitch (`static-cdn.jtvnw.net`) | `Kappa`, `LUL`, `PogChamp`, `Kreygasm` |
| 7TV (`cdn.7tv.app`) | `peepoHappy`, `Clap`, `WAYTOODANK`, `PETPET` |
| BetterTTV (`cdn.betterttv.net`) | `monkaS`, `FeelsGoodMan`, `SourPls` |
| FrankerFaceZ (`cdn.frankerfacez.com`) | `CatBag` |

These images belong to Twitch and to the emote providers and their creators, not to this project.
They appear as an illustration of what the client displays. Anyone forking this project and
publishing their own landing site is redistributing them too, and should decide for themselves
whether they want to.

**The avatars and the video frame are generated images.** `server/demo-assets/avatar-sprite.png`
holds the twelve demo avatars and `stream-frame.png` the picture standing in for the stream. Two of
the avatars and the video frame show what reads as a person; none of them is a photograph of a real
one, and none is a capture of a real Twitch broadcast. They belong to this project and are covered
by [LICENSE](LICENSE).

## Currency marks and payment codes

The support block on the landing site carries three currency marks and three QR codes, under
[`server/public/assets/donate/`](server/public/assets/donate/).

| File | Where it came from |
| --- | --- |
| `mark-bitcoin.svg` | [Bitcoin.svg](https://commons.wikimedia.org/wiki/File:Bitcoin.svg) on Wikimedia Commons, released into the public domain. Inkscape metadata stripped, nothing else changed. |
| `mark-ethereum.svg` | [Ethereum_logo_2014.svg](https://commons.wikimedia.org/wiki/File:Ethereum_logo_2014.svg) on Wikimedia Commons. XML declaration stripped, nothing else changed. |
| `mark-dogecoin.png` | The Dogecoin logo, from [`share/pixmaps`](https://github.com/dogecoin/dogecoin/blob/master/share/pixmaps/dogecoin256.png) in the Dogecoin repository, by way of Wikipedia. Kept as it is. |
| `bitcoin.svg`, `dogecoin.svg`, `ethereum.svg` | The payment codes, generated for this project. Recoloured here, and the background removed so each one sits on its card rather than on a plate. Every one was decoded and checked against the address printed beside it. |

These are the marks of the projects they name, and the trademark rights stay with their holders.
Their use here says which address is which, and nothing more.

## Twitch

Twitch, the Twitch logo, and the emotes Twitch serves are the property of Twitch Interactive, Inc.
This project is not affiliated with, endorsed by, or sponsored by Twitch. It is a client that talks
to Twitch's public interfaces the way a browser does.
