'use client';

// Templates moved out of Settings into a top-level sidebar destination.
// The screen itself is unchanged: it renders the exact same TemplateManager
// used previously under `Settings → Templates`, preserving the list view,
// builder, variables/buttons, publish/submit, AI Generate, sync, etc.
import { TemplateManager } from '@/components/settings/template-manager';

export default function TemplatesPage() {
  return <TemplateManager />;
}
