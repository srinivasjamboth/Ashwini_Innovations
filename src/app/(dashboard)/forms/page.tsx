'use client';

// WhatsApp Forms/Flows — a top-level destination, not a Settings panel.
// Building a Form is a recurring authoring task that pairs with template
// editing, so it sits next to Templates in the sidebar rather than
// behind a settings tab.
import { FormsManager } from '@/components/forms/forms-manager';

export default function FormsPage() {
  return <FormsManager />;
}
