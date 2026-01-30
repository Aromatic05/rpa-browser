# Local Chat Demo

This demo exposes a local web UI that drives the real agent runner via tool calls.

## Start the demo server

```
pnpm -C agent dev:demo
```

Then open:

```
http://127.0.0.1:17334
```

## Prepare the environment

1. Open the web UI.
2. In **Environment**, optionally set a URL (e.g. `https://catos.info`).
3. Click **Prepare Workspace**.

## Example instruction

```
帮我在 catos.info 网页上找到谷歌网盘下载链接
```

## What you should see

- Tool events show a sequence like:
  - `browser.goto` -> `browser.snapshot` -> `browser.click` -> `browser.snapshot`
- Final answer contains the link extracted by the assistant.

Example (abridged):

```
Tool events: 4
- CALL browser.goto {"url":"https://catos.info"}
- RESULT ok=true
- CALL browser.snapshot {"includeA11y":false}
- RESULT ok=true
...
Final answer:
"The Google Drive link is https://drive.google.com/..."
```

## Troubleshooting

- If the LLM API does not support `/v1/chat/completions`, update **API Base** to a compatible endpoint.
- If tools are not called, confirm the model supports function calling.
- Playwright launches a visible Chromium window; make sure the window is not closed during runs.
