import type { Metadata } from "next";

import { LegalDocumentView } from "@/components/marketing/legal-document";
import { TERMS_OF_SERVICE } from "@/lib/marketing/legal-content";

export const metadata: Metadata = {
  title: TERMS_OF_SERVICE.title,
  description:
    "The terms you accept when you use the Ashwini Innovations WhatsApp Business platform.",
};

export default function TermsPage() {
  return <LegalDocumentView doc={TERMS_OF_SERVICE} />;
}
