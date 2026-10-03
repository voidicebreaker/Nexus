# MindOverMatter

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
