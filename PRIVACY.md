# What Twichat knows about you

Short version: nothing leaves your machine except the calls Twitch and the emote providers need to
answer, plus one exchange with a sign-in server that holds your tokens for two minutes and then
forgets them. There is no analytics, no crash reporter, no account on anything but Twitch.

This document says that precisely enough to be checked against the code, because "we respect your
privacy" is worth nothing without the list underneath it.

## No telemetry

There is none. No analytics script, no error reporter, no usage ping, no unique identifier
attached to anything. The application never calls a server this project runs except the sign-in
exchange described below, and never for anything but that exchange.

The one identifier the application draws is `play_session_id`, a random value generated **per
playback** and sent to Twitch's video servers with the playlist request. It is redrawn every time,
deliberately: a fixed one would follow every viewer of this application around and identify them
to Twitch as one of them.

## What is stored, and where

Everything sits in the per-user data directory — `~/Library/Application Support/Twichat` on macOS,
`%APPDATA%\Twichat` on Windows, `~/.config/Twichat` on Linux. Nothing is stored anywhere else.

| File | Holds |
| --- | --- |
| `twichat.db` | Preferences, the rooms you joined, window geometry, per account. SQLite. |
| `accounts.json` | Your Twitch access and refresh tokens, enciphered by the operating-system keychain (`safeStorage`). The logins sit beside them in the clear; the credentials never do. |
| `avatars.json` | Up to ten cached profile pictures, so the account chooser can draw before any Twitch call. |

Chat messages are **not** stored. The window keeps 500 per channel in memory and they are gone when
it closes.

Preferences are scoped per account: each account has its own rooms, sizes, quality and theme, and
signing out does not carry anything into the next account's session. The composer's drafts and
history are dropped at the same boundary.

**To erase everything**, delete that directory. There is nothing to erase anywhere else, and no
account to close.

Signing out is deliberately not that: it disconnects and offers the account again next launch, so
the tokens, the avatar and the preferences all stay. An account is only erased when it is
*forgotten* — which happens when Twitch refuses both its token and its renewal — and forgetting
takes all three: the credentials, the cached picture, and the rooms and settings the account had,
including the pointer that would otherwise reopen it.

## Who the application talks to

| Host | Why |
| --- | --- |
| `id.twitch.tv` | Checking the access token is still alive. |
| `api.twitch.tv` | Helix: channel and user profiles, followed channels, the live list, emote sets. |
| `gql.twitch.tv`, `usher.ttvnw.net`, and a `*.ttvnw.net` video server | Resolving and playing a stream, the way the web player does. |
| `irc-ws.chat.twitch.tv`, `eventsub.wss.twitch.tv` | Chat, and the raid notice chat does not carry. |
| `static-cdn.jtvnw.net` | Twitch emote and profile images. |
| `api.frankerfacez.com`, `cdn.frankerfacez.com` | FrankerFaceZ emotes. |
| `api.betterttv.net`, `cdn.betterttv.net` | BetterTTV emotes. |
| `7tv.io`, `cdn.7tv.app` | 7TV emotes. |
| `api.github.com` | The update check: the latest release, and nothing else. |
| The sign-in server | Only while signing in or renewing a token. |

Two things follow from that list. The three emote providers see a request per channel you open,
which tells them you opened it — that is what using their emotes costs, and there is no way to
have the emotes without the request. And the video never reaches a Twitch CDN from the window
directly: the main process proxies it behind `twitch-media://`, re-validating every address
against a two-domain allowlist.

## The sign-in server

Twitch's OAuth needs a client secret and a desktop application cannot keep one, so the exchange
happens on the small server in [`server/`](server/). What it does with your data:

- It receives the authorisation code from Twitch, exchanges it for tokens, and holds them **in
  memory** against a ticket that lives **two minutes**. Three wrong attempts destroy the ticket.
- The application claims the ticket with a verifier that never left it, and the server hands the
  tokens over and drops them.
- Renewal (`/auth/refresh`) works the same way: the refresh token arrives, is exchanged, and is not
  kept.

**The server writes nothing to disk.** No database, no log file, no request log. Tickets, pending
sign-ins and the rate-limit counters are in-memory maps that expire — the counters after a minute,
keyed by IP address and holding nothing else. Restarting the server empties all of it.

The tokens themselves live on your machine, in the keychain-enciphered `accounts.json`. The server
never holds one for longer than the two minutes above.

### The trust this asks of you

Running the published application means trusting whoever runs
`twichat.theslumdogemillionaire.com` not to keep your tokens during those two minutes. That is a
real thing to ask, and it is the reason the code for that server is in this repository rather than
somewhere private: it can be read, and it can be replaced.

**If you would rather not.** Point the application at your own by setting `TWICHAT_AUTH_SERVER`
with your own Twitch client ID and secret — see [`.env.example`](.env.example) and the site section
of the [README](README.md). Or skip the exchange entirely: a token you generate yourself and paste
into the sign-in dialog never touches any server but Twitch's.

## The landing site

The pages are static and set no cookie. They load no third-party script, no font from a CDN, no
analytics. `/download` and `/auth/*` are served with `X-Robots-Tag: noindex`.

## Scopes asked of Twitch

`chat:read` and `chat:edit`, which are what reading and writing chat require, plus
`user:read:follows` for the followed-channels list. Nothing lets this application follow, subscribe,
change a setting, or post anywhere but a chat you are watching — Twitch closed its follow endpoints
to third parties in 2021, and this client only ever reads that state.

## When this changes

This file describes the code in the repository at the revision you are reading. If a release ever
adds a network call, it belongs in the table above in the same commit.
