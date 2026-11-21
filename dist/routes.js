// Exact first-party page routes shared by the browser and the local HTTP server.
export const CANONICAL_ORIGIN = 'https://assaynovalabs.com';
const OG_CARD_URL = `${CANONICAL_ORIGIN}/assets/assaynova-og-card.jpg`;

export const PAGE_ROUTES = Object.freeze([
  {
    path: '/',
    view: 'home-view',
    heading: 'hero-title',
    title: 'COA Analytical Testing Lab & Verification | AssayNova',
    description: 'Independent Certificate of Analysis (COA) lab serving the US & Puerto Rico. Submit samples for HPLC purity & LC-MS identity testing or verify a COA online.',
    breadcrumb: 'Home',
    noindex: false
  },
  {
    path: '/testing-methods',
    view: 'testing-view',
    heading: 'testing-page-title',
    title: 'HPLC Purity & LC-MS COA Testing Services | AssayNova',
    description: 'Reversed-phase HPLC-UV purity assays, LC-MS molecular identity confirmation, and combined COA panels (~1-week turnaround) across the US & Puerto Rico.',
    breadcrumb: 'Our Testing',
    noindex: false
  },
  {
    path: '/about',
    view: 'about-view',
    heading: 'about-title',
    title: 'About AssayNova | Independent Analytical & COA Lab',
    description: 'Learn how AssayNova pairs duplicate HPLC purity assays, LC-MS mass confirmation, and Lookup Code access to issue verifiable COAs across the US & PR.',
    breadcrumb: 'About AssayNova',
    noindex: false
  },
  {
    path: '/verify',
    view: 'verify-view',
    heading: 'verify-page-title',
    title: 'Verify a Certificate of Analysis (COA) Lookup | AssayNova',
    description: 'Verify any published AssayNova Certificate of Analysis (COA) online across the US & Puerto Rico. Enter your AN-XXXX-XXXX Lookup Code to check lab results.',
    breadcrumb: 'Verify a COA',
    noindex: false
  },
  {
    path: '/contact',
    view: 'contact-view',
    heading: 'contact-title',
    title: 'Contact AssayNova | Analytical Testing Quotes & COA Support',
    description: 'Contact AssayNova Client Services (Mon-Fri 9am-5pm ET / AST) for US & Puerto Rico COA testing quotes, domestic sample shipping, or Lookup Code support.',
    breadcrumb: 'Contact Us',
    noindex: false
  },
  {
    path: '/submit-sample',
    view: 'request-view',
    heading: 'request-page-title',
    title: 'Submit a Sample for HPLC & LC-MS COA Testing | AssayNova',
    description: 'Submit research samples from any US state or Puerto Rico for HPLC purity, LC-MS identity, or full Certificate of Analysis (COA) testing at AssayNova.',
    breadcrumb: 'Submit a Sample',
    noindex: false
  },
  {
    path: '/privacy-policy',
    view: 'privacy-policy-view',
    heading: 'privacy-policy-title',
    title: 'Privacy Policy & Cookie Storage | AssayNova',
    description: 'Read AssayNova’s privacy policy covering customer account records, optional Google sign-in, necessary session security cookies, and public COA lookup.',
    breadcrumb: 'Privacy Policy',
    noindex: false
  },
  {
    path: '/google-signin',
    view: 'google-signin-view',
    heading: 'google-signin-title',
    title: 'Google sign-in · AssayNova',
    description: 'Complete your requested Google sign-in or account security confirmation on AssayNova.',
    breadcrumb: 'Google Sign-In',
    noindex: true
  },
  {
    path: '/account',
    view: 'account-view',
    heading: 'account-title',
    title: 'My account · AssayNova',
    description: 'Manage analytical sample requests, contact enquiries, and report recovery requests in your AssayNova account.',
    breadcrumb: 'My Account',
    noindex: true
  },
  {
    path: '/login',
    view: 'login-view',
    heading: 'login-title',
    title: 'Sign in · AssayNova',
    description: 'Sign in to your AssayNova account to submit and manage analytical testing requests.',
    breadcrumb: 'Sign In',
    noindex: true
  },
  {
    path: '/register',
    view: 'register-view',
    heading: 'register-title',
    title: 'Create account · AssayNova',
    description: 'Create an AssayNova account to prepare sample testing requests and track laboratory submissions.',
    breadcrumb: 'Create Account',
    noindex: true
  },
  {
    path: '/verify-email',
    view: 'verify-email-view',
    heading: 'verify-email-title',
    title: 'Verify email · AssayNova',
    description: 'Confirm your email address for your AssayNova customer account.',
    breadcrumb: 'Verify Email',
    noindex: true
  },
  {
    path: '/reset-password',
    view: 'reset-password-view',
    heading: 'reset-password-title',
    title: 'Reset password · AssayNova',
    description: 'Reset the password for your AssayNova customer account.',
    breadcrumb: 'Reset Password',
    noindex: true
  },
  {
    path: '/recover-account',
    view: 'recover-account-view',
    heading: 'recover-account-title',
    title: 'Account recovery · AssayNova',
    description: 'Recover access to your AssayNova customer account.',
    breadcrumb: 'Account Recovery',
    noindex: true
  }
].map(Object.freeze));

