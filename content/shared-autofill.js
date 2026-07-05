// AmiJobs — shared form-fill helpers for job platform content scripts
(function () {
  if (window.AmiJobsShared) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randomDelay = (min, max) => Math.floor(Math.random() * (max - min)) + min;

  function $(selector, root = document) {
    return root.querySelector(selector);
  }
  function $$(selector, root = document) {
    return [...root.querySelectorAll(selector)];
  }

  function setNativeValue(element, value) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function humanClick(element) {
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(200 + Math.random() * 300);
    element.click();
  }

  async function humanType(element, text) {
    element.focus();
    setNativeValue(element, "");
    for (const char of String(text)) {
      element.value += char;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(10 + Math.random() * 30);
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function getFieldLabel(el) {
    const id = el.id;
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) return label.textContent.trim();
    }
    const wrap = el.closest("label");
    if (wrap) return wrap.textContent.trim();
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      "field"
    ).trim();
  }

  function isVisible(el) {
    if (!el || el.disabled || el.readOnly) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  async function getProfile() {
    const { profile = {} } = await chrome.storage.local.get(["profile"]);
    return profile;
  }

  async function profileAnswer(label, profile) {
    const l = label.toLowerCase();
    if (/e-?mail/.test(l)) return profile.email || "";
    if (/phone|téléphone|tel/.test(l)) return profile.phone || "";
    if (/first|prénom/.test(l)) return profile.firstName || (profile.fullName || "").split(" ")[0] || "";
    if (/last|nom/.test(l) && !/company|entreprise/.test(l)) {
      const parts = (profile.fullName || "").split(" ");
      return profile.lastName || parts.slice(1).join(" ") || "";
    }
    if (/full name|nom complet|name/.test(l)) return profile.fullName || "";
    if (/city|ville|location|localisation/.test(l)) return (profile.location || "").split(",")[0].trim();
    if (/postal|zip|code postal/.test(l)) return profile.postalCode || "";
    if (/linkedin/.test(l)) return profile.linkedin || "";
    if (/title|titre|poste/.test(l)) return profile.title || "";
    if (/salary|salaire/.test(l)) return profile.salaryExpectation || "";
    if (/availability|disponibilit/.test(l)) return profile.availability || "";
    if (/cover|motivation|lettre|message|why|pourquoi/.test(l)) {
      return profile.coverLetterDefault || "";
    }
    return "";
  }

  async function isCompanyBlacklisted(companyName) {
    if (!companyName) return false;
    const { blacklistedCompanies = [] } = await chrome.storage.local.get(["blacklistedCompanies"]);
    const companyLower = companyName.toLowerCase();
    return blacklistedCompanies.some((blocked) => {
      const b = String(blocked).toLowerCase().trim();
      return b && (companyLower.includes(b) || b.includes(companyLower));
    });
  }

  async function fillField(field, jobInfo, platform) {
    const el = field.element;
    const label = field.label;
    const profile = await getProfile();
    const direct = await profileAnswer(label, profile);

    if (field.type === "checkbox") {
      const mandatory = /accept|terms|agree|consent|certif|confirm/i.test(label);
      if ((mandatory || /yes|oui|true/i.test(direct)) && !el.checked) await humanClick(el);
      return;
    }

    if (field.type === "select") {
      const options = [...el.options].map((o) => o.text.trim()).filter(Boolean);
      let answer = direct;
      if (!answer) {
        const res = await chrome.runtime.sendMessage({
          action: "generateAnswer",
          question: label,
          fieldType: "select",
          options,
          jobInfo,
        });
        answer = res?.answer || options[1] || options[0] || "";
      }
      let idx = options.findIndex((o) => o.toLowerCase() === String(answer).toLowerCase());
      if (idx < 0) {
        idx = options.findIndex(
          (o) =>
            o.toLowerCase().includes(String(answer).toLowerCase()) ||
            String(answer).toLowerCase().includes(o.toLowerCase())
        );
      }
      if (idx >= 0) {
        el.selectedIndex = idx;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }

    if (field.type === "radio") {
      const res = await chrome.runtime.sendMessage({
        action: "generateAnswer",
        question: label,
        fieldType: "radio",
        options: field.options || [],
        jobInfo,
      });
      const answer = (direct || res?.answer || "").toLowerCase();
      const radios = field.elements || [];
      let target = radios.find((r, i) => (field.options[i] || "").toLowerCase().includes(answer));
      if (!target) target = radios.find((r, i) => /yes|oui|true|accept/i.test(field.options[i] || ""));
      if (target) await humanClick(target);
      return;
    }

    let answer = direct;
    if (!answer) {
      const res = await chrome.runtime.sendMessage({
        action: "generateAnswer",
        question: label,
        fieldType: field.type,
        options: [],
        jobInfo,
      });
      answer = res?.answer || "";
    }
    if (!answer) return;
    if (field.type === "number") {
      const num = String(answer).match(/\d+/);
      answer = num ? num[0] : "1";
    }
    await humanType(el, answer);
  }

  async function shouldSkipCompany(company) {
    if (!company) return false;
    if (await isCompanyBlacklisted(company)) return "blacklist";
    const { autoApplySettings = {} } = await chrome.storage.local.get(["autoApplySettings"]);
    const max = autoApplySettings.maxApplicationsPerCompany || 0;
    if (max > 0) {
      const res = await chrome.runtime.sendMessage({ action: "companyApplyCount", company });
      if ((res?.count || 0) >= max) return "company_limit";
    }
    return false;
  }

  function collectFields(root = document) {
    const fields = [];
    const roots = [root];
    try {
      for (const frame of document.querySelectorAll("iframe")) {
        try {
          const doc = frame.contentDocument || frame.contentWindow?.document;
          if (doc) roots.push(doc);
        } catch (_e) {
          /* cross-origin iframe */
        }
      }
    } catch (_e) {}
    for (const r of roots) {
      for (const el of $$("input, textarea, select", r)) {
        if (!isVisible(el)) continue;
        const type = (el.getAttribute("type") || el.tagName.toLowerCase()).toLowerCase();
        if (["hidden", "submit", "button", "file", "image", "reset"].includes(type)) continue;
        if (type === "radio") {
          const name = el.name;
          if (!name || fields.some((f) => f.type === "radio" && f.name === name)) continue;
          const group = $$(`input[type="radio"][name="${CSS.escape(name)}"]`, r).filter(isVisible);
          fields.push({
            type: "radio",
            name,
            label: getFieldLabel(group[0]),
            elements: group,
            options: group.map((g) => getFieldLabel(g) || g.value),
            element: group[0],
          });
          continue;
        }
        fields.push({
          type: type === "textarea" ? "textarea" : type,
          label: getFieldLabel(el),
          element: el,
        });
      }
    }
    return fields;
  }

  async function fillVisibleFields(jobInfo, platform) {
    const fields = collectFields();
    for (const field of fields) {
      try {
        await fillField(field, jobInfo, platform);
        await sleep(150 + Math.random() * 250);
      } catch (e) {
        console.warn("[AmiJobsShared] fill error", e);
      }
    }
  }

  function findActionButton(patterns, root = document) {
    const buttons = $$("button, a[role='button'], input[type='submit']", root);
    for (const btn of buttons) {
      if (!isVisible(btn) || btn.disabled) continue;
      const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`.toLowerCase();
      if (patterns.some((p) => p.test(text))) return btn;
    }
    return null;
  }

  function findActionButtonDeep(patterns) {
    const roots = [document];
    try {
      for (const frame of document.querySelectorAll("iframe")) {
        try {
          const doc = frame.contentDocument || frame.contentWindow?.document;
          if (doc) roots.push(doc);
        } catch (_e) {
          /* cross-origin */
        }
      }
    } catch (_e) {}
    for (const root of roots) {
      const btn = findActionButton(patterns, root);
      if (btn) return btn;
    }
    return null;
  }

  window.AmiJobsShared = {
    sleep,
    randomDelay: (min, max) => Math.floor(Math.random() * (max - min)) + min,
    $,
    $$,
    humanClick,
    humanType,
    setNativeValue,
    getFieldLabel,
    isVisible,
    getProfile,
    isCompanyBlacklisted,
    shouldSkipCompany,
    fillVisibleFields,
    collectFields,
    findActionButton,
    findActionButtonDeep,
    log(platform, msg, level = "info") {
      const ts = new Date().toISOString().slice(11, 23);
      console.log(`[AmiJobs ${platform} ${ts}] ${msg}`);
      chrome.runtime
        .sendMessage({ action: "addLog", platform, message: `[${ts}] ${msg}`, level })
        .catch(() => {});
    },
  };
})();
