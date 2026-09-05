# Security policy

Twichat holds Twitch access tokens for the people who use it. A flaw here does not cost a redraw,
it costs someone their account — so a report is welcome even when you are not sure it is one.

## Reporting

**Do not open a public issue for a vulnerability.**

Use GitHub's private reporting on this repository: the **Security** tab, then **Report a
vulnerability**. It opens a thread only you and the maintainer can read.

If that is unavailable, email <root@theslumdogemillionaire.com> with `twichat security` in the
subject. There is no PGP key.

Useful in a report: what an attacker has to control to reach it, what they get, and the shortest
path you found to it. A patch is welcome and never expected.

## What to expect

One maintainer, no company behind it, so no service-level promise — what follows is intent, not a
contract.

- **Acknowledgement within a few days.** If a week passes with nothing, assume the message was
  lost rather than ignored, and send it again.
- **An assessment with it**: whether it reproduces, how serious it looks, and what the fix is.
- **A fix in the next release** for anything that exposes a token or lets remote content run code.
  Lesser issues are fixed openly, in a normal pull request.
- **Credit in the release notes** under whatever name you choose, or none if you prefer.

Please leave a reported flaw private until a fixed release exists, or ninety days pass, whichever
comes first.

## Supported versions

Only the latest release. Version 0.1.0 is an alpha and there is no maintenance branch: a fix ships
in the next tag, and older builds are not patched.

## What is worth reporting

The parts of this project where a mistake actually costs something:

- **Stored credentials.** Tokens are enciphered by the operating system keychain through
  Electron's `safeStorage`, and land in `accounts.json` in the app's data directory. Anything that
  reads a token in the clear, or lets one account read another's, is in scope.
- **The sign-in exchange.** The browser returns through `twichat://auth?ticket=…`. The ticket
  carries no token, lives two minutes, works once, and is only exchanged against a verifier the
  application generated for that attempt. Anything that lets one machine claim another's sign-in
  is in scope.
- **The renderer's isolation.** The windows run with `contextIsolation` on, `nodeIntegration` off
  and `sandbox` on, and reach the main process only through the preload API. Anything that gets
  chat content, an emote, a stream or a web page to execute code, reach Node, or navigate a window
  away from the application is in scope.
- **The IPC surface.** Every handler validates what it is given. An input that gets a handler to
  read a file, reach a host, or act for another account than the one connected is in scope.
- **The sign-in server** in `server/`: the Twitch client secret lives there and never reaches the
  application. Anything that extracts it, or gets the server to hand a session to the wrong
  requester, is in scope.

## Known, and not a finding

These are limitations we already know about. Reporting them is not useful; they are tracked and
written down here so nobody spends time on them.

- **The builds are unsigned.** macOS shows the unidentified-developer warning, Windows shows
  SmartScreen. Signing is a cost question, not an oversight.
- **The application talks to Twitch's own endpoints as its player does**, including the
  unofficial one that resolves a channel's HLS playlist. That is deliberate, and documented in
  [ARCHITECTURE.md](ARCHITECTURE.md).
- **Local data is not enciphered beyond the tokens.** Preferences, cached avatars and the room
  list are readable by anything that can already read your home directory.
