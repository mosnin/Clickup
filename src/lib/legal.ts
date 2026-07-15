// Legal document library. Each entry renders as a sober, prose-first page
// under /legal/[slug] (index at /legal). Content is written as structured
// sections so the renderer stays declarative and every page shares one
// typographic treatment — no decorative icons, no chrome.
//
// These are comprehensive *templates*. They describe how the platform is
// actually built (agent principals, MCP access, x402 agent payments, SOC2
// admin controls, Convex/Clerk/Resend/OpenAI subprocessors) but must be
// reviewed by qualified counsel before you rely on them in production. The
// LEGAL_DISCLAIMER banner says exactly this on every page.

import { SITE_NAME } from "@/lib/marketing-nav";

export const LEGAL_UPDATED = "July 15, 2026";
export const LEGAL_ENTITY = `${SITE_NAME}, Inc.`;
export const LEGAL_CONTACT = "legal@clickup-clone.app";
export const PRIVACY_CONTACT = "privacy@clickup-clone.app";
export const SECURITY_CONTACT = "security@clickup-clone.app";

export const LEGAL_DISCLAIMER =
  "This document is a template that reflects how the product works today. It is not legal advice. Have qualified counsel review and adapt it before relying on it in production.";

export type LegalSection = {
  heading: string;
  body: string[];
  // Optional bullet list rendered after the paragraphs.
  bullets?: string[];
};

export type LegalDoc = {
  slug: string;
  title: string;
  // One-line summary used on the index and in metadata.
  summary: string;
  // Short label for the footer/index (e.g. "Terms").
  short: string;
  intro: string[];
  sections: LegalSection[];
};

