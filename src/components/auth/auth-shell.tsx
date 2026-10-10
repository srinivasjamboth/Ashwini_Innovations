"use client";

import {
  useEffect,
  useId,
  useState,
  type ComponentType,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertCircle, AlertTriangle, ChevronDown } from "lucide-react";

// ============================================================
// The pieces every auth page shares: the sliding-panel shell
// (auth-shell.css, imported by the (auth) layout), one labelled
// icon field, and the alert box.
//
// Keeping them here means /login, /signup, /forgot-password and
// /reset-password are the only things that differ between those
// routes — headings, fields and actions — and the layout, palette and
// animation can't drift between them.
//
// The entrance is the requested design's own: the shell renders in the
// neutral state, a timer adds the mode a beat later, and the stylesheet
// transitions each element from one state to the other. See the header
// of src/app/(auth)/auth-shell.css.
// ============================================================

/** Brand name and mark, matching the landing header and the favicon. */
const BRAND_NAME = "Ashwini Innovations";
const BRAND_LOGO_SRC = "/logo.jpeg";

/**
 * Which side the gradient panel ends up on, and which copy it shows.
 * `sign-up` is the odd one out — its form sits on the left, so the
 * panel slides right. Everything else (sign in, password request,
 * password set) sits on the right.
 */
export type AuthMode = "sign-in" | "sign-up" | "recover" | "reset";

const PANEL_KEY: Record<AuthMode, string> = {
  "sign-in": "signIn",
  "sign-up": "signUp",
  recover: "recover",
  reset: "reset",
};

interface AuthShellProps {
  mode: AuthMode;
  children: ReactNode;
}

