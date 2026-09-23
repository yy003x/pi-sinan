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
  image.ts            # /sn-image and generate_image
  search.ts           # /sn-search
  usage.ts            # /sn-usage, quota refresh, and Codex reset redemption
  fast.ts             # /sn-fast OpenAI Codex Fast request toggle
  doctor.ts           # /sn-doctor read-only OAuth/endpoint diagnostics
  codex-recovery.ts   # /sn-recovery and OpenAI transport recovery
```

| Capability | xAI/Grok subscription | OpenAI/Codex subscription |
| --- | --- | --- |
| Image generation | Yes | Yes |
| Hosted web search | Yes (default) | Yes (explicit only) |
| Quota usage | Yes | Yes |
| Codex reset-credit redemption | No | Yes |
| Fast request toggle | No | Yes |
| Usage status/events for pi-utils footer | Yes | Yes |
| Transport/capacity recovery | No | Yes |

Resources can be selected without splitting the package, for example:

```json
{
  "packages": [
    {
      "source": "git:github.com/yy003x/pi-sinan",
      "extensions": ["image", "search", "usage", "fast", "doctor", "codex-recovery"]
    }
  ]
}
```

## Commands and tool

### Image

- Tool: `generate_image`
- Command: `/sn-image <prompt> [--path file.png] [--aspect 16:9] [--provider auto|xai|openai]`

`auto` tries xAI first and OpenAI second only when xAI is unavailable or its
generation request fails. An explicit provider never crosses to the other
subscription. Once provider bytes exist, local conversion/write failures do
not trigger another generation. Output defaults to
`.pi-images/<timestamp>.png`; returned JPEG data is normalized to PNG.

OpenAI resolves Pi's internal `openai-codex` OAuth credential and calls the
official ChatGPT Codex image endpoint with `gpt-image-2`. xAI uses
`grok-imagine-image-2.0` by default.

```text
/sn-image a watercolor observatory at dusk
/sn-image a wide product sketch --aspect 16:9 --provider openai
/sn-image config
/sn-image config status
/sn-image config dir .pi-images
```

Image previews are off by default unless explicitly configured. `/sn-image config`
toggles the global preview setting and reports `off -> on` or `on -> off`;
`config status` reads it without changing it. `--preview` and `--no-preview`
still override a single generation. Existing explicit
`piSinan.image.showInConversation` settings remain authoritative.

`/sn-image history` lists images and IDs in the current session branch; `/sn-image show [index|id]`
shows a saved image; `/sn-image repeat [index|id]` explicitly generates a new image
with the original prompt, provider and aspect ratio, consuming subscription
quota. No global prompt index is written. Files are created without overwriting.

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

- Commands: `/sn-usage`, `/sn-usage all`, `/sn-usage alerts`

Current usage follows the provider of the current model; `all` queries eligible
signed-in OAuth models for both `openai-codex` and `xai` independently. Alerts
(default off unless explicitly configured) report remaining quota crossing
configurable 20/10/5 percent thresholds once per account fingerprint and quota
window. `/sn-usage alerts` toggles them for the current session only and reports
`off -> on` or `on -> off`. Resets show relative time. The independent pi-utils
extension owns the sole TUI footer. Usage still publishes `pi-sinan-usage`
status and `pi-sinan/usage-status/v1` events. It refreshes automatically after
model/session activity, caches successful reports for five minutes, and backs
off failures for 30 seconds.

When Codex reports available reset credits, `/sn-usage` offers an explicit
redemption flow. It revalidates the current Pi OAuth account, requires credit
selection plus an irreversible confirmation, reuses one request ID for any
user-approved retry, and refreshes quota after a confirmed result. This is the
only quota write operation; xAI usage remains read-only.

### Fast requests

- Commands: `/sn-fast` (toggle), `/sn-fast status` (read-only)

Fast mode is off by default. Each `/sn-fast` toggles the request setting and
reports `off -> on` or `on -> off`. Enabling it requires the official Codex model
catalog GET to list the selected model slug with `service_tiers.id=priority`.
Only supported Codex request payloads receive `service_tier: "priority"`.
The catalog and OAuth are revalidated when the model changes and before an
enabled provider request; unavailable metadata fails closed. This requests a
tier but cannot prove the server honored it. `pi-sinan/fast-status/v1` emits
structured local status. The setting is stored in the current Pi session, survives
reload/resume, and never changes xAI or other providers. Fast availability and
its higher subscription-credit consumption remain account/model dependent.

### Doctor

`/sn-doctor [all]` checks official model origins, OAuth, image/search/usage
endpoint eligibility, Codex catalog Fast support for the selected model, and
local recovery state. It does not send paid image/search POST requests.

### Codex recovery

- Command: `/sn-recovery status [openai-codex|xai|all]`
- Command: `/sn-recovery reset [openai-codex|xai|all]`

Only Codex has a recovery adapter; xAI status explicitly reports no adapter
and xAI reset is a no-op. `pi-sinan/recovery-status/v1` reports structured
local state. For OpenAI Codex, automatic transport mode prefers Pi's normal
WebSocket
path, uses SSE during a two-minute cooldown after a transport failure, and
probes WebSocket directly after successful SSE requests or cooldown expiry.
Capacity errors add bounded, abortable delay before Pi's next retry. Explicit
transport settings pass through unchanged. The reset command clears only
in-memory transport/capacity recovery state and forces the next automatic call
to probe WebSocket directly; it does not modify subscription quota.

## Configuration

All package configuration uses the new `piSinan` namespace. Image command
configuration is stored in global `~/.pi/agent/settings.json`; usage
settings may also be overridden in a trusted project's `.pi/settings.json`:

```json
{
  "piSinan": {
    "image": {
      "outputDir": ".pi-images",
      "showInConversation": false
    },
    "usage": {
      "displayMode": "remaining",
      "refreshMs": 300000,
      "alerts": false,
      "alertThresholds": [20, 10, 5]
    }
  }
}
```

`usage.displayMode` is `remaining` or `used`; `refreshMs` must be at least
30 seconds. Generated paths must remain inside the current workspace. Values
explicitly set to `true` in settings are still honored; changing the defaults
does not rewrite existing settings.

## Authentication and safety boundaries

- Sign in through Pi `/login`; image, search, and usage accept Pi OAuth only.
- Credentials are resolved at request time through Pi's model registry. They
  are not written to settings, session entries, status/events, errors, or
  usage caches.
- Usage, reset redemption, OpenAI image, and hosted search credentials fail
  closed to their official HTTPS endpoints. Redirects are rejected for all
  authenticated requests.
- Reset redemption additionally requires the active runtime token to exactly
  match Pi's stored OAuth account and always defaults the irreversible
  confirmation to cancellation.
- Image generation accepts only the requested inline `b64_json` payload;
  provider-returned URLs are never fetched.
- Validation tests use mocked requests and do not consume subscription quota
  or reset credits.
- Account entitlement and provider-side rollout remain account-dependent; no
  live request is made during installation or tests.

## Migration from pi-access

Version `0.2.0` is a breaking rename. Migrate in this order so Pi never loads
duplicate commands, tools, or providers:

1. Remove both superseded packages:
   ```bash
   pi remove git:git@github.com:yy003x/pi-access.git
   pi remove npm:@specode/pi-subscription-usage
   ```
2. Let pi-utils own the sole footer; remove any old standalone footer if present.
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
