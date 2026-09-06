# Contributing

Twichat is an alpha, and a small one: one maintainer, no release yet, an interface still moving.
That makes contributions easy to land and easy to waste. If a change is more than a fix, open an
issue before writing it — a paragraph is enough — so nobody spends an evening on something the
project was already about to do differently.

## Getting set up

Node 22.12 or newer. Electron 44 and Vite 7 both require it, `engines` declares it, and
`npm install` warns below it. [`.nvmrc`](.nvmrc) names the line CI installs, so `nvm use` puts you
on the same one. Nothing else: no Python, no external player, no system package.

```sh
npm install
npm run dev
```

`npm run dev` builds the three bundles — main, preload, renderer — and opens the app with the
renderer on Vite's dev server, so a change to `src/renderer` reloads without a restart. A change
to `src/main` or `src/preload` restarts the app.

The landing site is a separate program in the same repository, with no dependency of its own:

```sh
npm run site   # http://127.0.0.1:3000
```

Signing in from the app needs a Twitch client ID and secret in `.env`; see
[`.env.example`](.env.example) and the site section of the [README](README.md). Without them the
app still runs — chat is readable anonymously, and a token pasted by hand works too.

## What runs on a pull request

[`.github/workflows/checks.yml`](.github/workflows/checks.yml) runs, on every pull request and
every push to `main`, on Linux and on Windows:

```sh
npm ci
npm test           # the unit suite, no network
npm run site:check # the landing site and the OAuth exchange
npm run build      # typecheck, then the three bundles
```

Run those four locally before pushing and CI will not tell you anything you did not already know.

The Windows job reports without blocking. It is there for what this project keeps assuming — a
Unix shell expanding a glob, an inline `VAR=value` in an npm script — on the one platform where
those assumptions break. If you touch `package.json` scripts, that job is the one to read.

## The two kinds of test

**The deterministic suite** is `tests/*.test.ts`, run by `npm test`. It touches no network and no
Twitch: fixtures, injected clocks, injected fetchers. Everything that can live here should. It is
what CI runs, and it is where a bug fix belongs.

**The smoke scripts** in `scripts/` drive a real Electron window against real Twitch channels.
They need a display and a channel that is actually live, so they run by hand, never in CI:

```sh
npm run test:desktop   # startup, joining a room, avatars, layout
npm run test:settings  # playback settings, per-account scoping, saving on the way out
npm run test:video     # HLS resolution, playback, fullscreen — needs a live channel
npm run test:chat      # rendering a busy room: messages, badges, emotes
npm run test:avatars   # the room pictures cached on disk, from one launch to the next
```

The ones that watch a channel take it as an argument — `npm run test:video anyme023`. Pick one
that is live, and for `test:chat` one whose chat is actually moving: a timeout waiting for
`.message` is almost always an empty room, not a broken renderer. `test:desktop` and
`test:settings` pick their own channel and need no account. Nothing here sends a message on your
behalf; `test:reply` is the one that waits for somebody else to send one.

### Writing a test for the bugs this code actually has

Most defects found here have been races, not wrong arithmetic: an account changed while a network
call was in flight, two writes to one file, a window closed inside a debounce. A test that calls a
pure function proves nothing about those. The pattern that does work is to inject what makes the
code wait — the clock, the fetcher, the store — and drive the interleaving from the test.
[`src/main/session.ts`](src/main/session.ts) with [`tests/session.test.ts`](tests/session.test.ts)
is the example to copy: the guard takes its network and its timers as parameters, and the test
resolves them in the order it wants to reproduce.

## Where the code lives

| Path | What it holds |
| --- | --- |
| `src/main/` | The Electron main process: windows, IPC, Twitch session, IRC, EventSub, HLS resolution, SQLite, emote providers. |
| `src/preload/` | The only bridge to the renderer. One typed object, exposed through `contextBridge`. |
| `src/renderer/` | The two pages: the room (`index.html`, `src.ts`) and the detached video window (`player.html`, `player.ts`). |
| `src/shared/` | What both sides agree on: IPC types, validation, error keys, the language catalogs. |
| `server/` | The landing site and the OAuth exchange. Built-in Node modules only — no dependency, no build step. |
| `scripts/` | Smoke tests, screenshots, the icon check, the site's dev supervisor. |
| `tests/` | The deterministic suite and its fixtures. |
| `build/` | `icon.png`, the single icon master. |

[ARCHITECTURE.md](ARCHITECTURE.md) explains how those talk to each other.

## Conventions worth knowing before the review points them out

**English everywhere, except the language catalogs.** Comments, commit messages, test names, log
lines, error text in `server/`: English. The two catalogs in `src/shared/i18n/` are the only place
another language belongs.

**Errors travel by key, never by sentence.** `fail('channelOffline')` rather than throwing a
message. The key crosses the IPC and the renderer translates it, so changing a translation can
never change a behaviour. Adding one means adding it to **both** `en.ts` and `fr.ts` — a test
compares the two catalogs key by key, arity included, and fails on a missing one.

**The renderer never reaches Node.** `contextIsolation` on, `nodeIntegration` off, `sandbox` on.
Anything the window needs goes through a method on the preload API, declared in
`src/shared/types.ts`. See ARCHITECTURE.md for what adding one involves.

**Everything crossing a boundary is validated where it lands**, not where it was produced.
`src/shared/validation.ts` holds those checks; an IPC handler that takes a channel name calls
`channelName()` on it before doing anything else.

**The keyboard goes through `src/renderer/keys.ts`.** Never read `metaKey` at a call site: what
the command key is depends on the platform, and the main process is the only side that knows —
it arrives on the snapshot as `commandKey`. Shortcuts are declared as chords in `SHORTCUTS`, and
labels are written `⌘ K` in the catalogs and the markup, then stamped for the platform on the way
into the document. A handler on a text field also has to let an input method through: Enter, Tab
and the arrows all mean something else while Japanese, Chinese or Korean is being composed, which
is what `composing()` and `sends()` are for. `TWICHAT_COMMAND_KEY=ctrl npm run test:desktop` draws
the Windows and Linux labels on any machine.

**Comments explain why, not what.** The code says what it does. A comment earns its place by
recording the reason a line is the way it is — the Twitch behaviour it works around, the race it
closes, the thing that was tried and did not hold.

There is no linter and no formatter. Match the file you are editing: it is more consistent than
any rule that would be added on top of it.

## Sending a pull request

Small and single-purpose lands fastest. Say what you changed and how you convinced yourself it
works — the reproduction, the test, the platform you ran it on. If part of it is unverified, say
which part; that is more useful than a confident summary.

Anything touching the Twitch session, the account store or the OAuth exchange gets read closely.
Those are where a mistake costs someone their account rather than a redraw.
