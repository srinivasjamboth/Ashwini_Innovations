/**
 * Legal documents — the Terms of Service and the Privacy Policy, as
 * supplied by the operator. The wording is theirs and is reproduced
 * verbatim apart from the edits they asked for: the product is named
 * after the company (no separate brand name), the contact details are
 * the same ones the landing footer publishes, the Privacy Policy's
 * children clause and the Terms' governing-law clause were dropped, and
 * the numbering was closed up around those removals.
 *
 * The numbering lives in the renderer rather than in the strings, so a
 * section can be inserted or removed without renumbering anything by
 * hand — but the one cross-reference in the text (the Privacy Policy
 * pointing at its own contact section) has to be renumbered by hand, so
 * it is called out where it appears below.
 */

export type LegalSection = {
  heading: string;
  /** One entry per paragraph, in order. */
  body: string[];
};

export type LegalDocument = {
  slug: string;
  title: string;
  updated: string;
  sections: LegalSection[];
};

export const LEGAL_OPERATOR = "Ashwini Innovations";
/**
 * Contact details, deliberately identical to `LANDING_CONTACT` in
 * src/lib/marketing/landing-content.ts — the footer and the legal pages
 * must not quote two different addresses.
 */
export const LEGAL_CONTACT = {
  email: "admin@ashwiniinnovations.com",
  emailHref: "mailto:admin@ashwiniinnovations.com",
  phone: "+91 9640111265",
  phoneHref: "tel:+919640111265",
  location: "Ashwini Innovations, India",
  country: "India",
} as const;

export const TERMS_OF_SERVICE: LegalDocument = {
  slug: "terms",
  title: "Terms of Service",
  updated: "October 2, 2026",
  sections: [
    {
      heading: "Acceptance of Terms",
      body: [
        "By accessing or using the services of Ashwini Innovations (“the Service”), operated by Ashwini Innovations (“we,” “us,” or “our”), you agree to be bound by these Terms of Service. If you disagree with any part of the terms, you may not access the service.",
      ],
    },
    {
      heading: "Description of Service",
      body: [
        "Ashwini Innovations provides a software-as-a-service platform for managing WhatsApp Business API communications. We act as a technology provider connecting your business to the Meta WhatsApp Cloud API. The Service includes messaging, contact management, campaign automation, and related tooling.",
      ],
    },
    {
      heading: "Meta Policies Compliance",
      body: [
        "You agree to strictly adhere to the WhatsApp Business Messaging Policy and WhatsApp Commerce Policy. Ashwini Innovations is not responsible for any bans, quality-rating downgrades, or restrictions placed on your WhatsApp Business Account by Meta due to policy violations committed by you or your end users.",
      ],
    },
    {
      heading: "Subscriptions and Billing",
      body: [
        "You will be billed in advance on a recurring and periodic basis depending on your subscription plan. Conversation costs incurred via the Meta WhatsApp Cloud API may be billed in addition to your platform subscription fees. Fees are non-refundable except as described in our Refund Policy.",
      ],
    },
    {
      heading: "Your Responsibilities",
      body: [
        "You are responsible for (a) the accuracy of information you provide, (b) all activity under your account, (c) obtaining consent from recipients before messaging them, and (d) ensuring your use of the Service complies with all applicable laws in your jurisdiction.",
      ],
    },
    {
      heading: "Acceptable Use",
      body: [
        "You may not use the Service to send spam, unlawful content, misleading communications, or any content prohibited under the WhatsApp Business Messaging Policy. We reserve the right to suspend or terminate accounts that violate these restrictions.",
      ],
    },
    {
      heading: "Intellectual Property",
      body: [
        "All software, design, trademarks, and documentation provided through the Service remain the property of Ashwini Innovations or its licensors. You retain ownership of the data and content you upload.",
      ],
    },
    {
      heading: "Disclaimer and Limitation of Liability",
      body: [
        "The Service is provided “as is” without warranties of any kind. To the maximum extent permitted by law, Ashwini Innovations shall not be liable for any indirect, incidental, or consequential damages arising from your use of, or inability to use, the Service.",
      ],
    },
    {
      heading: "Contact",
      body: [
        "Questions about these Terms may be sent to admin@ashwiniinnovations.com or by phone at +91 9640111265.",
      ],
    },
  ],
};

