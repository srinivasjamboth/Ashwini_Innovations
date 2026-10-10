import type { LegalDocument } from "@/lib/marketing/legal-content";

/**
 * Renders one legal document.
 *
 * Plain server markup — the documents are static text, so they carry no
 * client component, no reveal-on-scroll wrapper and no carousel CSS. The
 * section numbers come from the array order rather than the strings, so
 * inserting a clause never leaves the numbering out by one.
 */
export function LegalDocumentView({ doc }: { doc: LegalDocument }) {
  return (
    <div className="container-fluid">
      <div className="container-xxl legal-page px-lg-5">
        <p className="text-primary-gradient fw-medium mb-2">Legal</p>
        <h1 className="mb-2">{doc.title}</h1>
        <p className="legal-updated mb-5">Last updated: {doc.updated}</p>

        {doc.sections.map((section, index) => (
          <section key={section.heading}>
            <h2>
              {index + 1}. {section.heading}
            </h2>
            {section.body.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