export function AuthShell({ mode, children }: AuthShellProps) {
  const t = useTranslations("AuthShell");
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    // The neutral state has to be painted once before the mode is
    // applied, otherwise there is no starting value to transition from
    // and the panel just appears in place. One animation frame is all
    // that actually needs to elapse for the browser to commit the
    // neutral paint, so we arm on the next frame rather than the
    // template's fixed 200ms — that wait was stacking on top of the
    // stylesheet's own delays and made the page look unfinished while it
    // ran. The card/copy `transition-delay`s are measured from here.
    const id = window.requestAnimationFrame(() => setArmed(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  const panel = PANEL_KEY[mode];

  return (
    <div className="auth-shell" data-mode={mode} data-armed={armed ? "true" : "false"}>
      <aside className="auth-panel">
        <div className="auth-panel-inner">
          <h2 className="auth-panel-title">{t(`panel.${panel}.title`)}</h2>
          <p className="auth-panel-text">{t(`panel.${panel}.body`)}</p>
        </div>
      </aside>

      <div className="auth-form-col">
        <div className="auth-card">
          {/* The way back to the marketing site — the brand lockup is
              the link, so the card never needs a second "home" control
              competing with its own call to action. */}
          <Link href="/" className="auth-brand">
            <img
              src={BRAND_LOGO_SRC}
              alt=""
              width={40}
              height={40}
              className="h-10 w-10 shrink-0 rounded-xl object-cover"
            />
            <span className="auth-brand-name">{BRAND_NAME}</span>
          </Link>
          {children}
        </div>
      </div>
    </div>
  );
}

interface AuthFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  /** Lucide glyph drawn inside the control's leading edge. */
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  /** Heading drawn above the control. */
  label: string;
  /** Draws the red asterisk. Pair it with `required` on the input. */
  required?: boolean;
  /** Absolute inside the control's right edge — a show/hide toggle. */
  trailing?: ReactNode;
  className?: string;
}

/**
 * One field: a heading over a bordered, icon-bearing input.
 *
 * The heading is the label, not the placeholder. Placeholders here are
 * examples (`you@example.com`, `+91 96401 11265`), which stop naming the
 * field the moment it has text in them — so both are shown, and the
 * `<label>` is bound by `htmlFor` rather than hidden, so a click lands
 * in the input and a screen reader reads the name instead of the example.
 */
export function AuthField({
  icon: Icon,
  label,
  required,
  trailing,
  className,
  ...rest
}: AuthFieldProps) {
  const id = useId();
  return (
    <div className="auth-field">
      <label htmlFor={id} className="auth-label">
        {label}
        {required && <RequiredMark />}
      </label>
      <div className="auth-control">
        {Icon && <Icon className="auth-control-icon" aria-hidden={true} />}
        <input
          id={id}
          className={`auth-input${Icon ? "" : " auth-input--plain"}${trailing ? " auth-input--trailing" : ""}${className ? ` ${className}` : ""}`}
          {...rest}
        />
        {trailing}
      </div>
    </div>
  );
}

/**
 * A phone number split the way the reference splits it: a dialling-code
 * select and a national-number field in one row.
 *
 * The two are separate inputs but one value to the caller — this returns
 * `<code><digits>`, which is what `phoneForDb` stores, so the form never
 * has to join them itself and can't join them wrong (a space, or the `+`
 * on the wrong side).
 */
export function AuthPhoneField({
  label,
  code,
  number,
  onCodeChange,
  onNumberChange,
  placeholder,
  required,
  disabled,
  countries = PHONE_COUNTRIES,
}: {
  label: string;
  code: string;
  number: string;
  onCodeChange: (code: string) => void;
  onNumberChange: (value: string) => void;
  placeholder: string;
  required?: boolean;
  disabled?: boolean;
  countries?: readonly PhoneCountry[];
}) {
  const codeId = useId();
  const numberId = useId();
  return (
    <div className="auth-field">
      <label htmlFor={numberId} className="auth-label">
        {label}
        {required && <RequiredMark />}
      </label>
      <div className="auth-phone-row">
        <div className="auth-control auth-control--select">
          <select
            id={codeId}
            className="auth-select"
            value={code}
            disabled={disabled}
            onChange={(e) => onCodeChange(e.target.value)}
          >
            {countries.map((c) => (
              <option key={`${c.iso}-${c.code}`} value={c.code}>
                {c.iso} {c.code}
              </option>
            ))}
          </select>
          <ChevronDown className="auth-select-chevron" aria-hidden={true} />
        </div>
        <div className="auth-control auth-control--phone">
          <input
            id={numberId}
            className="auth-input auth-input--plain"
            type="tel"
            name="phone"
            autoComplete="national"
            inputMode="tel"
            placeholder={placeholder}
            value={number}
            disabled={disabled}
            onChange={(e) => onNumberChange(e.target.value)}
            required={required}
            maxLength={16}
          />
        </div>
      </div>
    </div>
  );
}

/** One entry in the dialling-code picker. */
export interface PhoneCountry {
  /** ISO 3166-1 alpha-2, shown as the country's short name. */
  iso: string;
  /** Dialling code including the leading `+`. */
  code: string;
}

/**
 * The codes on offer. Not the whole list — a <select> of ~240 entries is
 * unusable on a phone, and every other case is covered by typing `+` and
 * the digits, which `normalizePhone` accepts (the leading `+` survives
 * however it arrives). India is first because it is where the operator is.
 */
export const PHONE_COUNTRIES: readonly PhoneCountry[] = [
  { iso: "IN", code: "+91" },
  { iso: "US", code: "+1" },
  { iso: "GB", code: "+44" },
  { iso: "AU", code: "+61" },
  { iso: "AE", code: "+971" },
  { iso: "SA", code: "+966" },
  { iso: "SG", code: "+65" },
  { iso: "MY", code: "+60" },
  { iso: "ID", code: "+62" },
  { iso: "BD", code: "+880" },
  { iso: "PK", code: "+92" },
  { iso: "NP", code: "+977" },
  { iso: "LK", code: "+94" },
  { iso: "ZA", code: "+27" },
  { iso: "NG", code: "+234" },
  { iso: "KE", code: "+254" },
  { iso: "DE", code: "+49" },
  { iso: "FR", code: "+33" },
  { iso: "ES", code: "+34" },
  { iso: "IT", code: "+39" },
  { iso: "NL", code: "+31" },
  { iso: "BR", code: "+55" },
  { iso: "MX", code: "+52" },
  { iso: "CA", code: "+1" },
];

/** The red `*` that marks a heading as mandatory. */
function RequiredMark() {
  return (
    <span className="auth-required" aria-hidden={true}>
      {" *"}
    </span>
  );
}

interface AuthConsentProps
  extends Omit<LabelHTMLAttributes<HTMLLabelElement>, "children" | "onChange"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}

/** A checkbox row with a sentence of links in it — the consent line. */
export function AuthConsent({
  checked,
  onChange,
  disabled,
  children,
  ...rest
}: AuthConsentProps) {
  const id = useId();
  return (
    <label htmlFor={id} className="auth-consent" {...rest}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

interface AuthAlertProps {
  tone?: "error" | "warn";
  children: ReactNode;
}

/**
 * `role="alert"` because every use here is a response to something the
 * user just did — a rejected password, an expired link — and the form
 * does not change otherwise, so a screen reader would never learn the
 * submit had failed.
 */
export function AuthAlert({ tone = "error", children }: AuthAlertProps) {
  const Icon = tone === "warn" ? AlertTriangle : AlertCircle;
  return (
    <div
      role="alert"
      className={`auth-alert ${tone === "warn" ? "auth-alert-warn" : "auth-alert-error"}`}
    >
      <Icon aria-hidden={true} />
      <span>{children}</span>
    </div>
  );
}
