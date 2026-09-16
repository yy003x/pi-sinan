# pi-access

A [Pi](https://pi.dev) package that can host **multiple extensions**. Each file in `extensions/` is a separate extension. This repository is not a single-feature image product.

Install from Git (no npm account required):

```bash
pi install git:github.com/yy003x/pi-access
```

or:

```bash
pi install git@github.com:yy003x/pi-access.git
```

Then `/reload`.

## Layout

```text
extensions/
  image.ts                    # generate images with xAI subscription or OpenAI API key
  openai-codex-recovery.ts    # adaptive WebSocket/SSE recovery for OpenAI Codex
```

Add another capability by adding another `extensions/<name>.ts` that `export default function (pi)`. Pi loads every `.ts` / `.js` file in this directory. Keep tests outside `extensions/` so they are not loaded as extensions.

Disable one resource without removing the package:

```json
{
  "packages": [
    {
      "source": "git:github.com/yy003x/pi-access",
      "extensions": ["image"]
    }
  ]
}
```

## Extensions

### openai-codex-recovery

Requires Pi 0.85.1 or newer. Wraps the current effective `openai-codex` provider without replacing its OAuth flow or model catalog.
When `transport` is `"auto"`, it:

- prefers Pi's normal cached WebSocket path;
- uses SSE during a two-minute cooldown after a WebSocket transport failure;
- probes WebSocket again after three successful SSE requests or when the cooldown expires;
- allows only one concurrent recovery probe per session;
- includes nested network error codes such as `ECONNRESET` in SSE `fetch failed` errors and diagnostics.

Explicit `"sse"`, `"websocket"`, and `"websocket-cached"` settings are passed through without adaptive selection. Use `/codex-recovery` to inspect the current session state, or `/codex-recovery reset` to clear it and prefer WebSocket again.

This extension changes only `openai-codex` transport selection. It does not read or store OAuth tokens, request bodies, or authentication headers.

### image

- Tool: `generate_image`
- Command: `/image <prompt> [--path file.png] [--aspect 16:9] [--provider xai|openai]`

| Provider | Works | How |
| --- | --- | --- |
| **xAI** | Yes | `/login xai` (SuperGrok / X Premium) or `XAI_API_KEY` |
| **OpenAI API key** | Yes | `/login openai` or `OPENAI_API_KEY` |
| **OpenAI Codex / ChatGPT OAuth** | No | Missing Images API scopes |

Default provider is `auto`: xAI if configured, otherwise OpenAI API key.

Default output: `.pi-images/<timestamp>.png` under the current workspace. Generated files are always PNG; xAI JPEG payloads are converted before writing. Change the directory with `/image config dir <path>` or:

```json
{
  "piAccess": {
    "image": {
      "outputDir": ".pi-images"
    }
  }
}
```

### Show in the conversation

By default the original image is shown in the main chat (`generate_image` and `/image`) at native pixel size. It may shrink to fit a narrower terminal, but it is never upscaled. The file is linked, not sent to the model. Newly generated cards are visible immediately; restored history stays collapsed until you expand it with Ctrl+O. This needs a terminal with inline images (Kitty, iTerm2, or `PI_IMAGE_PROTOCOL`). Turn it off to skip the inline image:

```json
{
  "piAccess": {
    "image": {
      "showInConversation": false
    }
  }
}
```

Or:

```text
/image config off
/image config on
/image config dir .pi-images
/image a cat --no-preview
```

## Gallery / npm

The official [pi.dev/packages](https://pi.dev/packages) catalog only lists npm packages with the `pi-package` keyword. This git install path does not require an npm account. If you later publish `npm:pi-access`, keep this repo as the multi-extension source; do not split each extension into a separate unique product unless it outgrows the package.
