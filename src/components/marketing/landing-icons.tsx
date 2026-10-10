import {
  ArrowUp,
  Bot,
  Check,
  GitBranch,
  Inbox,
  Layers,
  Mail,
  MapPin,
  Megaphone,
  Menu,
  Network,
  Phone,
  PieChart,
  Plug,
  Settings,
  Users,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * Landing page glyphs.
 *
 * The template drew every icon from Font Awesome 5 over a CDN
 * (`<i class="fa fa-cogs">`). That request is dropped: the icons are the
 * one part of the page that disappears completely when the CDN is
 * unreachable or blocked, which leaves the navbar toggler, the feature
 * circles, the step circles, the pricing ticks and the footer details
 * looking empty. They come from lucide-react instead — already a
 * dependency of this app, bundled with the page, no network request.
 *
 * The template's own visual treatment is unchanged: the same white glyph
 * centred in the 60px / 100px gradient circles, the same sizes. Keys are
 * the Font Awesome class names the template used, so the content module
 * still reads like the original markup.
 */
const ICONS: Record<string, LucideIcon> = {
  "fa-bars": Menu,
  "fa-close": X,
  "fa-arrow-up": ArrowUp,
  "fa-check": Check,
  "fa-plug": Plug,
  "fa-cogs": Settings,
  "fa-inbox": Inbox,
  "fa-users": Users,
  "fa-project-diagram": GitBranch,
  "fa-bullhorn": Megaphone,
  "fa-bolt": Zap,
  "fa-sitemap": Network,
  "fa-layer-group": Layers,
  "fa-robot": Bot,
  "fa-chart-pie": PieChart,
  "fa-envelope": Mail,
  "fa-phone-alt": Phone,
  "fa-map-marker-alt": MapPin,
};

/** fa fs-4 (24px) inside a 60px circle, fa-3x (48px) inside a 100px one. */
export const ICON_SIZE = { small: 18, feature: 24, step: 42, inline: 16 } as const;

export function LandingIcon({
  name,
  size = ICON_SIZE.feature,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const Icon = ICONS[name] ?? Check;
  return <Icon size={size} strokeWidth={1.9} className={className} aria-hidden />;
}
