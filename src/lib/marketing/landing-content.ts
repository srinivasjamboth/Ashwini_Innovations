/**
 * Landing page content — the single source of truth for the copy on the
 * public marketing page, so the section components stay presentational.
 *
 * The markup, layout, grid classes and animations come from the landing
 * page template (see src/app/(marketing)/template/). Only the words and
 * the palette were changed, per the brief.
 *
 * WHAT IS REAL HERE
 * Every feature and step below describes a module that exists in this
 * codebase (inbox, contacts, pipelines, broadcasts, automations,
 * flows/forms, templates, AI reply, dashboard). Nothing was invented to
 * fill space, so these template sections are gone rather than filled
 * with fiction: the counters (1234 / 1234), the testimonial carousel
 * ("Client Name", "Profession") and the contact form (which shipped
 * inactive and linked out to the vendor's own product). The footer's
 * contact details are the operator's real ones — see LANDING_CONTACT.
 *
 * Icons are Font Awesome class names, exactly as the template wrote
 * them, so the 60px gradient icon circles keep their original look; the
 * class name is looked up in components/marketing/landing-icons.tsx and
 * rendered as a bundled SVG instead of a CDN font glyph.
 *
 * PRICING IS THE EXCEPTION — see the note on LANDING_PLANS.
 */

import { LEGAL_DOCUMENTS } from "@/lib/marketing/legal-content";

/** In-page anchors. Features and Pricing scroll to their sections on the
 *  landing page; the section ids must stay in sync with these hashes. */
export interface LandingNavLink {
  label: string;
  /** id of the section on the landing page */
  hash: string;
}

export const LANDING_NAV: LandingNavLink[] = [
  { label: "Home", hash: "home" },
  { label: "Features", hash: "features" },
  { label: "Pricing", hash: "pricing" },
];

export const LANDING_BRAND = {
  name: "Ashwini Innovations",
  /** Served from public/ — the same file the dashboard sidebar, the
   *  login page and the favicon already use. */
  logoSrc: "/logo.jpeg",
  loginHref: "/login",
  /** This app signs users up at /signup — there is no /register route. */
  signupHref: "/signup",
} as const;

/* ------------------------------------------------------------
   Hero
   ------------------------------------------------------------ */

export const LANDING_HERO = {
  headline: "The WhatsApp workspace that puts your whole team in one inbox",
  subhead:
    "Connect your WhatsApp Business number and give support, sales and marketing a single place to reply, automate, broadcast and track deals — no shared phone, no spreadsheets.",
  primaryCta: { label: "Start free trial", href: LANDING_BRAND.signupHref },
  secondaryCta: { label: "Log in", href: LANDING_BRAND.loginHref },
  /** Right-hand phone mockup carousel (the template's screenshot
   *  carousel). These PNGs are the ones that shipped with the template:
   *  the frame is ours to use, the screens inside are placeholder UI
   *  and should be swapped for real product screenshots. */
  screenshots: [
    { src: "/landing/img/screenshot-1.png?v=20261010b", alt: "Product screenshot 1" },
    { src: "/landing/img/screenshot-2.jpg?v=20261010", alt: "Product screenshot 2" },
    { src: "/landing/img/screenshot-3.jpg?v=20261010", alt: "Product screenshot 3" },
    { src: "/landing/img/screenshot-4.jpg?v=20261010", alt: "Product screenshot 4" },
    { src: "/landing/img/screenshot-5.jpg?v=20261010", alt: "Product screenshot 5" },
  ],
} as const;

/* ------------------------------------------------------------
   How It Works — 3 steps (the template's Process section)
   ------------------------------------------------------------ */

export interface LandingStep {
  /** Shown as the step circle, so it can never drift from the array. */
  index: number;
  title: string;
  body: string;
  /** Font Awesome class, as the template wrote them. */
  icon: string;
  /** Alternates the two gradient circles, like the template does. */
  tone: "primary" | "secondary";
}

export const LANDING_HOW_IT_WORKS = {
  eyebrow: "How It Works",
  headline: "Three steps to a shared inbox",
} as const;

