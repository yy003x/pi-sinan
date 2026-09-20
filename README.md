# pi-sinan

`pi-sinan` is a multi-extension [Pi](https://pi.dev) package for capabilities
backed by existing **xAI/Grok** and **OpenAI/Codex** subscriptions. It does not
use separately billed OpenAI Platform image/search APIs.

## Install

```bash
pi install git:github.com/yy003x/pi-sinan
```

Then run `/reload`. This repository requires Pi 0.85.1 or newer and is tested
against Pi 0.86.0.

## Package architecture

Pi loads each file below as an independent extension:

```text
extensions/
  image.ts            # /image and generate_image
  search.ts           # /sn-search
  usage.ts            # /usage, cache, refresh, status and events
  footer.ts           # package-local two/three-line TUI footer
  codex-recovery.ts   # /codex-recovery and OpenAI transport recovery
```

| Capability | xAI/Grok subscription | OpenAI/Codex subscription |
| --- | --- | --- |
| Image generation | Yes | Yes |
| Hosted web search | Yes (default) | Yes (explicit only) |
| Read-only quota usage | Yes | Yes |
| Inline footer quota | Yes | Yes |
| Transport/capacity recovery | No | Yes |

Resources can be selected without splitting the package, for example:

```json
{
  "packages": [
    {
      "source": "git:github.com/yy003x/pi-sinan",
      "extensions": ["image", "search", "usage", "footer", "codex-recovery"]
    }
  ]
}
```

## Commands and tool

### Image

- Tool: `generate_image`
- Command: `/image <prompt> [--path file.png] [--aspect 16:9] [--provider auto|xai|openai]`

`auto` tries xAI first and OpenAI second only when xAI is unavailable or its
generation request fails. An explicit provider never crosses to the other
subscription. Once provider bytes exist, local conversion/write failures do
not trigger another generation. Output defaults to
`.pi-images/<timestamp>.png`; returned JPEG data is normalized to PNG.

OpenAI resolves Pi's internal `openai-codex` OAuth credential and calls the
official ChatGPT Codex image endpoint with `gpt-image-2`. xAI uses
`grok-imagine-image-2.0` by default.

```text
/image a watercolor observatory at dusk
/image a wide product sketch --aspect 16:9 --provider openai
/image config on
/image config off
/image config dir .pi-images
```

### Search

- Command: `/sn-search <query> [--provider xai|openai]`
- Default and strict provider: `xai`

xAI uses its hosted Responses `web_search`. OpenAI is used only with explicit
`--provider openai` and calls the official ChatGPT Codex Responses endpoint.
Both paths require cited HTTP(S) sources; failures never cross providers.

```text
/sn-search latest TypeScript release notes
/sn-search current Codex documentation --provider openai
```

### Usage

- Command: `/usage`

Usage follows the provider of the current model and supports only
`openai-codex` and `xai`. It performs read-only official quota requests,
refreshes automatically after model/session activity, caches successful
reports for five minutes, and backs off failures for 30 seconds. It publishes
plain `setStatus("pi-sinan-usage", ...)` text and structured
`pi-sinan/usage-status/v1` events. No Codex credit redemption or other quota
write operation exists.

### Footer

The independent footer extension consumes the package's `pi-sinan-usage`
status. It preserves native token/context/model information, cwd, Git branch,
session name, cache/cost details, narrow-terminal degradation, and statuses
owned by other extensions. It has no dependency on an externally installed
usage package.

### Codex recovery

- Command: `/codex-recovery`
- Command: `/codex-recovery reset`

For OpenAI Codex only, automatic transport mode prefers Pi's cached WebSocket,
uses SSE during a two-minute cooldown after a transport failure, and probes
WebSocket again after successful SSE requests or cooldown expiry. Capacity
errors add bounded, abortable delay before Pi's next retry. Explicit transport
settings pass through unchanged. The reset command clears only in-memory
transport/capacity recovery state; it does not modify subscription quota.

## Configuration

All package configuration uses the new `piSinan` namespace. Image command
configuration is stored in global `~/.pi/agent/settings.json`; usage and footer
settings may also be overridden in a trusted project's `.pi/settings.json`:

```json
{
  "piSinan": {
    "image": {
      "outputDir": ".pi-images",
      "showInConversation": true
    },
    "usage": {
      "displayMode": "remaining",
      "refreshMs": 300000
    },
    "footer": {
      "enabled": true
    }
  }
}
```

`usage.displayMode` is `remaining` or `used`; `refreshMs` must be at least
30 seconds. Generated paths must remain inside the current workspace.

## Authentication and safety boundaries

- Sign in through Pi `/login`; image, search, and usage accept Pi OAuth only.
- Credentials are resolved at request time through Pi's model registry. They
  are not written to settings, session entries, status/events, errors, or
  usage caches.
- Usage, OpenAI image, and hosted search credentials fail closed to their
  official HTTPS endpoints. Redirects are rejected for all authenticated
  requests.
- Image generation accepts only the requested inline `b64_json` payload;
  provider-returned URLs are never fetched.
- Validation tests use mocked requests and do not consume subscription quota.
- Account entitlement and provider-side rollout remain account-dependent; no
  live request is made during installation or tests.

## Migration from pi-access

Version `0.2.0` is a breaking rename. Migrate in this order so Pi never loads
duplicate commands, tools, providers, or footers:

1. Remove both superseded packages:
   ```bash
   pi remove git:git@github.com:yy003x/pi-access.git
   pi remove npm:@specode/pi-subscription-usage
   ```
2. Remove the old standalone `subscription-inline-footer.ts` from your Pi
   extensions directory (if present).
3. Install the renamed package:
   ```bash
   pi install git:github.com/yy003x/pi-sinan
   ```
4. Run `/reload` in Pi.

Then replace configuration root `piAccess` with `piSinan` and use the extension
name `codex-recovery`. Old package names, configuration keys, headers, symbols,
entries, messages, and markers are not read or retained as compatibility
aliases.

The package is MIT licensed. Selectively adapted usage sources and attribution
are documented in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