// ── Terms of Service ──────────────────────────────────────────────────────
const TERMS: LegalDoc = {
  slug: "terms",
  title: "Terms of Service",
  short: "Terms",
  summary:
    "The agreement that governs your use of the platform, for both human members and the AI agents acting on your behalf.",
  intro: [
    `These Terms of Service ("Terms") are a binding agreement between you and ${LEGAL_ENTITY} ("we", "us", "the platform") and govern your access to and use of our websites, applications, hosted Model Context Protocol (MCP) endpoint, APIs, and related services (together, the "Service").`,
    `By creating an account, connecting an agent, or otherwise using the Service, you agree to these Terms. If you are using the Service on behalf of an organization, you represent that you are authorized to bind that organization, and "you" refers to that organization.`,
  ],
  sections: [
    {
      heading: "1. Accounts and eligibility",
      body: [
        "You must be at least 16 years old, or the age of digital consent in your jurisdiction, to use the Service. You are responsible for the accuracy of the information you provide and for all activity under your account.",
        "Authentication is provided through our identity provider. You are responsible for safeguarding your credentials and for any session initiated with them. Notify us promptly of any unauthorized access.",
      ],
    },
    {
      heading: "2. AI agents acting on your behalf",
      body: [
        "The Service lets you create first-class AI agent principals and issue them API keys. An agent authenticated with your key acts as your authorized representative. You are responsible for everything an agent does under a key you issued, exactly as if you had taken the action yourself.",
        "You control each agent's authority through the governance controls we provide — roles, list restrictions, per-day action budgets, spending limits, and human approval gates. You are responsible for configuring these controls appropriately for the autonomy you grant.",
        "You must not issue keys to agents you do not control, and you must revoke keys that are lost, leaked, or no longer needed. We may rate-limit, suspend, or revoke agent access that threatens the integrity, security, or availability of the Service.",
      ],
    },
    {
      heading: "3. Acceptable use",
      body: [
        "Your use of the Service — by humans and agents alike — is subject to our Acceptable Use Policy, which is incorporated into these Terms by reference. In short, you may not use the Service to break the law, harm others, compromise security, or circumvent the controls that keep the platform safe for everyone.",
      ],
    },
    {
      heading: "4. Fees, credits, and agent payments (x402)",
      body: [
        "Paid features are billed as described at the point of purchase. Where you enable metered agent usage, agents may pay for platform usage autonomously using the x402 protocol: the Service returns an HTTP 402 challenge describing the amount owed, the agent settles it through a payment facilitator, and the corresponding credits are added to your workspace balance.",
        "Credits purchased through x402 or otherwise are prepaid, are consumed as priced at the time of each metered action, and are non-refundable except where required by law. On-chain settlement is final; we cannot reverse a settled payment. You are responsible for funding the wallet an agent uses and for the actions those credits pay for.",
        "We may change pricing prospectively. Price changes do not affect credits already purchased. Taxes, network fees, and facilitator fees are your responsibility unless stated otherwise.",
      ],
    },
    {
      heading: "5. Your content",
      body: [
        "You retain all rights to the tasks, documents, messages, files, and other content you and your agents submit to the Service (\"Your Content\"). You grant us a limited license to host, process, transmit, display, and back up Your Content solely to operate and improve the Service for you.",
        "You are responsible for Your Content and for having the rights necessary to submit it. We do not claim ownership of Your Content and do not use it to train third-party foundation models. Where AI features process Your Content (for example, semantic search embeddings), that processing is described in our Privacy Policy.",
      ],
    },
    {
      heading: "6. Intellectual property",
      body: [
        "The Service, including its software, design, and documentation, is owned by us and our licensors and is protected by intellectual-property laws. We grant you a limited, non-exclusive, non-transferable, revocable license to use the Service in accordance with these Terms. All rights not expressly granted are reserved.",
      ],
    },
    {
      heading: "7. Third-party services",
      body: [
        "The Service integrates with third parties you choose to connect (for example, outbound webhooks, chat integrations, and payment facilitators). Your use of a third-party service is governed by that provider's terms, and we are not responsible for third-party services. Our subprocessors — the vendors we rely on to run the Service — are listed on our Subprocessors page.",
      ],
    },
    {
      heading: "8. Availability and changes",
      body: [
        "We work to keep the Service available but do not guarantee uninterrupted access. We may add, change, or remove features, and we may suspend the Service for maintenance. We will use commercially reasonable efforts to give notice of material adverse changes.",
      ],
    },
    {
      heading: "9. Suspension and termination",
      body: [
        "You may stop using the Service at any time. We may suspend or terminate your access if you materially breach these Terms, if required by law, or if your use poses a security or integrity risk to the platform or other customers. Where practical and lawful, we will give notice and an opportunity to cure.",
        "On termination, your license to use the Service ends. We will make Your Content available for export for a limited period and then delete it in accordance with our data-retention practices, except where retention is required by law.",
      ],
    },
    {
      heading: "10. Disclaimers",
      body: [
        'The Service is provided "as is" and "as available" without warranties of any kind, whether express, implied, or statutory, including any implied warranties of merchantability, fitness for a particular purpose, and non-infringement, to the maximum extent permitted by law.',
        "AI agents and AI-assisted features can produce inaccurate or unexpected output. You are responsible for reviewing agent actions and for the human approval gates you configure. We do not warrant that agent output is accurate, complete, or fit for any particular purpose.",
      ],
    },
    {
      heading: "11. Limitation of liability",
      body: [
        "To the maximum extent permitted by law, neither party will be liable for indirect, incidental, special, consequential, or exemplary damages, or for lost profits, revenues, or data. Our aggregate liability arising out of or relating to the Service will not exceed the amounts you paid us for the Service in the twelve months before the event giving rise to the claim.",
      ],
    },
    {
      heading: "12. Indemnification",
      body: [
        "You will defend and indemnify us against third-party claims arising from Your Content, your use of the Service, your agents' actions, or your breach of these Terms, to the extent permitted by law.",
      ],
    },
    {
      heading: "13. Governing law and disputes",
      body: [
        "These Terms are governed by the laws of the jurisdiction in which we are established, without regard to conflict-of-laws rules. The courts of that jurisdiction have exclusive jurisdiction over disputes, unless applicable law provides otherwise.",
      ],
    },
    {
      heading: "14. Changes to these Terms",
      body: [
        "We may update these Terms from time to time. When we make material changes, we will update the effective date above and, where appropriate, notify you. Your continued use of the Service after changes take effect constitutes acceptance.",
      ],
    },
    {
      heading: "15. Contact",
      body: [
        `Questions about these Terms can be sent to ${LEGAL_CONTACT}.`,
      ],
    },
  ],
};

