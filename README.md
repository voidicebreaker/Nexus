# MindOverMatter

## Desktop AI / remote LM Studio

`/ai/` is a static chat page for the Windows LM Studio host. Start with
[/ai/setup.html](https://mindovermatter.space/ai/setup.html) and download
the Windows launcher there. It runs an authenticated, loopback-only Node.js
relay and an outbound Cloudflare Quick Tunnel. Friends need only a browser,
the current chat link, and the private sharing key. The launcher checks and
downloads vendor runtimes without npm packages or administrator access.

The temporary address changes when the launcher restarts. This deliberately
avoids requiring domain/DNS changes; a named tunnel can be added later.
The relay serializes generations and uses short polling requests because
Quick Tunnels do not support SSE. Only text chat and model listing are
forwarded. Access keys and chats are never committed or saved in the website's browser
storage; the desktop stores its key under the host's LocalAppData directory.
See `ai/desktop/README.txt` for privacy, limits, and advanced configuration.

The relay also exposes authenticated OpenAI-compatible `GET /v1/models`
and `POST /v1/chat/completions`. See [/ai/apps.html](https://mindovermatter.space/ai/apps.html)
for SillyTavern, JanitorAI, and Open WebUI configuration. API requests share
the website's single-generation queue. Temporary-tunnel mode requires
`stream: false` and enforces a 90-second total API deadline; the optional
`Start-Permanent-Tunnel.cmd` uses a user-configured named Cloudflare Tunnel
for SSE and a stable hostname. Tunnel tokens are entered locally and are
not saved. Only text chat is supported; system prompts and safe sampling
parameters are accepted, while tools and attachments are rejected.

Validate the relay with Node.js 22+:

```sh
node --test ai/tests/relay.test.mjs
node --check ai/chat.js
```

After editing launcher sources, regenerate its ZIP before committing:

```sh
python3 scripts/package-lm-share.py
```

## Existing pages

Nexus hosts its existing pages and Antimatter Dimensions: Endgame at
`/antimatter/`. The homepage links to the game. The game runs in the browser
and saves progress locally; Firebase cloud saving is not configured.

## Build Antimatter

Use Node.js and npm. Node 24.19.0 and npm 11.9.0 were validated. Keep the
`AntimatterDimensionsEndgameUpdate` checkout beside `Nexus`, then run from
this repository:

```sh
bash scripts/build-antimatter.sh
```

An alternative source checkout can be passed as the first argument. The
script installs locked dependencies and replaces the generated `antimatter/`
directory with a production build, including the license and source commit
metadata. Keep custom files outside that generated directory.

## Preview and publish

```sh
python3 -m http.server 8081
```

Check the homepage navigation and `/antimatter/`, including purchasing a
dimension and saving/reloading progress.

Commit the generated `antimatter/` files with any navigation changes and push
to `main`. For GitHub Pages, select **Deploy from a branch**, **main**, and
**/ (root)** in this repository's Pages settings. Keep the existing custom
domain, `mindovermatter.space`. The game then shares that domain under
`/antimatter/`; no additional server or DNS record is needed.

To update the game, update its source checkout, rerun the build script, and
commit and push the regenerated files. The source revision is recorded in
`antimatter/commit.json`.

