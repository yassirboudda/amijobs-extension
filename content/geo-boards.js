/**
 * AmiJobs — map a free-text location to Indeed / Glassdoor country boards.
 * Loaded in the service worker (importScripts) and in Indeed/Glassdoor content scripts.
 */
(function (root) {
  "use strict";

  /** ISO → Indeed origin. US uses www; UK uses uk.indeed.com. */
  const INDEED_SPECIAL = {
    us: "https://www.indeed.com",
    gb: "https://uk.indeed.com",
    uk: "https://uk.indeed.com",
  };

  /**
   * ISO → Glassdoor origin. Countries without a local site use glassdoor.com
   * (e.g. PL — product requirement).
   */
  const GLASSDOOR_BY_CC = {
    fr: "https://www.glassdoor.fr",
    be: "https://www.glassdoor.be",
    de: "https://www.glassdoor.de",
    nl: "https://www.glassdoor.nl",
    at: "https://www.glassdoor.at",
    ch: "https://www.glassdoor.ch",
    gb: "https://www.glassdoor.co.uk",
    uk: "https://www.glassdoor.co.uk",
    ie: "https://www.glassdoor.ie",
    ca: "https://www.glassdoor.ca",
    au: "https://www.glassdoor.com.au",
    nz: "https://www.glassdoor.co.nz",
    in: "https://www.glassdoor.co.in",
    br: "https://www.glassdoor.com.br",
    mx: "https://www.glassdoor.com.mx",
    sg: "https://www.glassdoor.sg",
    hk: "https://www.glassdoor.com.hk",
    es: "https://www.glassdoor.es",
    it: "https://www.glassdoor.it",
  };

  /** Country names / demonyms (multi-language) → ISO. */
  const COUNTRY_NAMES = {
    "united states of america": "us",
    "united states": "us",
    "etats-unis": "us",
    "états-unis": "us",
    "estados unidos": "us",
    usa: "us",
    "united kingdom": "uk",
    "royaume-uni": "uk",
    "reino unido": "uk",
    england: "uk",
    angleterre: "uk",
    scotland: "uk",
    wales: "uk",
    britain: "uk",
    "grande-bretagne": "uk",
    france: "fr",
    frankreich: "fr",
    francia: "fr",
    belgium: "be",
    belgie: "be",
    belgië: "be",
    belgique: "be",
    belgica: "be",
    belgien: "be",
    germany: "de",
    deutschland: "de",
    allemagne: "de",
    alemania: "de",
    netherlands: "nl",
    nederland: "nl",
    "pays-bas": "nl",
    holland: "nl",
    holanda: "nl",
    poland: "pl",
    polska: "pl",
    pologne: "pl",
    polonia: "pl",
    spain: "es",
    espana: "es",
    españa: "es",
    espagne: "es",
    italy: "it",
    italia: "it",
    italie: "it",
    portugal: "pt",
    switzerland: "ch",
    suisse: "ch",
    schweiz: "ch",
    svizzera: "ch",
    suiza: "ch",
    austria: "at",
    osterreich: "at",
    österreich: "at",
    autriche: "at",
    ireland: "ie",
    irlande: "ie",
    eire: "ie",
    éire: "ie",
    canada: "ca",
    australia: "au",
    australie: "au",
    "new zealand": "nz",
    "nouvelle-zelande": "nz",
    "nouvelle-zélande": "nz",
    india: "in",
    inde: "in",
    brazil: "br",
    brasil: "br",
    bresil: "br",
    brésil: "br",
    mexico: "mx",
    mexique: "mx",
    méxico: "mx",
    singapore: "sg",
    singapour: "sg",
    "hong kong": "hk",
    "hong-kong": "hk",
    japan: "jp",
    japon: "jp",
    "south korea": "kr",
    korea: "kr",
    "coree du sud": "kr",
    "corée du sud": "kr",
    sweden: "se",
    suede: "se",
    suède: "se",
    sverige: "se",
    norway: "no",
    norvege: "no",
    norvège: "no",
    denmark: "dk",
    danemark: "dk",
    finland: "fi",
    finlande: "fi",
    "czech republic": "cz",
    czechia: "cz",
    tchequie: "cz",
    tchéquie: "cz",
    romania: "ro",
    roumanie: "ro",
    hungary: "hu",
    hongrie: "hu",
    greece: "gr",
    grece: "gr",
    grèce: "gr",
    turkey: "tr",
    turquie: "tr",
    "south africa": "za",
    "afrique du sud": "za",
    "united arab emirates": "ae",
    uae: "ae",
    "emirats arabes unis": "ae",
    "émirats arabes unis": "ae",
    israel: "il",
    israël: "il",
    argentina: "ar",
    argentine: "ar",
    chile: "cl",
    chili: "cl",
    colombia: "co",
    colombie: "co",
    peru: "pe",
    pérou: "pe",
    philippines: "ph",
    malaysia: "my",
    malaisie: "my",
    indonesia: "id",
    indonesie: "id",
    indonésie: "id",
    thailand: "th",
    thailande: "th",
    thaïlande: "th",
    vietnam: "vn",
    luxembourg: "lu",
    morocco: "ma",
    maroc: "ma",
    tunisia: "tn",
    tunisie: "tn",
    algeria: "dz",
    algerie: "dz",
    algérie: "dz",
    egypt: "eg",
    egypte: "eg",
    nigeria: "ng",
    kenya: "ke",
    pakistan: "pk",
    bangladesh: "bd",
    "saudi arabia": "sa",
    "arabie saoudite": "sa",
    qatar: "qa",
    kuwait: "kw",
    taiwan: "tw",
    taïwan: "tw",
    china: "cn",
    chine: "cn",
    russia: "ru",
    russie: "ru",
    ukraine: "ua",
  };

  /** City / region aliases → ISO (keys stored lowercase; lookup uses accent-stripped text). */
  const CITY_HINTS = {
    // Belgium
    bruxelles: "be",
    brussels: "be",
    brussel: "be",
    zaventem: "be",
    anvers: "be",
    antwerp: "be",
    antwerpen: "be",
    gand: "be",
    gent: "be",
    ghent: "be",
    liege: "be",
    luik: "be",
    charleroi: "be",
    bruges: "be",
    brugge: "be",
    namur: "be",
    louvain: "be",
    leuven: "be",
    mons: "be",
    mechelen: "be",
    flandre: "be",
    flanders: "be",
    wallonie: "be",
    wallonia: "be",
    // Poland
    poznan: "pl",
    warsaw: "pl",
    warszawa: "pl",
    varsovie: "pl",
    krakow: "pl",
    cracovie: "pl",
    cracow: "pl",
    wroclaw: "pl",
    gdansk: "pl",
    lodz: "pl",
    lublin: "pl",
    katowice: "pl",
    szczecin: "pl",
    // France
    paris: "fr",
    lyon: "fr",
    marseille: "fr",
    toulouse: "fr",
    nice: "fr",
    nantes: "fr",
    montpellier: "fr",
    strasbourg: "fr",
    bordeaux: "fr",
    lille: "fr",
    rennes: "fr",
    reims: "fr",
    toulon: "fr",
    grenoble: "fr",
    dijon: "fr",
    angers: "fr",
    "ile-de-france": "fr",
    "ile de france": "fr",
    "hauts-de-france": "fr",
    "auvergne-rhone-alpes": "fr",
    "pays de la loire": "fr",
    bretagne: "fr",
    normandie: "fr",
    occitanie: "fr",
    "grand est": "fr",
    // Netherlands
    amsterdam: "nl",
    rotterdam: "nl",
    "den haag": "nl",
    "the hague": "nl",
    utrecht: "nl",
    eindhoven: "nl",
    // Germany
    berlin: "de",
    munich: "de",
    munchen: "de",
    hamburg: "de",
    frankfurt: "de",
    cologne: "de",
    koln: "de",
    stuttgart: "de",
    dusseldorf: "de",
    dortmund: "de",
    leipzig: "de",
    // UK
    london: "uk",
    manchester: "uk",
    birmingham: "uk",
    leeds: "uk",
    glasgow: "uk",
    edinburgh: "uk",
    bristol: "uk",
    liverpool: "uk",
    cambridge: "uk",
    oxford: "uk",
    // Spain
    madrid: "es",
    barcelona: "es",
    valencia: "es",
    seville: "es",
    sevilla: "es",
    bilbao: "es",
    malaga: "es",
    // Italy
    rome: "it",
    roma: "it",
    milan: "it",
    milano: "it",
    turin: "it",
    torino: "it",
    naples: "it",
    napoli: "it",
    florence: "it",
    firenze: "it",
    bologna: "it",
    // Portugal
    lisbon: "pt",
    lisboa: "pt",
    lisbonne: "pt",
    porto: "pt",
    // Switzerland
    geneva: "ch",
    geneve: "ch",
    zurich: "ch",
    basel: "ch",
    berne: "ch",
    bern: "ch",
    lausanne: "ch",
    // Austria
    vienna: "at",
    wien: "at",
    vienne: "at",
    salzburg: "at",
    graz: "at",
    // Ireland
    dublin: "ie",
    cork: "ie",
    // Canada
    toronto: "ca",
    montreal: "ca",
    vancouver: "ca",
    ottawa: "ca",
    calgary: "ca",
    edmonton: "ca",
    quebec: "ca",
    // US
    "new york": "us",
    "los angeles": "us",
    "san francisco": "us",
    "san jose": "us",
    seattle: "us",
    chicago: "us",
    boston: "us",
    austin: "us",
    dallas: "us",
    houston: "us",
    miami: "us",
    atlanta: "us",
    denver: "us",
    phoenix: "us",
    "washington dc": "us",
    // Australia
    sydney: "au",
    melbourne: "au",
    brisbane: "au",
    perth: "au",
    adelaide: "au",
    // India
    bangalore: "in",
    bengaluru: "in",
    mumbai: "in",
    delhi: "in",
    hyderabad: "in",
    chennai: "in",
    pune: "in",
    // Brazil
    "sao paulo": "br",
    "rio de janeiro": "br",
    brasilia: "br",
    // Nordics / CEE
    stockholm: "se",
    oslo: "no",
    copenhagen: "dk",
    kobenhavn: "dk",
    helsinki: "fi",
    prague: "cz",
    praha: "cz",
    budapest: "hu",
    bucharest: "ro",
    bucuresti: "ro",
    // UAE / Asia
    dubai: "ae",
    "abu dhabi": "ae",
    singapore: "sg",
    tokyo: "jp",
    osaka: "jp",
    seoul: "kr",
    "hong kong": "hk",
  };

  const COUNTRY_NAME_KEYS = Object.keys(COUNTRY_NAMES).sort((a, b) => b.length - a.length);
  const CITY_KEYS = Object.keys(CITY_HINTS).sort((a, b) => b.length - a.length);

  const SUGGEST_LANG = {
    fr: "fr",
    be: "fr",
    de: "de",
    at: "de",
    ch: "fr",
    nl: "nl",
    es: "es",
    mx: "es",
    ar: "es",
    cl: "es",
    co: "es",
    pe: "es",
    it: "it",
    pt: "pt",
    br: "pt",
    pl: "pl",
    jp: "ja",
    kr: "ko",
    cn: "zh",
    tw: "zh",
    tr: "tr",
    ru: "ru",
    se: "sv",
    no: "no",
    dk: "da",
    fi: "fi",
    cz: "cs",
    hu: "hu",
    ro: "ro",
    gr: "el",
  };

  function stripAccents(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function normalizeText(s) {
    return stripAccents(String(s || "").toLowerCase())
      .replace(/[_/]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function canonicalizeCc(cc) {
    const c = String(cc || "").toLowerCase();
    if (c === "gb") return "uk";
    return c;
  }

  function indeedSuggestCountry(cc) {
    const c = canonicalizeCc(cc);
    if (c === "uk") return "GB";
    return (c || "FR").toUpperCase();
  }

  function suggestLanguage(cc) {
    return SUGGEST_LANG[canonicalizeCc(cc)] || "en";
  }

  function indeedOriginForCountry(cc) {
    const c = canonicalizeCc(cc) || "fr";
    if (INDEED_SPECIAL[c]) return INDEED_SPECIAL[c];
    if (/^[a-z]{2}$/.test(c)) return `https://${c}.indeed.com`;
    return "https://www.indeed.com";
  }

  function glassdoorOriginForCountry(cc) {
    const c = canonicalizeCc(cc) || "us";
    return GLASSDOOR_BY_CC[c] || "https://www.glassdoor.com";
  }

  function detectCountryCode(location, fallback = "fr") {
    const raw = String(location || "").trim();
    if (!raw) return canonicalizeCc(fallback);

    // Bare ISO or trailing ", XX"
    if (/^[A-Za-z]{2}$/.test(raw)) return canonicalizeCc(raw);
    const commaCc = raw.match(/,\s*([A-Za-z]{2})\s*$/);
    if (commaCc) return canonicalizeCc(commaCc[1]);

    const norm = normalizeText(raw);

    for (const name of COUNTRY_NAME_KEYS) {
      const n = normalizeText(name);
      if (!n) continue;
      if (norm === n || norm.endsWith(", " + n) || norm.endsWith("," + n) || norm.endsWith(" " + n)) {
        return COUNTRY_NAMES[name];
      }
      // Mid-string country (e.g. "Paris, France, Europe")
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?:^|[,\\s])${esc}(?:$|[,\\s])`).test(norm)) return COUNTRY_NAMES[name];
    }

    for (const city of CITY_KEYS) {
      const c = normalizeText(city);
      if (!c) continue;
      if (
        norm === c ||
        norm.startsWith(c + ",") ||
        norm.startsWith(c + " ") ||
        norm.includes(", " + c) ||
        norm.endsWith(" " + c)
      ) {
        return CITY_HINTS[city];
      }
      if (norm.split(/[,\s]/)[0] === c) return CITY_HINTS[city];
    }

    return canonicalizeCc(fallback);
  }

  function indeedOriginForLocation(location, fallbackCc = "fr") {
    return indeedOriginForCountry(detectCountryCode(location, fallbackCc));
  }

  function glassdoorOriginForLocation(location, fallbackCc = "fr") {
    return glassdoorOriginForCountry(detectCountryCode(location, fallbackCc));
  }

  function boardsForLocation(location, fallbackCc = "fr") {
    const country = detectCountryCode(location, fallbackCc);
    return {
      country,
      indeedOrigin: indeedOriginForCountry(country),
      glassdoorOrigin: glassdoorOriginForCountry(country),
      suggestCountry: indeedSuggestCountry(country),
      suggestLanguage: suggestLanguage(country),
    };
  }

  function isGlassdoorHostname(hostname) {
    const h = String(hostname || "")
      .toLowerCase()
      .replace(/^www\./, "");
    return /^glassdoor\./i.test(h);
  }

  function isIndeedHostname(hostname) {
    const h = String(hostname || "").toLowerCase();
    return (
      /(^|\.)indeed\.com$/i.test(h) ||
      /(^|\.)indeed\.[a-z]{2}$/i.test(h) ||
      /^smartapply\.indeed\.com$/i.test(h)
    );
  }

  root.AmiJobsGeo = {
    detectCountryCode,
    indeedOriginForCountry,
    glassdoorOriginForCountry,
    indeedOriginForLocation,
    glassdoorOriginForLocation,
    boardsForLocation,
    indeedSuggestCountry,
    suggestLanguage,
    isGlassdoorHostname,
    isIndeedHostname,
    normalizeText,
  };
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : window);