// ── Privacy Policy ────────────────────────────────────────────────────────
const PRIVACY: LegalDoc = {
  slug: "privacy",
  title: "Privacy Policy",
  short: "Privacy",
  summary:
    "What personal data we collect, why we process it, who we share it with, and the rights you have over it.",
  intro: [
    `This Privacy Policy explains how ${LEGAL_ENTITY} collects, uses, discloses, and protects personal data when you use the Service. It applies to human members and to the account data associated with the AI agents you operate.`,
    "We act as a data controller for account and billing data, and as a data processor for the content you and your agents submit. Where we process content on your behalf, our Data Processing Addendum governs that processing.",
  ],
  sections: [
    {
      heading: "1. Data we collect",
      body: ["We collect the following categories of personal data:"],
      bullets: [
        "Account data: your name, email address, profile image, and organization membership, mirrored from our identity provider.",
        "Content data: the tasks, documents, comments, messages, files, and whiteboards you and your agents create.",
        "Agent data: agent names, configuration, hashed API keys, presence and activity events, and structured run records.",
        "Payment data: workspace credit balances, x402 payment records (amount, asset, network, settlement transaction reference), and pricing. We do not store private keys or seed phrases.",
        "Usage and device data: log data, IP address, approximate location, and diagnostic information needed to operate and secure the Service.",
      ],
    },
    {
      heading: "2. How we use data",
      body: ["We process personal data to:"],
      bullets: [
        "Provide, maintain, and secure the Service and authenticate members and agents.",
        "Meter and bill usage, including reconciling x402 payments to workspace credits.",
        "Power AI-assisted features you enable, such as semantic search over your tasks and documents.",
        "Send transactional notifications (mentions, assignments, approvals) and, where permitted, service updates.",
        "Detect, investigate, and prevent abuse, security incidents, and violations of our Acceptable Use Policy.",
        "Comply with legal obligations and enforce our agreements.",
      ],
    },
    {
      heading: "3. Legal bases",
      body: [
        "Where the GDPR or similar laws apply, we rely on the following bases: performance of our contract with you; our legitimate interests in operating and securing the Service; your consent where required (for example, certain cookies); and compliance with legal obligations.",
      ],
    },
    {
      heading: "4. AI processing",
      body: [
        "When you use AI features, relevant content may be sent to our AI subprocessor to generate embeddings or completions. Embeddings are scoped to your personal space or workspace so vector search cannot cross a visibility boundary. We do not permit our AI subprocessor to use Your Content to train its foundation models. If you do not configure an AI provider key, AI features are disabled rather than degraded.",
      ],
    },
    {
      heading: "5. Sharing and subprocessors",
      body: [
        "We share personal data with the subprocessors that help us run the Service — our infrastructure, authentication, email, AI, and payment-facilitation providers — under contracts that require appropriate safeguards. The current list is maintained on our Subprocessors page. We also share data when required by law or to protect rights, safety, and the integrity of the Service. We do not sell personal data.",
      ],
    },
    {
      heading: "6. Payments and blockchain data",
      body: [
        "x402 agent payments settle on public blockchains. Transaction references, amounts, and wallet addresses recorded on-chain are inherently public and cannot be deleted from the underlying network. We store only the payment metadata needed to reconcile credits and to meet accounting and anti-abuse obligations; we never store the private keys agents use to sign payments.",
      ],
    },
    {
      heading: "7. Retention",
      body: [
        "We retain account data for as long as your account is active and for a limited period afterward. Operational records are retained on a rolling basis — for example, activity events for 90 days, webhook deliveries for 30 days, and usage counters for 14 days — after which they are pruned. Payment records are retained as long as required for accounting and legal compliance. You can export or delete workspace content as described below.",
      ],
    },
    {
      heading: "8. Your rights",
      body: [
        "Depending on where you live, you may have the right to access, correct, delete, port, or restrict the processing of your personal data, and to object to certain processing. You can exercise many of these rights directly in the product (for example, workspace data export and content deletion) or by contacting us. We will respond within the timeframes required by law.",
      ],
    },
    {
      heading: "9. International transfers",
      body: [
        "We may process data in countries other than yours. Where we transfer personal data internationally, we rely on appropriate safeguards such as standard contractual clauses.",
      ],
    },
    {
      heading: "10. Security",
      body: [
        "We use administrative, technical, and organizational measures to protect personal data, described further on our Security page. No system is perfectly secure, and we cannot guarantee absolute security.",
      ],
    },
    {
      heading: "11. Children",
      body: [
        "The Service is not directed to children under the age of digital consent, and we do not knowingly collect their personal data.",
      ],
    },
    {
      heading: "12. Changes and contact",
      body: [
        `We may update this Policy and will revise the effective date above. Privacy questions and rights requests can be sent to ${PRIVACY_CONTACT}.`,
      ],
    },
  ],
};

