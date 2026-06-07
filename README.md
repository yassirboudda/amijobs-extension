# AmiJobs Extension

Multi-platform job auto-apply Chrome extension for **LinkedIn** and **Hellowork**, powered by **Mistral AI**.

Website: [amijobs.com](https://amijobs.com)

## Features

- Apply on **Hellowork** and **LinkedIn** simultaneously (separate tabs, parallel sessions)
- Unified **candidate profile** (used by both platforms + Mistral)
- **Blacklisted companies** (shared across platforms)
- **Mistral AI** for smart form filling and screening questions
- **French / English** UI with automatic browser language detection
- Platform checkboxes — Indeed, Monster coming soon

## Install (developer mode)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder (`amijobs/`)

## Usage

1. Open **Configuration** and fill in your profile + optional Mistral API key
2. In the popup, select **Hellowork**, **LinkedIn**, or both
3. Enter keywords and location, then **Start session**
4. Two tabs open when both platforms are selected — each runs its own apply loop

## Project structure

```
amijobs/
  manifest.json
  background.js          # Unified session orchestration + Mistral
  popup.html / popup.js  # Multi-platform launcher
  options.html / options.js
  i18n.js                # FR / EN translations
  content/
    hellowork.js         # Hellowork automation (from HelloworkAutoApply)
    linkedin.js          # LinkedIn automation (from LinkedInAutoApply)
  icons/
  scripts/patch-content.py
```

## Regenerate content scripts

After updating upstream Hellowork or LinkedIn content sources:

```bash
python3 scripts/patch-content.py
```

## License

Private — All rights reserved.