export function resolvePageRoute(pathname) {
  // Do not decode paths: encoded separators/aliases are not page rewrites.
  if (typeof pathname !== 'string' || !/^\/(?:[a-z-]+\/?)?$/.test(pathname)) return null;
  const path = pathname === '/' ? '/' : pathname.replace(/\/$/, '');
  return PAGE_ROUTES.find((route) => route.path === path) || null;
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

function safeJSONScript(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

const SERVICE_AREAS = Object.freeze([
  {
    '@type': 'Country',
    name: 'United States',
    identifier: 'US',
    sameAs: 'https://www.wikidata.org/wiki/Q30'
  },
  {
    '@type': 'AdministrativeArea',
    name: 'Puerto Rico',
    identifier: 'PR',
    sameAs: 'https://www.wikidata.org/wiki/Q1183'
  }
]);

function baseOrganizationGraph() {
  return [
    {
      '@type': 'Organization',
      '@id': `${CANONICAL_ORIGIN}/#organization`,
      name: 'AssayNova',
      alternateName: 'AssayNova Labs',
      url: `${CANONICAL_ORIGIN}/`,
      slogan: 'Precision in testing. Clarity in every result.',
      description: 'Independent analytical testing laboratory platform serving the United States and Puerto Rico with reversed-phase HPLC purity analysis, LC-MS molecular identity confirmation, combined analytical panels, and Lookup Code verification for published Certificates of Analysis (COA).',
      email: 'supports@assaynovalabs.com',
      areaServed: SERVICE_AREAS,
      knowsAbout: [
        'Certificate of Analysis (COA)',
        'High-Performance Liquid Chromatography (HPLC)',
        'Liquid Chromatography-Mass Spectrometry (LC-MS)',
        'Peptide Purity and Identity Analysis',
        'Analytical Chemistry Quality Control'
      ],
      logo: {
        '@type': 'ImageObject',
        '@id': `${CANONICAL_ORIGIN}/#logo`,
        url: `${CANONICAL_ORIGIN}/assets/assaynova-logo.png`,
        contentUrl: `${CANONICAL_ORIGIN}/assets/assaynova-logo.png`,
        width: 2172,
        height: 724,
        caption: 'AssayNova'
      },
      image: {
        '@type': 'ImageObject',
        '@id': `${CANONICAL_ORIGIN}/#icon`,
        url: `${CANONICAL_ORIGIN}/assets/assaynova-icon.png`,
        contentUrl: `${CANONICAL_ORIGIN}/assets/assaynova-icon.png`,
        width: 1254,
        height: 1254,
        caption: 'AssayNova'
      },
      contactPoint: [
        {
          '@type': 'ContactPoint',
          contactType: 'customer support',
          name: 'Nova Support & Client Services',
          email: 'supports@assaynovalabs.com',
          url: `${CANONICAL_ORIGIN}/contact`,
          areaServed: ['US', 'PR'],
          availableLanguage: ['en'],
          hoursAvailable: {
            '@type': 'OpeningHoursSpecification',
            dayOfWeek: [
              'https://schema.org/Monday',
              'https://schema.org/Tuesday',
              'https://schema.org/Wednesday',
              'https://schema.org/Thursday',
              'https://schema.org/Friday'
            ],
            opens: '09:00',
            closes: '17:00'
          }
        }
      ]
    },
    {
      '@type': 'WebSite',
      '@id': `${CANONICAL_ORIGIN}/#website`,
      url: `${CANONICAL_ORIGIN}/`,
      name: 'AssayNova',
      alternateName: 'AssayNova Labs',
      inLanguage: 'en',
      publisher: { '@id': `${CANONICAL_ORIGIN}/#organization` }
    }
  ];
}

function serviceOfferCatalog() {
  return {
    '@type': 'OfferCatalog',
    '@id': `${CANONICAL_ORIGIN}/testing-methods#catalog`,
    name: 'AssayNova Analytical Testing Services',
    itemListElement: [
      {
        '@type': 'Offer',
        itemOffered: {
          '@type': 'Service',
          '@id': `${CANONICAL_ORIGIN}/testing-methods#method-purity`,
          name: 'HPLC Purity Analysis',
          serviceType: 'High-Performance Liquid Chromatography (RP-HPLC-UV) Purity & Content Analysis',
          description: 'Reversed-phase HPLC separation measuring relative chromatographic peak-area purity and duplicate analyte content determinations with ~1-week typical turnaround across the US and Puerto Rico.',
          areaServed: SERVICE_AREAS,
          provider: { '@id': `${CANONICAL_ORIGIN}/#organization` },
          url: `${CANONICAL_ORIGIN}/testing-methods#method-purity`
        }
      },
      {
        '@type': 'Offer',
        itemOffered: {
          '@type': 'Service',
          '@id': `${CANONICAL_ORIGIN}/testing-methods#method-identity`,
          name: 'LC-MS Identity Confirmation',
          serviceType: 'Liquid Chromatography-Mass Spectrometry (LC-MS) Identity Confirmation',
          description: 'Electrospray ionization LC-MS combining chromatographic separation with monoisotopic mass and charge-state isotope assessment to confirm analyte identity across the US and Puerto Rico.',
          areaServed: SERVICE_AREAS,
          provider: { '@id': `${CANONICAL_ORIGIN}/#organization` },
          url: `${CANONICAL_ORIGIN}/testing-methods#method-identity`
        }
      },
      {
        '@type': 'Offer',
        itemOffered: {
          '@type': 'Service',
          '@id': `${CANONICAL_ORIGIN}/testing-methods#method-comprehensive`,
          name: 'Comprehensive Analytical COA Panel',
          serviceType: 'Combined HPLC Purity + LC-MS Identity Certificate of Analysis Panel',
          description: 'Combined HPLC-UV purity analysis and LC-MS molecular identity confirmation reported on a published Certificate of Analysis (COA) verifiable via Lookup Code across the US and Puerto Rico.',
          areaServed: SERVICE_AREAS,
          provider: { '@id': `${CANONICAL_ORIGIN}/#organization` },
          url: `${CANONICAL_ORIGIN}/testing-methods#method-comprehensive`
        }
      }
    ]
  };
}

function buildStructuredData({ pageRoute, coaRoute, generatedReport }) {
  if (coaRoute) {
    if (!generatedReport) return null;
    const code = generatedReport.report.lookupCode;
    const pageUrl = `${CANONICAL_ORIGIN}/coa/${code}`;
    return {
      '@context': 'https://schema.org',
      '@graph': [
        ...baseOrganizationGraph(),
        {
          '@type': 'BreadcrumbList',
          '@id': `${pageUrl}#breadcrumb`,
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: `${CANONICAL_ORIGIN}/` },
            { '@type': 'ListItem', position: 2, name: 'Verify a COA', item: `${CANONICAL_ORIGIN}/verify` },
            { '@type': 'ListItem', position: 3, name: `COA ${code}`, item: pageUrl }
          ]
        },
        {
          '@type': 'WebPage',
          '@id': `${pageUrl}#webpage`,
          url: pageUrl,
          name: `Verified COA ${code} — ${generatedReport.label} | AssayNova`,
          isPartOf: { '@id': `${CANONICAL_ORIGIN}/#website` },
          breadcrumb: { '@id': `${pageUrl}#breadcrumb` },
          inLanguage: 'en',
          mainEntity: {
            '@type': 'DigitalDocument',
            '@id': `${pageUrl}#coa`,
            name: `Certificate of Analysis — ${generatedReport.label} (${code})`,
            identifier: code,
            encodingFormat: 'application/pdf',
            url: `${pageUrl}/report.pdf`,
            publisher: { '@id': `${CANONICAL_ORIGIN}/#organization` },
            ...(generatedReport.report.issued ? { datePublished: String(generatedReport.report.issued) } : {})
          }
        }
      ]
    };
  }

  if (!pageRoute || pageRoute.noindex) return null;

  const canonicalUrl = pageRoute.path === '/' ? `${CANONICAL_ORIGIN}/` : `${CANONICAL_ORIGIN}${pageRoute.path}`;
  const graph = [...baseOrganizationGraph()];

  if (pageRoute.path !== '/') {
    graph.push({
      '@type': 'BreadcrumbList',
      '@id': `${canonicalUrl}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${CANONICAL_ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: pageRoute.breadcrumb || pageRoute.title, item: canonicalUrl }
      ]
    });
  }

  const webPage = {
    '@type': pageRoute.path === '/about' ? 'AboutPage' : pageRoute.path === '/contact' ? 'ContactPage' : 'WebPage',
    '@id': `${canonicalUrl}#webpage`,
    url: canonicalUrl,
    name: pageRoute.title,
    description: pageRoute.description,
    isPartOf: { '@id': `${CANONICAL_ORIGIN}/#website` },
    about: { '@id': `${CANONICAL_ORIGIN}/#organization` },
    inLanguage: 'en',
    primaryImageOfPage: {
      '@type': 'ImageObject',
      url: OG_CARD_URL,
      width: 1200,
      height: 630
    }
  };

  if (pageRoute.path !== '/') {
    webPage.breadcrumb = { '@id': `${canonicalUrl}#breadcrumb` };
  }
  if (pageRoute.path === '/verify') {
    webPage.potentialAction = {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${CANONICAL_ORIGIN}/coa/{lookup_code}`
      },
      'query-input': 'required name=lookup_code'
    };
  }

  graph.push(webPage);

  if (pageRoute.path === '/' || pageRoute.path === '/testing-methods') {
    graph.push(serviceOfferCatalog());
  }

  return { '@context': 'https://schema.org', '@graph': graph };
}

function renderServerCOASummary(generatedReport) {
  const { report, record, label } = generatedReport;
  const code = escapeHTML(report.lookupCode);
  const safeLabel = escapeHTML(label);
  const meanPurity = Array.isArray(record?.purity) && record.purity[2] !== undefined ? `${escapeHTML(record.purity[2])}%` : 'Published';
  const identity = escapeHTML(record?.identity ?? report?.identityOutcome ?? 'Assessed');
  const reported = escapeHTML(record?.reported ?? report?.issued ?? '');
  const method = escapeHTML(record?.method ?? report?.method ?? 'HPLC-UV / LC-MS');
  return `<div class="coa-navigation"><a class="text-button" href="/" data-action="home">← Back to AssayNova</a><span>COA report</span></div><article class="coa-card coa-master-card" aria-labelledby="report-title"><header class="coa-master-heading"><div><h1 id="report-title" tabindex="-1">${safeLabel}</h1></div><p class="coa-code">Lookup Code <strong>${code}</strong></p></header><div class="coa-ssr-summary" style="padding:24px 32px"><p><strong>Verified AssayNova Certificate of Analysis</strong> · Mean HPLC-UV Purity: <strong>${meanPurity}</strong> · Identity Assessment: <strong>${identity}</strong>${reported ? ` · Reported: <strong>${reported}</strong>` : ''}.</p><p style="margin-top:10px;color:#506a70">Method: ${method}. Enable JavaScript to inspect interactive chromatograms, mass spectra, and replicate tables, or download the official signed PDF directly.</p><div class="report-actions coa-master-tools"><a class="button button-dark" href="/coa/${code}/report.pdf" download>Download PDF</a><a class="button button-outline" href="/verify">Verify another COA</a></div></div></article>`;
}

export function injectRouteSEO(rawHtml, { pageRoute, coaRoute, generatedReport, liveReload = false } = {}) {
  let html = rawHtml;
  const activeRoute = pageRoute || PAGE_ROUTES[0];
  const activeViewId = coaRoute ? 'coa-view' : activeRoute.view;

  let title = activeRoute.title;
  let description = activeRoute.description;
  let canonicalUrl = `${CANONICAL_ORIGIN}${activeRoute.path === '/' ? '/' : activeRoute.path}`;
  let robotsMeta = activeRoute.noindex ? 'noindex, nofollow' : 'index, follow';

  if (coaRoute) {
    if (generatedReport) {
      const code = generatedReport.report.lookupCode;
      const meanPurity = Array.isArray(generatedReport.record?.purity) && generatedReport.record.purity[2] !== undefined
        ? ` (${generatedReport.record.purity[2]}% HPLC Purity)`
        : '';
      title = `Verified COA ${code} · ${generatedReport.label} | AssayNova`;
      description = `Published AssayNova Certificate of Analysis for ${generatedReport.label}${meanPurity}. Lookup Code ${code}.`;
      canonicalUrl = `${CANONICAL_ORIGIN}/coa/${code}`;
      robotsMeta = 'noindex, noarchive';
    } else {
      title = 'COA Not Found | AssayNova';
      description = 'This Lookup Code does not match a published AssayNova Certificate of Analysis. Enter a valid AN-XXXX-XXXX Lookup Code at AssayNova.';
      canonicalUrl = '';
      robotsMeta = 'noindex, nofollow';
    }
  } else if (activeRoute.noindex) {
    canonicalUrl = '';
  }

  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHTML(title)}</title>`);
  html = html.replace(
    /<meta\s+name="description"\s+content="[^"]*">/i,
    `<meta name="description" content="${escapeHTML(description)}">`
  );

  const headParts = [
    `<meta name="robots" content="${escapeHTML(robotsMeta)}">`
  ];

  if (canonicalUrl) {
    headParts.push(`<link rel="canonical" href="${escapeHTML(canonicalUrl)}">`);
    if (!coaRoute && !activeRoute.noindex) {
      headParts.push(
        `<link rel="alternate" hreflang="en-US" href="${escapeHTML(canonicalUrl)}">`,
        `<link rel="alternate" hreflang="en-PR" href="${escapeHTML(canonicalUrl)}">`,
        `<link rel="alternate" hreflang="x-default" href="${escapeHTML(canonicalUrl)}">`
      );
    }
  }

  if (!coaRoute && activeRoute.path === '/') {
    headParts.push(
      '<link rel="preload" as="image" type="image/webp" href="/assets/assaynova-lab-hero.webp" imagesrcset="/assets/assaynova-lab-hero-800.webp 800w, /assets/assaynova-lab-hero.webp 1935w" imagesizes="100vw" fetchpriority="high">'
    );
  }

  const ogUrl = canonicalUrl || `${CANONICAL_ORIGIN}/`;
  headParts.push(
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="AssayNova">',
    '<meta property="og:locale" content="en_US">',
    `<meta property="og:url" content="${escapeHTML(ogUrl)}">`,
    `<meta property="og:title" content="${escapeHTML(title)}">`,
    `<meta property="og:description" content="${escapeHTML(description)}">`,
    `<meta property="og:image" content="${OG_CARD_URL}">`,
    '<meta property="og:image:type" content="image/jpeg">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="AssayNova Analytical Testing Laboratory — HPLC Purity, LC-MS Identity & Verifiable Certificates of Analysis">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escapeHTML(title)}">`,
    `<meta name="twitter:description" content="${escapeHTML(description)}">`,
    `<meta name="twitter:image" content="${OG_CARD_URL}">`,
    '<meta name="twitter:image:alt" content="AssayNova Analytical Testing Laboratory — HPLC Purity, LC-MS Identity & Verifiable Certificates of Analysis">'
  );

  const schemaGraph = buildStructuredData({ pageRoute: activeRoute, coaRoute, generatedReport });
  if (schemaGraph) {
    headParts.push(`<script type="application/ld+json">${safeJSONScript(schemaGraph)}</script>`);
  }

  if (activeViewId !== 'home-view') {
    html = html.replace(
      /<section id="home-view" aria-labelledby="hero-title">/,
      '<section id="home-view" aria-labelledby="hero-title" hidden>'
    );
    html = html.replace(
      new RegExp(`(<section\\b[^>]*\\bid="${activeViewId}"[^>]*?)\\s+hidden>`),
      '$1>'
    );
  }

  if (coaRoute && generatedReport) {
    html = html.replace(
      /<section id="coa-view"([^>]*)><\/section>/,
      `<section id="coa-view"$1>${renderServerCOASummary(generatedReport)}</section>`
    );
  }

  if (!liveReload) {
    const deferred = {};
    for (const route of PAGE_ROUTES) {
      if (route.view === activeViewId) continue;
      const marker = `<section id="${route.view}"`;
      const startIdx = html.indexOf(marker);
      if (startIdx === -1) continue;
      const openEnd = html.indexOf('>', startIdx);
      if (openEnd === -1) continue;
      let depth = 1;
      let cursor = openEnd + 1;
      let closeStart = -1;
      while (depth > 0 && cursor < html.length) {
        const nextOpen = html.indexOf('<section', cursor);
        const nextClose = html.indexOf('</section>', cursor);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth++;
          cursor = nextOpen + 8;
        } else {
          depth--;
          if (depth === 0) {
            closeStart = nextClose;
            break;
          }
          cursor = nextClose + 10;
        }
      }
      if (closeStart > openEnd) {
        const inner = html.slice(openEnd + 1, closeStart);
        if (inner.trim()) {
          deferred[route.view] = inner;
          html = html.slice(0, openEnd + 1) + html.slice(closeStart);
        }
      }
    }
    if (Object.keys(deferred).length > 0) {
      html = html.replace(
        /<\/main>/i,
        `</main>\n  <script type="application/json" id="an-deferred-views">${safeJSONScript(deferred)}</script>`
      );
    }
  }

  html = html.replace(/<\/head>/i, `  ${headParts.join('\n  ')}\n</head>`);
  return html;
}