// ── Acceptable Use Policy ─────────────────────────────────────────────────
const ACCEPTABLE_USE: LegalDoc = {
  slug: "acceptable-use",
  title: "Acceptable Use Policy",
  short: "Acceptable use",
  summary:
    "The rules every human member and every AI agent must follow when using the platform.",
  intro: [
    "This Acceptable Use Policy (\"AUP\") applies to everyone who uses the Service, including the AI agents you operate. It is incorporated into our Terms of Service. You are responsible for ensuring that your members and agents comply.",
  ],
  sections: [
    {
      heading: "1. Prohibited activities",
      body: ["You and your agents must not:"],
      bullets: [
        "Violate any law or regulation, or infringe anyone's intellectual-property or privacy rights.",
        "Upload malware, or attempt to gain unauthorized access to the Service, other accounts, or connected systems.",
        "Probe, scan, or test the vulnerability of the Service without our prior written consent, or defeat rate limits, budgets, or approval gates.",
        "Use the Service to send spam, phish, or harass, or to generate content that is unlawful, defamatory, or abusive.",
        "Interfere with or disrupt the integrity or performance of the Service, including via denial-of-service or excessive automated traffic.",
        "Misrepresent an agent's identity or authority, or issue agent keys to systems you do not control.",
      ],
    },
    {
      heading: "2. Agent-specific rules",
      body: [
        "Agents must respect the collaboration primitives the platform provides — claims, blockers, checklists, and approval gates — and must not act outside the roles, list restrictions, and budgets configured for them. Agents must not attempt to escalate their own privileges, lower an approval gate they did not raise, or exceed their spending limits.",
        "Agents that repeatedly error, stall while holding work, or generate abusive traffic may be throttled or suspended automatically by our watchdog systems.",
      ],
    },
    {
      heading: "3. Payment integrity",
      body: [
        "You must not attempt to defraud the x402 payment flow — for example, by replaying payment authorizations, spoofing settlement, or manipulating credit balances. Metered actions consume credits as priced; circumventing metering is a violation of this AUP.",
      ],
    },
    {
      heading: "4. Enforcement",
      body: [
        "We may investigate suspected violations and may remove content, throttle or suspend agents, suspend accounts, or terminate access. Serious violations may be reported to the appropriate authorities. We aim to act proportionately and, where practical, to give notice.",
      ],
    },
    {
      heading: "5. Reporting",
      body: [
        `Report abuse or suspected violations to ${SECURITY_CONTACT}.`,
      ],
    },
  ],
};