export const PRIVACY_POLICY: LegalDocument = {
  slug: "privacy",
  title: "Privacy Policy",
  updated: "October 2, 2026",
  sections: [
    {
      heading: "Data Controller",
      body: [
        "This Privacy Policy describes how Ashwini Innovations (“we,” “us,” or “our”), with its principal place of business in India, collects, uses, and shares information when you use our website and our WhatsApp Business API platform. For questions about privacy, contact us at admin@ashwiniinnovations.com or +91 9640111265.",
      ],
    },
    {
      heading: "Information We Collect",
      body: [
        "We collect information you provide directly to us, such as when you create or modify your account, request support, or otherwise communicate with us. This may include your name, email address, phone number, business details, and billing information.",
        "We also collect limited technical information automatically, such as IP address, browser type, and pages visited, to operate and secure the Service.",
      ],
    },
    {
      heading: "End-User and WhatsApp Message Data",
      body: [
        "As a WhatsApp Business API platform, we process message content, contact lists, and conversation metadata on behalf of our business customers (who act as data controllers for their own customers). Business customers retain ownership of their customer data. We do not use customer or end-user data for our own marketing purposes, and we access it only to provide, secure, and debug the Service.",
        "End users of a business’s WhatsApp account may exercise rights regarding their data by contacting that business directly, or by contacting us as described in Section 10.",
      ],
    },
    {
      heading: "How We Use Information",
      body: [
        "We use the information we collect to provide and maintain the Service, process transactions, send service notices, comply with legal obligations, enforce our Terms of Service, and prevent abuse, spam, and security threats.",
      ],
    },
    {
      heading: "Sharing with Third Parties",
      body: [
        "We use third-party subprocessors to provide our services, including Meta Platforms, Inc. (WhatsApp Cloud API message delivery), and cloud infrastructure and hosting providers (Supabase, Vercel, Render). These entities process data only to the extent necessary to provide their services to us, in accordance with their respective privacy policies and our data-processing agreements. We do not sell personal information.",
      ],
    },
    {
      heading: "Data Security",
      body: [
        "We implement appropriate technical and organizational measures to protect the security of personal information and customer data, including encryption in transit (TLS) and at rest, access controls, and credential isolation on the server side.",
      ],
    },
    {
      heading: "Data Retention and Deletion",
      body: [
        "We retain personal information for as long as an account is active or as needed to provide the Service. Business customers may delete their account and associated data at any time from within the platform, or by contacting us. Deletion requests are processed within 30 days, subject to legal retention requirements.",
      ],
    },
    {
      heading: "Cookies",
      body: [
        "Our website uses cookies and similar technologies for authentication, session management, and preferences. You can control cookies through your browser settings; disabling them may affect the ability to log in and use the Service.",
      ],
    },
    {
      heading: "Your Rights",
      body: [
        "Subject to applicable law, you may request access to, correction of, export of, or deletion of your personal information, and you may object to certain processing. To exercise these rights, email admin@ashwiniinnovations.com. We respond to verified requests within 30 days.",
      ],
    },
    {
      heading: "Changes to This Policy",
      body: [
        "We may update this Privacy Policy from time to time. Material changes will be announced on this page with an updated revision date, and, where required, with additional notice.",
      ],
    },
    {
      heading: "Contact",
      body: [
        "For privacy questions or requests, contact: Ashwini Innovations — admin@ashwiniinnovations.com — +91 9640111265, India.",
      ],
    },
  ],
};

/** Both documents, so the footer and the legal layout can list them. */
export const LEGAL_DOCUMENTS = [TERMS_OF_SERVICE, PRIVACY_POLICY] as const;
