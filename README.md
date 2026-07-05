# AmiJobs Extension

Multi-platform job auto-apply Chrome extension for **LinkedIn**, **Hellowork**, **Indeed**, and **Glassdoor**, powered by **Mistral AI**.

Website: [amijobs.com](https://amijobs.com)

## Features

- Apply on **Hellowork**, **LinkedIn**, **Indeed**, and **Glassdoor** simultaneously (separate tabs, parallel sessions)
- Unified **candidate profile** (used by all platforms + Mistral)
- **Blacklisted companies** (shared across platforms)
- **Mistral AI** for smart form filling and screening questions
- **French / English / Spanish** UI with automatic browser language detection
- **Indeed location autocomplete** (canonical city/region names for better search results)
- **Multi-location** and **multi-contract** search in the popup

## Install (developer mode)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder (`amijobs/`)

## Usage

1. Open **Configuration** and fill in your profile + optional Mistral API key
2. In the popup, select one or more platforms (Hellowork, LinkedIn, Indeed, Glassdoor)
3. Enter keywords and location, then **Start session**
4. One tab opens per selected platform — each runs its own apply loop

### Platform notes

- **Indeed**: applies to jobs with **Indeed Apply** (candidature simplifiée). External redirects are skipped.
- **Glassdoor**: applies to jobs with **Easy Apply** / quick apply when available.
- **Hellowork / LinkedIn**: same behavior as before (full apply loop with Mistral).

## Project structure

```
amijobs/
  manifest.json
  background.js          # Unified session orchestration + Mistral
  popup.html / popup.js  # Multi-platform launcher
  options.html / options.js
  i18n.js                # FR / EN translations
  content/
    hellowork.js         # Hellowork automation
    linkedin.js          # LinkedIn automation
    indeed.js            # Indeed automation
    glassdoor.js         # Glassdoor automation
    shared-autofill.js   # Shared form fill + Mistral field answers
  icons/
  scripts/patch-content.py
```

## Chrome Web Store zip

```bash
cd amijobs
zip -r dist/amijobs-extension-v1.2.5.zip . \
  -x "*.git*" -x "dist/*" -x "scripts/*" -x "*.md"
```

## Regenerate content scripts

After updating upstream Hellowork or LinkedIn content sources:

```bash
python3 scripts/patch-content.py
```

## License

Private — All rights reserved.