// ── Cookie Policy ─────────────────────────────────────────────────────────
const COOKIES: LegalDoc = {
  slug: "cookies",
  title: "Cookie Policy",
  short: "Cookies",
  summary:
    "The cookies and similar technologies we use, why we use them, and how to control them.",
  intro: [
    "This Cookie Policy explains how the Service uses cookies and similar technologies such as local storage. It should be read alongside our Privacy Policy.",
  ],
  sections: [
    {
      heading: "1. What we use",
      body: [
        "We keep our use of cookies deliberately minimal. We rely primarily on strictly necessary technologies to run the Service.",
      ],
      bullets: [
        "Strictly necessary: authentication and session cookies set by our identity provider, and security cookies that protect against cross-site request forgery.",
        "Preferences: local storage that remembers interface choices such as whether the sidebar is collapsed. This never leaves your browser.",
        "Diagnostics: minimal logging needed to keep the Service secure and available.",
      ],
    },
    {
      heading: "2. What we don't use",
      body: [
        "We do not use third-party advertising cookies, and we do not sell data collected through cookies. We do not load fonts or trackers from third-party content-delivery networks in the application.",
      ],
    },
    {
      heading: "3. Managing cookies",
      body: [
        "You can control cookies through your browser settings. Blocking strictly necessary cookies may prevent you from signing in or using core features. Clearing local storage will reset interface preferences.",
      ],
    },
    {
      heading: "4. Changes",
      body: [
        `We may update this Policy as our use of these technologies changes. Questions can be sent to ${PRIVACY_CONTACT}.`,
      ],
    },
  ],
};

// ── Subprocessors ─────────────────────────────────────────────────────────
const SUBPROCESSORS: LegalDoc = {
  slug: "subprocessors",
  title: "Subprocessors",
  short: "Subprocessors",
  summary:
    "The third-party vendors we use to run the Service, and what each of them processes.",
  intro: [
    "We use a small set of trusted subprocessors to operate the Service. Each is bound by contractual data-protection obligations. We will update this page before adding a new subprocessor that processes customer personal data.",
  ],
  sections: [
    {
      heading: "Infrastructure and application hosting",
      body: [
        "Application hosting and serverless compute for the marketing site, dashboard, and hosted MCP endpoint. Processes account, content, and usage data in transit and at rest.",
      ],
    },
    {
      heading: "Realtime backend and database",
      body: [
        "Our reactive database and function runtime host tasks, documents, agents, events, and payment records. This is where the bulk of customer content lives, encrypted at rest.",
      ],
    },
    {
      heading: "Authentication and identity",
      body: [
        "Our identity provider handles sign-in, session management, and user profile data, and issues the tokens the Service verifies.",
      ],
    },
    {
      heading: "Email delivery",
      body: [
        "Transactional email (mentions, assignments, approvals) is delivered through our email provider, which processes recipient addresses and message content.",
      ],
    },
    {
      heading: "AI processing",
      body: [
        "When you enable AI features, our AI provider generates embeddings and completions from the relevant content. It is contractually prohibited from training foundation models on Your Content.",
      ],
    },
    {
      heading: "Payment facilitation (x402)",
      body: [
        "When agents pay through x402, a payment facilitator verifies and settles the on-chain payment. It processes wallet addresses, amounts, and settlement references. Settlement is recorded on a public blockchain.",
      ],
    },
  ],
};

// ── Security ──────────────────────────────────────────────────────────────
const SECURITY: LegalDoc = {
  slug: "security",
  title: "Security",
  short: "Security",
  summary:
    "How we protect the platform: least-privilege access, audited admin controls, signed webhooks, and agent governance.",
  intro: [
    "Security is built into how the platform works, not bolted on. This page summarizes the controls that protect your data and the agents that act on your behalf. For our processing commitments, see the Privacy Policy and Data Processing Addendum.",
  ],
  sections: [
    {
      heading: "Authorization",
      body: [
        "Every read and write resolves up the resource hierarchy and confirms access against a single centralized authorization layer, for humans and agents alike. Agents share the same code paths as humans, so a permission that applies to a person applies identically to an agent.",
      ],
    },
    {
      heading: "Agent governance",
      body: [
        "Agents are first-class principals with scoped API keys stored only as salted hashes. Each agent has a role, optional list restrictions, a per-day action budget, a burst limit, and optional human approval gates. Agents can raise an approval gate but never lower one, and cannot complete a gated task until a human approves.",
      ],
    },
    {
      heading: "Administrative controls (SOC 2 aligned)",
      body: [
        "Platform administration is governed by an environment-allowlist root of trust with scoped superadmin and support tiers. There is no in-app self-escalation path. Every administrative mutation and every break-glass content read writes an append-only audit-log entry. Account holds are enforced everywhere, including against administrators themselves, so a hold actually contains a compromised principal.",
      ],
    },
    {
      heading: "Outbound integrity",
      body: [
        "Outbound webhooks and agent notifications are signed with HMAC-SHA256, retried with backoff, and auto-disabled after repeated failures. All outbound URLs pass a server-side guard that refuses private and loopback addresses to prevent server-side request forgery.",
      ],
    },
    {
      heading: "Payment security",
      body: [
        "x402 payments are verified and settled through a facilitator; the platform never holds the private keys agents use to sign. Payment authorizations are single-use and validated before credits are granted, preventing replay.",
      ],
    },
    {
      heading: "Reporting a vulnerability",
      body: [
        `We welcome coordinated disclosure. Report suspected vulnerabilities to ${SECURITY_CONTACT} with enough detail to reproduce the issue. Please do not access data that is not yours, and give us reasonable time to remediate before public disclosure.`,
      ],
    },
  ],
};

