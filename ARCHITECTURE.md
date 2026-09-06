# Architecture

How the pieces fit, and why they are arranged this way. For where files live and how to work on
them, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Three processes and one bridge

Electron gives three places to put code, and the split here is strict.

**The main process** (`src/main/`) owns everything privileged: the network, the disk, the Twitch
session, the windows. It is the only side that ever holds an access token.

**The renderer** (`src/renderer/`) is two web pages — the room and the detached video window. It
runs with `contextIsolation` on, `nodeIntegration` off and `sandbox` on. It has no `require`, no
`fs`, no `fetch` to Twitch. It draws, and it asks.

**The preload** (`src/preload/index.ts`, about a hundred lines) is the whole surface between them.
It exposes one object, typed as `TwichatAPI` in `src/shared/types.ts`, where each method forwards
to a named IPC channel. Adding a capability means four coordinated edits: the method on the type,
the forwarding line in the preload, the handler in `src/main/index.ts`, and the call in the
renderer. That friction is the point — it makes the surface something you can read in one sitting.

Errors take the same road. The main process throws `AppError`s carrying a catalog **key**;
Electron would only carry the message across, so `serializeError` wraps it into an envelope the
preload unwraps back into an `Error`. The renderer translates the key. A translation can therefore
never change a behaviour, and the retry policy in `stream-lifecycle.ts` branches on keys alone.

Two custom schemes are registered as privileged before the app is ready. `twichat://app/…` serves
the application's own pages in the packaged build — a real origin, so the pages get a normal CSP
rather than the loose rules `file://` lives under. `twitch-media://…` is the video proxy, described
below.

## Signing in

Twitch's OAuth needs a client secret, and a desktop application cannot keep one. So the exchange
happens on the small server in `server/`, and the application never sees the secret.

1. The app draws a random verifier, hashes it, and opens the browser at
   `<server>/auth/start?challenge=<hash>`.
2. The server sends the visitor to Twitch, gets the code back on `/auth/callback`, exchanges it for
   tokens, and holds them against a **ticket** that lives two minutes.
3. The browser page opens `twichat://auth?ticket=…`. The operating system hands that to the app —
   which is why the scheme is declared in `electron-builder.yml`, not only registered at runtime.
4. The app posts the ticket **and the verifier** to `/auth/claim`. The server hashes the verifier,
   compares it against the challenge it stored, and only then returns the tokens. Three wrong
   verifiers destroy the ticket.

The ticket carries no token and works once. A machine that intercepts one still cannot use it: it
does not have the verifier, which never left the application that drew it.

Renewal follows the same road — `/auth/refresh`, since refreshing also needs the secret.

## Keeping the session alive

A Twitch user token lasts about four hours, and its death is invisible from the chat: the IRC
socket checks its password when it connects and never again, so the account keeps talking while
every Helix call answers 401.

`src/main/session.ts` holds that logic on its own, with its network and its timers injected. It
validates within the hour Twitch asks for, exchanges the token in the last five minutes of its
life, and abandons quietly when the account changed under a network wait — the generation taken at
the start is compared after every await. It forgets an account only when Twitch has refused both
the token and the renewal; a timeout is a road being out, not a revocation.

`src/main/account-session.ts` is the account itself, around that guard: the credentials, the ways
in — the saved account taken back up at startup, a token pasted by hand, one picked in the chooser,
the end of the browser round-trip — and the way out. Everything it needs of the application comes
in as parameters: the account file, the chat socket, the scope switch, the network. It exists
because those five values used to be module-level `let`s in `index.ts`, next to the windows and the
menus, which meant no interleaving could be reproduced without an Electron window.

**The generation is the invariant of that module**, and there is exactly one counter. A sign-in
opens a generation; every answer that comes back from the network is checked against the one taken
before it left, and one that no longer matches connects nothing, writes nothing and signs nobody
out. The startup restore checks it without opening one of its own: the session gate is on screen
while it runs, so an account chosen there must not be displaced a moment later by the one saved on
disk. `browserLogin` in `index.ts` keeps the browser round-trip — it needs `shell` and the window —
and takes its generation from the module rather than counting on its own side.

## Chat

`src/main/irc.ts` opens a WebSocket to `wss://irc-ws.chat.twitch.tv:443` and speaks IRC. The
parsing is in `irc-parser.ts`, separate and tested on its own. Messages reach the renderer in
batches every 80 ms rather than one event per line, and the queue drops old ordinary chat under
flood while keeping moderation and system events.

`src/main/eventsub.ts` opens a second socket to `wss://eventsub.wss.twitch.tv/ws` for what IRC does
not carry — an outgoing raid, notably, which never appears in the chat stream.

The renderer keeps 500 messages per channel (`chat-store.ts`) and renders through a virtual log, so
a busy room stays a fixed amount of DOM.

## Video

Twitch's player fetches an HLS playlist, and so does this one. `src/main/streams.ts` does what the
web player does: it asks `gql.twitch.tv` for a playback token with the persisted query the site's
own player uses, then asks `usher.ttvnw.net` for the master playlist, then picks the variant
matching the chosen quality. Selection reads the measured `RESOLUTION` and `BANDWIDTH`, never the
labels — Twitch calls a fifty-image stream `720p60` and puts `1080p50 (source)` in a group named
`chunked`.

The token is asked for as `embed`, the surface third-party embeds use, rather than as `site`, the
page player. Twitch stitches a pre-roll into `site` and none into `embed`, which is offered the
same renditions down to the source — measured on six channels, `site` carried an advertisement on
all six and `embed` on none, with identical variant lists. `autoplay` and `thunderdome` are also
free of it but capped at 360p, which is why they are not used. Nothing in this relaxes what Twitch
allows: the claims below are read from the token Twitch signs, so a subscriber-only stream and a
geoblocked one are refused exactly as they were.

