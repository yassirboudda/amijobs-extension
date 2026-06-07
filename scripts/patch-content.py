#!/usr/bin/env python3
"""Patch Hellowork / LinkedIn content scripts for AmiJobs multi-platform storage."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HW_SRC = ROOT.parent / "helloworkAutoApply/HelloworkAutoApply/content.js"
LI_SRC = ROOT.parent / "LinkedInAutoApply-main/content.js"
HW_DST = ROOT / "content/hellowork.js"
LI_DST = ROOT / "content/linkedin.js"

VERSION = "1.0.0"


def patch_hellowork(text: str) -> str:
    text = text.replace("window.__HelloworkAutoApplyLoaded", "window.__AmijobsHelloworkLoaded")
    text = text.replace('const VERSION = "1.0.28"', f'const VERSION = "{VERSION}"')
    text = text.replace("[HelloworkAutoApply", "[AmiJobs Hellowork")
    text = text.replace('await chrome.storage.local.get(["session"])', 'await chrome.storage.local.get(["sessionHellowork"])')
    text = text.replace(
        'const { session = null } = await chrome.storage.local.get(["sessionHellowork"])',
        'const { sessionHellowork: session = null } = await chrome.storage.local.get(["sessionHellowork"])',
    )
    text = text.replace("await chrome.storage.local.set({ session: next })", "await chrome.storage.local.set({ sessionHellowork: next })")
    text = text.replace(
        'await chrome.runtime.sendMessage({ action: "endSession" });',
        'await chrome.runtime.sendMessage({ action: "endPlatformSession", platform: "hellowork", reason });',
    )
    text = re.sub(
        r'action: "markApplied",',
        'action: "markApplied", platform: "hellowork",',
        text,
    )
    text = re.sub(
        r'action: "markSkipped",',
        'action: "markSkipped", platform: "hellowork",',
        text,
    )
    text = re.sub(
        r'action: "markError",',
        'action: "markError", platform: "hellowork",',
        text,
    )
    text = re.sub(
        r'chrome\.runtime\.sendMessage\(\{ action: "addLog", message, level \}\)',
        'chrome.runtime.sendMessage({ action: "addLog", message: `[Hellowork] ${message}`, level, platform: "hellowork" })',
        text,
    )
    return text


def patch_linkedin(text: str) -> str:
    text = text.replace("window.__LinkedInAutoApply_loaded", "window.__AmijobsLinkedinLoaded")
    text = re.sub(r'const VERSION = "[^"]+"', f'const VERSION = "{VERSION}"', text, count=1)
    text = text.replace("[LinkedInAutoApply", "[AmiJobs LinkedIn")
    text = text.replace('await chrome.storage.local.get(["session"])', 'await chrome.storage.local.get(["sessionLinkedin"])')
    text = text.replace(
        'const { session } = await chrome.storage.local.get(["sessionLinkedin"])',
        'const { sessionLinkedin: session } = await chrome.storage.local.get(["sessionLinkedin"])',
    )
    text = text.replace(
        'const { session: currentSession } = await chrome.storage.local.get(["sessionLinkedin"])',
        'const { sessionLinkedin: currentSession } = await chrome.storage.local.get(["sessionLinkedin"])',
    )
    text = text.replace(
        'await chrome.runtime.sendMessage({ action: "endSession" })',
        'await chrome.runtime.sendMessage({ action: "endPlatformSession", platform: "linkedin" })',
    )
    text = text.replace(
        'await chrome.runtime.sendMessage({ action: "endSession" }).catch(() => {});',
        'await chrome.runtime.sendMessage({ action: "endPlatformSession", platform: "linkedin" }).catch(() => {});',
    )
    text = re.sub(r'action: "markApplied",', 'action: "markApplied", platform: "linkedin",', text)
    text = re.sub(r'action: "markSkipped",', 'action: "markSkipped", platform: "linkedin",', text)
    text = re.sub(r'action: "markError",', 'action: "markError", platform: "linkedin",', text)
    text = re.sub(
        r'chrome\.runtime\.sendMessage\(\{ action: "addLog", message:',
        'chrome.runtime.sendMessage({ action: "addLog", message: `[LinkedIn] ${',
        text,
    )
    # Fix broken addLog patch - revert and do simpler
    text = text.replace(
        'chrome.runtime.sendMessage({ action: "addLog", message: `[LinkedIn] ${',
        'chrome.runtime.sendMessage({ action: "addLog", platform: "linkedin", message:',
    )
    return text


def main():
    HW_DST.parent.mkdir(parents=True, exist_ok=True)
    hw = patch_hellowork(HW_SRC.read_text(encoding="utf-8"))
    HW_DST.write_text(hw, encoding="utf-8")
    print(f"Wrote {HW_DST} ({len(hw.splitlines())} lines)")

    li = patch_linkedin(LI_SRC.read_text(encoding="utf-8"))
    LI_DST.write_text(li, encoding="utf-8")
    print(f"Wrote {LI_DST} ({len(li.splitlines())} lines)")


if __name__ == "__main__":
    main()
