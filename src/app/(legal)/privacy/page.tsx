import type { Metadata } from "next";

import { LegalDocumentView } from "@/components/marketing/legal-document";
import { PRIVACY_POLICY } from "@/lib/marketing/legal-content";

export const metadata: Metadata = {
  title: PRIVACY_POLICY.title,
  description:
    "How Ashwini Innovations collects, uses and protects the data handled by its WhatsApp Business platform.",
};

export default function PrivacyPage() {
  return <LegalDocumentView doc={PRIVACY_POLICY} />;
}