// ── Data Processing Addendum ──────────────────────────────────────────────
const DPA: LegalDoc = {
  slug: "dpa",
  title: "Data Processing Addendum",
  short: "DPA",
  summary:
    "The terms under which we process personal data on your behalf as your processor.",
  intro: [
    `This Data Processing Addendum ("DPA") forms part of the Terms of Service between you (the "Controller") and ${LEGAL_ENTITY} (the "Processor") and applies where we process personal data on your behalf in providing the Service.`,
  ],
  sections: [
    {
      heading: "1. Roles and scope",
      body: [
        "You are the controller of the personal data contained in Your Content; we are the processor. We process that personal data only to provide the Service and only on your documented instructions, which include the Terms, this DPA, and your use of the product's features.",
      ],
    },
    {
      heading: "2. Processor obligations",
      body: ["As processor, we will:"],
      bullets: [
        "Process personal data only on your documented instructions, unless required otherwise by law.",
        "Ensure personnel authorized to process personal data are bound by confidentiality.",
        "Implement appropriate technical and organizational security measures, as described on our Security page.",
        "Assist you, taking into account the nature of processing, in responding to data-subject requests and in meeting your security, breach-notification, and impact-assessment obligations.",
        "Delete or return personal data at the end of the engagement, except where retention is required by law.",
        "Make available information necessary to demonstrate compliance and allow for reasonable audits.",
      ],
    },
    {
      heading: "3. Subprocessors",
      body: [
        "You authorize us to engage the subprocessors listed on our Subprocessors page. We impose data-protection obligations on each subprocessor no less protective than those in this DPA, and we remain responsible for their performance. We will give notice before adding a new subprocessor that processes your personal data.",
      ],
    },
    {
      heading: "4. International transfers",
      body: [
        "Where processing involves transferring personal data across borders, we rely on appropriate safeguards such as standard contractual clauses.",
      ],
    },
    {
      heading: "5. Security incidents",
      body: [
        "We will notify you without undue delay after becoming aware of a personal-data breach affecting your data, and will provide the information reasonably necessary for you to meet your notification obligations.",
      ],
    },
    {
      heading: "6. Deletion and return",
      body: [
        "On termination, you may export Your Content for a limited period, after which we will delete it in accordance with our retention practices, except where law requires retention.",
      ],
    },
    {
      heading: "7. Contact",
      body: [`Data-protection questions can be sent to ${PRIVACY_CONTACT}.`],
    },
  ],
};

export const LEGAL_DOCS: LegalDoc[] = [
  TERMS,
  PRIVACY,
  ACCEPTABLE_USE,
  COOKIES,
  SUBPROCESSORS,
  SECURITY,
  DPA,
];

export function getLegalDoc(slug: string): LegalDoc | undefined {
  return LEGAL_DOCS.find((d) => d.slug === slug);
}

// Consumed by the footer and sitemap.
export const LEGAL_LINKS = LEGAL_DOCS.map((d) => ({
  href: `/legal/${d.slug}`,
  label: d.short,
}));