export const LANDING_STEPS: LandingStep[] = [
  {
    index: 1,
    title: "Connect your number",
    body: "Point Ashwini Innovations at your WhatsApp Business account through the Meta Cloud API. Inbound messages arrive in the shared inbox in real time.",
    icon: "fa-plug",
    tone: "primary",
  },
  {
    index: 2,
    title: "Set up your workspace",
    body: "Import contacts, tag and segment them, sync your approved message templates, and build automations or branching WhatsApp Flows for menus and triage.",
    icon: "fa-cogs",
    tone: "secondary",
  },
  {
    index: 3,
    title: "Work the inbox together",
    body: "Agents reply from one conversation list, hand threads over, send broadcasts to a chosen audience and move deals along your pipelines.",
    icon: "fa-inbox",
    tone: "primary",
  },
];

/* ------------------------------------------------------------
   Features (the template's feature grid)
   ------------------------------------------------------------ */

export interface LandingFeature {
  title: string;
  body: string;
  /** Font Awesome class, as the template wrote them. */
  icon: string;
  tone: "primary" | "secondary";
}

export const LANDING_FEATURES_HEADLINE = {
  eyebrow: "Features",
  headline: "Everything the number needs, in one place",
} as const;

export const LANDING_FEATURES: LandingFeature[] = [
  {
    title: "Shared inbox",
    body: "Every conversation on the number in one list, with realtime updates, unread counts, internal notes, reactions and delivery status you can actually see.",
    icon: "fa-inbox",
    tone: "primary",
  },
  {
    title: "Contacts & segments",
    body: "Import a CSV, tag and label people, keep custom fields, and pick exactly the audience a broadcast or automation should fire at.",
    icon: "fa-users",
    tone: "secondary",
  },
  {
    title: "Deal pipelines",
    body: "Attach conversations to stages and values, then watch revenue by stage and average first-response time on the same board.",
    icon: "fa-project-diagram",
    tone: "primary",
  },
  {
    title: "Broadcasts that survive",
    body: "Send an approved template to a tagged audience, pause and resume a run, and retry only the recipients that Meta bounced.",
    icon: "fa-bullhorn",
    tone: "secondary",
  },
  {
    title: "Automations",
    body: "Rule-based triggers on inbound messages — tag, assign, reply or move a deal — with an execution log so you can see exactly what fired.",
    icon: "fa-bolt",
    tone: "primary",
  },
  {
    title: "WhatsApp Flows & Forms",
    body: "Branching button and list conversations for menus, FAQs and triage before a human steps in, with a playground to test them first.",
    icon: "fa-sitemap",
    tone: "secondary",
  },
  {
    title: "Template library",
    body: "Sync your Meta templates, track approval status per language, and preview headers, body text and variables in a phone frame before you send.",
    icon: "fa-layer-group",
    tone: "primary",
  },
  {
    title: "AI drafted replies",
    body: "Bring your own OpenAI or Anthropic key for drafted replies, an auto-reply bot, and answers grounded in your own knowledge base.",
    icon: "fa-robot",
    tone: "secondary",
  },
  {
    title: "Analytics dashboard",
    body: "Conversation volume by direction, deal value by stage, response times by weekday — live across the accounts you have connected.",
    icon: "fa-chart-pie",
    tone: "primary",
  },
];

/* ------------------------------------------------------------
   Pricing (the template's Pricing section)

   The four tiers the operator specified (7-Day Free Trial, Starter,
   Growth, Enterprise) with their monthly rupee prices. The yearly
   figure is derived, not entered by hand: it is 12 × the monthly price
   (twelve months at the same rate). Presentation only — there is no
   billing backend behind these numbers yet; the CTAs just point at
   /signup.
   ------------------------------------------------------------ */

export interface LandingPlan {
  name: string;
  tagline: string;
  /** Per-month price, thousands-separated, without the currency symbol. */
  monthly: string;
  /**
   * Per-year price. Computed as 12 × `monthly` — see the note above.
   * Kept as a display string so the thousands separator stays where the
   * design wants it.
   */
  yearly: string;
  includes: string[];
  /** Which gradient the CTA button uses. */
  tone: "primary" | "secondary";
  /** Renders the "Most Popular" badge and an emphasised border. */
  popular?: boolean;
  /** CTA label; falls back to "Start free trial" when unset. */
  cta?: string;
}

/** Currency symbol shown as the price superscript. */
export const LANDING_CURRENCY = "₹";

export const LANDING_PRICING_HEADLINE = {
  eyebrow: "Pricing Plan",
  headline: "Choose Your Plan",
} as const;

