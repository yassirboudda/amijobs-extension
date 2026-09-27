// AmiJobs — question preference matching (content + service worker)
(function (root) {
  const STOP = new Set([
    "a", "an", "the", "are", "you", "is", "in", "of", "do", "does", "have", "has", "your", "to", "for",
    "on", "at", "or", "and", "i", "am", "we", "be", "this", "that", "with", "from", "was", "were",
    "avec", "vous", "avez", "etes", "votre", "les", "des", "une", "un", "le", "la", "de", "du", "en",
    "est", "suis", "je", "tu", "il", "qui", "que", "quoi", "dans", "pour", "sur", "au", "aux", "ces",
    "cet", "cette", "oui", "non", "yes", "no", "please", "select", "choisir",
  ]);

  function normalizeQuestion(q) {
    return String(q || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isYnOptionText(t) {
    return /^(oui|non|yes|no|true|false|y|n|o)$/i.test(String(t || "").replace(/\s+/g, " ").trim());
  }

  function tokens(q) {
    return normalizeQuestion(q)
      .split(" ")
      .filter((t) => t.length >= 2 && !STOP.has(t));
  }

  function extractCountry(q) {
    const n = normalizeQuestion(q);
    const groups = [
      ["france", "francais", "francaise", "french"],
      ["germany", "allemagne", "deutschland", "german"],
      ["belgium", "belgique", "belgie"],
      ["switzerland", "suisse", "schweiz"],
      ["spain", "espagne", "espanol"],
      ["italy", "italie", "italia"],
      ["uk", "united kingdom", "royaume uni", "england", "britain"],
      ["netherlands", "pays bas", "holland"],
      ["canada"],
      ["usa", "united states", "etats unis", "america"],
      ["luxembourg"],
      ["eu", "ue", "europe", "european", "europeen", "europeenne"],
    ];
    for (const aliases of groups) {
      if (aliases.some((a) => n.includes(a))) return aliases[0];
    }
    return "";
  }

  function intentKey(q) {
    const n = normalizeQuestion(q);
    const country = extractCountry(n);
    const live =
      /live|living|reside|resid|habit|based|located|leaving|stay|vivre|habitez|habitant|currently live/.test(n);
    const work =
      /work|travail|travailler|autoris|right to work|visa|permit|eligible|legally|permis de travail|work authorization|allowed to|legal(ly)? authorized/.test(
        n
      );
    if (country && (live || work)) return `geo:${country}`;
    if (work) return `workauth:${country || "any"}`;
    if (live) return `reside:${country || "any"}`;
    return "";
  }

  function jaccard(a, b) {
    const A = new Set(tokens(a));
    const B = new Set(tokens(b));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter += 1;
    return inter / (A.size + B.size - inter);
  }

  function questionsAreSimilar(a, b) {
    if (!a || !b) return false;
    const na = normalizeQuestion(a);
    const nb = normalizeQuestion(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.length >= 12 && nb.length >= 12 && (na.includes(nb) || nb.includes(na))) return true;
    const ia = intentKey(a);
    const ib = intentKey(b);
    if (ia && ia === ib) return true;
    return jaccard(a, b) >= 0.55;
  }

  function findMatchingPreference(prefs, question) {
    const list = Array.isArray(prefs) ? prefs : [];
    for (const p of list) {
      if (p?.question && questionsAreSimilar(p.question, question)) return p;
    }
    return null;
  }

  function normalizeAnswer(answer) {
    const a = String(answer || "").replace(/\s+/g, " ").trim();
    if (/^(oui|yes|true|1)$/i.test(a)) return "Oui";
    if (/^(non|no|false|0)$/i.test(a)) return "Non";
    return a;
  }

  function upsertQuestionPreference(prefs, question, answer) {
    const q = String(question || "").replace(/\s+/g, " ").trim();
    const a = normalizeAnswer(answer);
    if (!q || q.length < 8 || isYnOptionText(q) || !a) {
      return { prefs: Array.isArray(prefs) ? prefs : [], changed: false, skipped: "invalid" };
    }
    const list = Array.isArray(prefs) ? prefs.map((p) => ({ ...p })) : [];
    const hit = findMatchingPreference(list, q);
    if (hit) {
      if (normalizeAnswer(hit.answer) === a) {
        return { prefs: list, changed: false, skipped: "same" };
      }
      hit.answer = a;
      hit.updatedAt = Date.now();
      return { prefs: list, changed: true, updated: true };
    }
    list.push({ question: q, answer: a, updatedAt: Date.now() });
    return { prefs: list, changed: true, added: true };
  }

  function extractQuestionText(el) {
    if (!el) return "";
    const pick = (raw) => {
      let t = String(raw || "")
        .replace(/\s+/g, " ")
        .trim();
      t = t.replace(/(\s*(oui|non|yes|no)){1,4}\s*$/gi, "").trim();
      if (!t || isYnOptionText(t) || t.length < 8) return "";
      return t.slice(0, 280);
    };
    // Indeed Smart Apply: <div data-testid="question">Do you live in France?</div>
    let node = el;
    for (let i = 0; i < 10 && node; i++) {
      if (node.getAttribute?.("data-testid") === "question") {
        const t = pick(node.textContent);
        if (t) return t;
      }
      node = node.parentElement;
    }
    const block = el.closest?.(
      '[data-testid^="question-"], [data-testid*="question"], [class*="question"], fieldset, .ia-Questions-item, [class*="Question"], [role="group"], [class*="FormField"]'
    );
    if (block) {
      const exact = [...block.querySelectorAll('[data-testid="question"]')].find(
        (n) => !n.querySelector("input, select, textarea")
      );
      const et = pick(exact?.textContent);
      if (et) return et;
      const heading = block.querySelector(
        "legend, h1, h2, h3, h4, [data-testid*='questionLabel' i], [data-testid*='QuestionText' i]"
      );
      const ht = pick(heading?.textContent);
      if (ht) return ht;
      for (const n of block.querySelectorAll("span, p, div, label, [id*='label' i]")) {
        if (n.querySelector("input, select, textarea, button")) continue;
        const t = pick(n.textContent);
        if (t && t.length >= 12 && !isYnOptionText(t)) return t;
      }
      const all = pick(block.innerText);
      if (all) return all;
    }
    const byFor =
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) || "";
    const wrap = el.closest?.("label")?.textContent || "";
    const aria = el.getAttribute?.("aria-label") || "";
    return pick(aria) || pick(byFor) || pick(wrap);
  }

  const api = {
    normalizeQuestion,
    normalizeAnswer,
    isYnOptionText,
    extractCountry,
    intentKey,
    questionsAreSimilar,
    findMatchingPreference,
    upsertQuestionPreference,
    extractQuestionText,
  };
  root.AmiJobsQuestionPref = api;
})(typeof window !== "undefined" ? window : self);
