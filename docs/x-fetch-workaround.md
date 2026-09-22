# X fetch compatibility

`pi-web-access` 0.27.0 sends `OpenAI File Downloader, XaiImageApiFetch/1.0`.
X returns HTTP 403 for that identity on a tested public post, while the same
request through the same Clash proxy returns 200 with a browser User-Agent.

`scripts/patch-web-access.mjs` runs on install and changes only X/Twitter host
requests to use a browser User-Agent. Other hosts retain upstream behavior.
The patch is idempotent and refuses unexpected upstream source changes.
After an install using `--ignore-scripts`, run it manually. Restart Pi after
applying it so the loaded dependency picks up the change.

Verification: the regression test fails against the original dependency and
passes after patching. Live fetching of
`https://x.com/pidotdev/status/2100935860413673605` returned HTML containing
post text in Open Graph metadata with the browser identity.

This does not yet make readable extraction work: the live extraction path
subsequently failed in Defuddle with `Unknown pseudo-class :0`. Use a browser
for X posts until the parser issue is resolved; HTTP 200 alone is not proof
of complete tweet extraction. No proxy settings or hosted fallback permissions
are changed by this workaround.