/** The four tiers, priced monthly; `yearly` is 12 × `monthly`. */
export const LANDING_PLANS: LandingPlan[] = [
  {
    name: "7-Day Free Trial",
    tagline: "No credit card required",
    monthly: "0",
    yearly: "0",
    tone: "primary",
    cta: "Start free trial",
    includes: [
      "100 Contacts",
      "100 Bulk Broadcast Messages",
      "3 Templates",
      "5 Quick Replies",
      "1 Automation Flow",
      "1 WhatsApp Form",
      "Opt In / Opt Out — Included",
      "1 User",
      "Customer Support",
    ],
  },
  {
    name: "Starter",
    tagline: "Perfect for small teams",
    monthly: "999",
    yearly: "11,988",
    tone: "primary",
    cta: "Subscribe",
    includes: [
      "WhatsApp AI Agent",
      "Send up to 5,000 bulk broadcast messages/month",
      "WhatsApp Bulk Broadcast",
      "Template Message API (10 templates)",
      "1,000 Contacts",
      "20 Quick Replies",
      "3 WhatsApp Automation Flows",
      "3 WhatsApp Forms",
      "Tags & Attributes",
      "Opt In / Opt Out — Included",
      "2 Users",
      "Customer Support",
    ],
  },
  {
    name: "Growth",
    tagline: "For scaling businesses",
    monthly: "1,999",
    yearly: "23,988",
    tone: "secondary",
    popular: true,
    cta: "Subscribe",
    includes: [
      "WhatsApp AI Agent",
      "All Starter Features +",
      "Send up to 25,000 bulk broadcast messages/month",
      "Campaign Scheduler",
      "Unlimited Templates",
      "Unlimited Quick Replies",
      "Unlimited WhatsApp Automation Flows",
      "Unlimited WhatsApp Forms",
      "Tags & Attributes",
      "Opt In / Opt Out — Included",
      "10 Users",
      "Customer Support",
    ],
  },
  {
    name: "Enterprise",
    tagline: "Unrestricted limits",
    monthly: "2,999",
    yearly: "35,988",
    tone: "secondary",
    cta: "Subscribe",
    includes: [
      "WhatsApp AI Agent",
      "All Growth Features +",
      "Send unlimited bulk broadcast messages/month (fair-use policy)",
      "Unlimited Contacts",
      "Unlimited Templates",
      "Unlimited Quick Replies",
      "Unlimited WhatsApp Automation Flows",
      "Unlimited WhatsApp Forms",
      "Tags & Attributes",
      "Opt In / Opt Out — Included",
      "Unlimited Users",
      "Customer Support",
    ],
  },
];

export const LANDING_BILLING_PERIODS = [
  { key: "monthly" as const, label: "Monthly", suffix: "/ Month" },
  { key: "yearly" as const, label: "Yearly", suffix: "/ Year" },
];

/* ------------------------------------------------------------
   Final CTA band + footer
   ------------------------------------------------------------ */

export const LANDING_FINAL_CTA = {
  eyebrow: "Get Started",
  headline: "Put your WhatsApp in one workspace",
  body: "Connect your business number and have the team replying from a single inbox in a few minutes.",
  primaryCta: { label: "Start free trial", href: LANDING_BRAND.signupHref },
  secondaryCta: { label: "Log in", href: LANDING_BRAND.loginHref },
} as const;

export const LANDING_FOOTER = {
  blurb:
    "Ashwini Innovations is a WhatsApp business workspace: shared inbox, contacts, pipelines, broadcasts, automations and flows for your connected numbers.",
  /** The in-page anchors, same list as the navbar. */
  links: LANDING_NAV,
  copyright: "© 2026 Ashwini Innovations",
} as const;

/**
 * Footer details, supplied by the operator — real contact routes, not
 * template placeholders. The template's address block was
 * "123 Street, New York, USA / +012 345 67890 / info@example.com".
 */
export const LANDING_CONTACT = {
  eyebrow: "Contact Us",
  email: {
    note: "For general inquiries and support.",
    value: "admin@ashwiniinnovations.com",
    href: "mailto:admin@ashwiniinnovations.com",
  },
  phone: { value: "+91 9640111265", href: "tel:+919640111265" },
  location: { name: "Ashwini Innovations", country: "India" },
} as const;

/**
 * Footer legal column. Titles and routes are read from the documents
 * themselves (lib/marketing/legal-content.ts), which are rendered at
 * /terms and /privacy by the (legal) route group — so the footer can
 * never advertise a page that is not there.
 */
export const LANDING_LEGAL = {
  eyebrow: "Legal",
  items: LEGAL_DOCUMENTS.map((doc) => ({ label: doc.title, href: `/${doc.slug}` })),
};
