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
  image.ts    # generate images with xAI subscription or OpenAI API key
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

### image

- Tool: `generate_image`
- Command: `/image <prompt> [--path file.png] [--aspect 16:9] [--provider xai|openai]`

| Provider | Works | How |
| --- | --- | --- |
| **xAI** | Yes | `/login xai` (SuperGrok / X Premium) or `XAI_API_KEY` |
| **OpenAI API key** | Yes | `/login openai` or `OPENAI_API_KEY` |
| **OpenAI Codex / ChatGPT OAuth** | No | Missing Images API scopes |

Default provider is `auto`: xAI if configured, otherwise OpenAI API key.

Default output: `.pi-images/<timestamp>.png` under the current workspace. Change it with `/image config dir <path>` or:

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

By default the PNG is also shown in the main chat (tool result for `generate_image`, custom entry for `/image`). This needs a terminal with inline images (Kitty, iTerm2, or `PI_IMAGE_PROTOCOL`). Turn it off to save context and skip the preview:

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
