import { LandingFeatures } from "@/components/marketing/landing-features";
import { LandingFinalCta } from "@/components/marketing/landing-final-cta";
import { LandingHero } from "@/components/marketing/landing-hero";
import { LandingHowItWorks } from "@/components/marketing/landing-how-it-works";
import { LandingPricing } from "@/components/marketing/landing-pricing";

/**
 * Public landing page at `/`.
 *
 * The navbar, the preloader, the sections and the footer all come from
 * the template in `landing page/`, in its own markup and its own CSS:
 * hero with the phone-screenshot carousel, the 3-step process row, the
 * feature grid, the pricing pills, the closing band, the footer.
 *
 * Two of the template's sections are not carried over, for one reason
 * each: the counters and the social-proof carousel are built entirely
 * from the vendor's placeholders (1234 installs, "Client Name /
 * Profession", stock portraits), and the store-badge band and the
 * enquiry form point at nothing. Nothing was invented to fill them.
 */
export default function LandingPage() {
  return (
    <>
      <LandingHero />
      <LandingHowItWorks />
      <LandingFeatures />
      <LandingPricing />
      <LandingFinalCta />
    </>
  );
}