The playback token is asked for as the connected account when there is one. Twitch decides what to
serve from who is asking — a viewer it cannot identify is the one it shows the most advertising to,
and a subscription or a Turbo counts for nothing unless the request carries it. Our token was
issued to this application's own client rather than to the web player named in the header, so
Twitch may refuse the pair; a second attempt without it then gets the same public playlist as
before. Signing in can only add to what plays.

The persisted-query hash is the fragile part of the project: Twitch can change it whenever they
ship their client, and nothing announces it. A playback that finds no token on every channel at
once points there first.

`withoutAds` stays behind that as the net, for the mid-roll `embed` does not spare us and for the
day Twitch starts stitching into it too. It takes the advertising back out of the media playlist.
There is no separate address to refuse — the ads are spliced into the same variant, server-side —
but they are named: a `twitch-stream-source` range announces what is playing, and every segment
carries that same string as its `#EXTINF` title, `live` for the channel and `Amazon|<identifier>`
for what was stitched over it. Reading that pairing rather than the word `live` is what lets a
rerun, whose source is not `live` either, play untouched. Dropping segments moves
`#EXT-X-MEDIA-SEQUENCE`, which is recomputed, or the player takes the channel's segments for ones
it has already played.

**A window holding nothing but advertising is handed back whole.** Removing every segment leaves an
empty playlist, which hls.js reads as a broken level rather than as a pause — and a pre-roll is
exactly that case. So pre-rolls play; mid-rolls, and the end of a pre-roll once the channel
reappears in the window, are filtered.

The address is then handed to the renderer behind `twitch-media://`, and `hls.js` plays it. The
main process proxies that scheme: it re-validates every URL and every redirect against a two-domain
allowlist, caps manifests at 2 MB, allows twelve concurrent requests, and rewrites the addresses
inside a manifest so segments come back through the same proxy. The renderer therefore never talks
to a Twitch CDN directly, and its CSP does not have to allow one.

## Caches

Everything the main process caches goes through `ExpiringCache` (`src/main/cache.ts`): a lifetime
per entry and a ceiling per cache. The lifetime alone was not enough — the maps it replaces compared
a timestamp on read and kept the entry either way, so a session that walked past a thousand channels
in the discovery list held a thousand entries, all expired, none released. Expired entries are now
dropped on the next write, and the ceiling evicts the oldest write past it.

`deduplicate` in the same file folds concurrent identical calls into one. Joining a room asks four
emote providers about it while an earlier repaint's request may still be out; the second caller
waits on the first, and a rejection is never cached.

## Emotes

Four providers, fetched and merged in the main process: Twitch's own (`twitch-emotes.ts`), then
FrankerFaceZ, BetterTTV and 7TV (`third-party-emotes.ts`). Each is read globally once and per room
on join, and the renderer receives one merged set rather than four to reconcile. Every
provider has its parser in a `-parse.ts` file next door, which is what the tests exercise: the
network shape changes, the merge logic does not.

The caches are keyed by room and by nothing else, deliberately — these emote sets belong to the
channel and to Twitch, not to the viewer, so they survive an account change without leaking
anything across it.

## What is stored, and where

Everything sits in Electron's per-user data directory (`~/Library/Application Support/Twichat` on
macOS, `%APPDATA%\Twichat` on Windows, `~/.config/Twichat` on Linux):

| File | Holds |
| --- | --- |
| `twichat.db` | Preferences, rooms and window geometry, one row per account. SQLite through Node's built-in `node:sqlite`; the schema is a numbered list of revisions replayed in order and remembered in `user_version`. No native module to rebuild. |
| `accounts.json` | Access and refresh tokens, enciphered by the operating-system keychain through `safeStorage`. The logins sit beside them in the clear; the credentials never do. |
| `avatars.json` | Ten cached profile pictures as data URLs, so the account chooser can draw before any Twitch call. |
| `channel-avatars.json` | Thirty cached channel pictures as data URLs, same store and a wider cap, so the room list draws before Twitch answers — and still draws when it answers without an avatar, which is what a dead token or an anonymous session gets. Each is fetched again after a day, or as soon as Twitch names another address. Unscoped, unlike everything below: a channel looks the same to every account. |

Preferences are **scoped**: each account has its own rooms, sizes, quality, theme and window, and
`#anonymous` is a scope like any other. Switching account loads another scope; nothing carries
over. That rule reaches into the renderer too — the composer's drafts and histories are dropped at
the same boundary (`composer-memory.ts`).

The database refuses to open a `user_version` higher than the revisions this build knows. The
migration loop would simply not run, and the application would then read and write a schema it does
not understand — so a downgrade stops at the door rather than damaging the file on the way past.
A file that will not open at all is named in a dialog before anything else starts, with the offer
to set it aside: renamed to `twichat.db.broken-<timestamp>`, its WAL and index with it, never
deleted.

Reads and writes are serialised per store, whole. Queuing the write alone was not enough: two
operations starting together both read the state before either wrote, and the second file replaced
the first.

## The landing site

`server/` is a separate program that shares the repository and nothing else. It imports only
built-in Node modules — no dependency, no build step, which is why it is the one piece that
containerises usefully. It serves the presentation pages, built once per language and held in
memory, and the OAuth endpoints described above. `server/app.mjs` exports a factory taking its
network and its configuration as parameters, so the whole server runs inside a test.
