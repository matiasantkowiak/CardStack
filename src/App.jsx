import React, { useState, useMemo, useEffect } from "react";
import { AlertTriangle, Trash2, Package, X, Search, RefreshCw, Loader2, Sun, Moon, Monitor, ChevronDown, ImagePlus, ArrowUpRight, Check, Bookmark, Radar, BarChart3, Info } from "lucide-react";

// ===== PSA grading tiers (Oct 2026 pricing) =====
// maxValue = PSA's max insured value for the tier
const PSA_TIERS = [
  { id: "standard",  name: "Standard",      cost: 59.99, maxValue: 1000,  turnaround: "90–100 business days" },
  { id: "priority",  name: "Priority",      cost: 79.99, maxValue: 1500,  turnaround: "70–80 business days", note: "Returned in a fitted sleeve" },
  { id: "express",   name: "Express",       cost: 199,   maxValue: 2500,  turnaround: "20–30 business days", note: "Includes grader notes" },
  { id: "superexp",  name: "Super Express", cost: 349,   maxValue: 5000,  turnaround: "10–15 business days" },
  { id: "premier",   name: "Premier",       cost: 599,   maxValue: 10000, turnaround: "7–10 business days" },
];

// ===== Core calculation engine =====
// ownsCard mode: rawCost represents the raw SELL price (opportunity cost), not buy price.
// In this mode, we skip tax/buy shipping and treat raw sell as the alternative outcome.
function computeEV({ rawCost, salesTaxPct, buyShippingCost, ownsCard, gradeProbabilities, gradePrices, gradingCost, shippingCost, sellFeePct }) {
  const grades = ["psa10", "psa9", "psa8", "psa7orLower"];
  const feeMultiplier = 1 - sellFeePct / 100;

  let totalCost, opportunityCost = 0;
  if (ownsCard) {
    // Already own: cost is only grading + ship to PSA. Raw sell price is the alternative we forgo.
    totalCost = gradingCost + shippingCost;
    opportunityCost = rawCost * feeMultiplier; // what you'd net selling raw now
  } else {
    // Buying to grade: full acquisition costs included
    const salesTax = rawCost * ((salesTaxPct || 0) / 100);
    totalCost = rawCost + salesTax + (buyShippingCost || 0) + gradingCost + shippingCost;
  }

  const outcomes = grades.map((g) => {
    const prob = gradeProbabilities[g] / 100;
    const grossPrice = gradePrices[g];
    const netPrice = grossPrice * feeMultiplier;
    // In "owns" mode, profit = graded net - grading costs - what you gave up by not selling raw
    // In "buy" mode, profit = graded net - total acquisition cost
    const profit = ownsCard
      ? netPrice - totalCost - opportunityCost
      : netPrice - totalCost;
    return { grade: g, prob, grossPrice, netPrice, profit };
  });

  const ev = outcomes.reduce((sum, o) => sum + o.prob * o.profit, 0);
  const evPlusCost = ev + totalCost + opportunityCost;
  const variance = outcomes.reduce((sum, o) => sum + o.prob * Math.pow(o.profit - ev, 2), 0);
  const stdDev = Math.sqrt(variance);
  const probOfLoss = outcomes.filter((o) => o.profit < 0).reduce((s, o) => s + o.prob, 0);
  const sharpe = stdDev > 0 ? ev / stdDev : 0;
  const breakEven10Rate = (() => {
    const p10NetProfit = ownsCard
      ? gradePrices.psa10 * feeMultiplier - totalCost - opportunityCost
      : gradePrices.psa10 * feeMultiplier - totalCost;
    const otherEV = outcomes.filter((o) => o.grade !== "psa10").reduce((s, o) => {
      const reweighted = o.prob / (1 - gradeProbabilities.psa10 / 100);
      return s + reweighted * o.profit;
    }, 0);
    if (p10NetProfit <= otherEV) return null;
    return (-otherEV / (p10NetProfit - otherEV)) * 100;
  })();
  // ROI denominator: in owns mode, we're risking the opportunity cost + grading; in buy mode, totalCost.
  const roiDenominator = ownsCard ? totalCost + opportunityCost : totalCost;
  const roi = roiDenominator > 0 ? (ev / roiDenominator) * 100 : 0;

  // Verdict
  let verdict;
  if (ev <= 0) verdict = "AVOID";
  else if (sharpe < 0.3 || probOfLoss > 0.6) verdict = "HIGH_RISK";
  else if (sharpe < 0.7) verdict = "MARGINAL";
  else if (sharpe < 1.5) verdict = "FAVORABLE";
  else verdict = "STRONG_BUY";

  return { outcomes, ev, evPlusCost, stdDev, probOfLoss, sharpe, breakEven10Rate, roi, totalCost, opportunityCost, ownsCard, verdict };
}

// Selection-bias-adjusted estimate of YOUR 10-rate from pop report
function adjustPopReport({ popPSA10, popPSA9, popPSA8, popLower, biasHaircut }) {
  const total = popPSA10 + popPSA9 + popPSA8 + popLower;
  if (total === 0) return { psa10: 25, psa9: 50, psa8: 20, psa7orLower: 5 };
  const raw10 = (popPSA10 / total) * 100;
  const raw9 = (popPSA9 / total) * 100;
  const raw8 = (popPSA8 / total) * 100;
  const rawLower = (popLower / total) * 100;
  const adjusted10 = raw10 * (1 - biasHaircut / 100);
  const lostMass = raw10 - adjusted10;
  const lower3Total = raw9 + raw8 + rawLower;
  const adjusted9 = raw9 + (lower3Total > 0 ? (raw9 / lower3Total) * lostMass : lostMass / 3);
  const adjusted8 = raw8 + (lower3Total > 0 ? (raw8 / lower3Total) * lostMass : lostMass / 3);
  const adjustedLower = rawLower + (lower3Total > 0 ? (rawLower / lower3Total) * lostMass : lostMass / 3);
  return {
    psa10: Math.round(adjusted10 * 10) / 10,
    psa9: Math.round(adjusted9 * 10) / 10,
    psa8: Math.round(adjusted8 * 10) / 10,
    psa7orLower: Math.round(adjustedLower * 10) / 10,
  };
}

const fmt$ = (n) => {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}k`;
  return `${sign}$${abs.toFixed(2)}`;
};
const fmt$Full = (n) => {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
};
const fmtPct = (n) => (n === null || n === undefined || isNaN(n) ? "—" : `${n.toFixed(1)}%`);

const fmtSigned$ = (n) => {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return `${n > 0 ? "+" : ""}${fmt$Full(n)}`;
};

// CSS-variable color helper for inline styles / SVG: col("pos", 0.4)
const col = (token, a = 1) => `rgb(var(--${token}) / ${a})`;

// ===== Design system =====

const VERDICTS = {
  STRONG_BUY: { label: "Strong buy", tone: "pos",     blurb: "Exceptional risk/reward. Stress-test your inputs before scaling in." },
  FAVORABLE:  { label: "Favorable",  tone: "pos",     blurb: "Solid risk-adjusted return. Worth a position." },
  MARGINAL:   { label: "Marginal",   tone: "neutral", blurb: "Reasonable bet, but the edge is thin. Double-check your comps." },
  HIGH_RISK:  { label: "High risk",  tone: "warn",    blurb: "Positive EV, but volatile. Only worth it if you can absorb the swings." },
  AVOID:      { label: "Avoid",      tone: "neg",     blurb: "Negative expected value. The math says don't grade this one." },
};

const TONE_TEXT = { pos: "text-pos", neg: "text-neg", warn: "text-warn", neutral: "text-ink" };
const TONE_PILL = {
  pos: "bg-pos/10 text-pos",
  neg: "bg-neg/10 text-neg",
  warn: "bg-warn/10 text-warn",
  neutral: "bg-subtle text-ink-2",
};
const TONE_DOT = { pos: "bg-pos", neg: "bg-neg", warn: "bg-warn", neutral: "bg-faint" };

const sharpeTone = (s) => (s > 0.7 ? "pos" : s > 0.3 ? "warn" : "neg");
const signTone = (n) => (n > 0 ? "pos" : n < 0 ? "neg" : "neutral");

const inputCls =
  "w-full h-9 rounded-lg bg-surface border border-line text-ink text-[14px] tabular-nums placeholder:text-faint " +
  "transition-[border-color,box-shadow] hover:border-line-strong focus:outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/15";

function Button({ variant = "primary", size = "md", className = "", children, ...props }) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-all " +
    "disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/25 enabled:active:scale-[0.98]";
  const sizes = { sm: "h-8 px-3 text-[13px]", md: "h-9 px-4 text-[14px]" };
  const variants = {
    primary: "bg-ink text-bg enabled:hover:bg-ink/85 shadow-sm",
    secondary: "bg-surface text-ink border border-line enabled:hover:bg-subtle enabled:hover:border-line-strong shadow-card",
    ghost: "text-muted enabled:hover:text-ink enabled:hover:bg-subtle",
    danger: "text-muted enabled:hover:text-neg enabled:hover:bg-neg/10",
  };
  return (
    <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}

function IconButton({ label, className = "", children, ...props }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={`h-8 w-8 grid place-items-center rounded-lg text-faint hover:text-ink hover:bg-subtle transition-colors ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

function Card({ className = "", children }) {
  return <div className={`bg-surface border border-line rounded-xl shadow-card ${className}`}>{children}</div>;
}

function CardHeader({ title, subtitle, right }) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-4">
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold text-ink tracking-[-0.01em]">{title}</h3>
        {subtitle && <p className="text-[13px] text-muted mt-0.5">{subtitle}</p>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}

function Pill({ tone = "neutral", children, dot = false, className = "" }) {
  return (
    <span className={`inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[12px] font-medium tabular-nums whitespace-nowrap ${TONE_PILL[tone]} ${className}`}>
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${TONE_DOT[tone]}`} />}
      {children}
    </span>
  );
}

function VerdictPill({ code }) {
  const v = VERDICTS[code] || VERDICTS.MARGINAL;
  return <Pill tone={v.tone} dot>{v.label}</Pill>;
}

function Label({ children, hint }) {
  return (
    <div className="flex items-baseline justify-between gap-2 mb-1.5">
      <span className="text-[13px] font-medium text-ink-2">{children}</span>
      {hint && <span className="text-[12px] text-faint truncate">{hint}</span>}
    </div>
  );
}

function Callout({ tone = "neutral", children }) {
  const cls = {
    neutral: "bg-subtle text-ink-2",
    warn: "bg-warn/10 text-warn",
    neg: "bg-neg/10 text-neg",
  }[tone];
  const Icon = tone === "neutral" ? Info : AlertTriangle;
  return (
    <div className={`flex gap-2.5 rounded-lg px-3 py-2.5 text-[13px] leading-snug ${cls}`}>
      <Icon size={14} className="mt-[2px] shrink-0 opacity-80" />
      <div>{children}</div>
    </div>
  );
}

function SummaryRow({ label, value, tone }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-subtle px-3 h-9 text-[13px]">
      <span className="text-muted">{label}</span>
      <span className={`font-medium tabular-nums ${tone ? TONE_TEXT[tone] : "text-ink"}`}>{value}</span>
    </div>
  );
}

function Segmented({ options, value, onChange }) {
  return (
    <div className="flex w-full p-0.5 rounded-lg bg-subtle border border-line">
      {options.map((o) => (
        <button
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          className={`flex-1 h-8 px-3 rounded-md text-[13px] font-medium whitespace-nowrap transition-all ${
            value === o.value ? "bg-surface text-ink shadow-sm ring-1 ring-line" : "text-muted hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Select({ value, onChange, children }) {
  return (
    <div className="relative">
      <select value={value} onChange={onChange} className={`${inputCls} appearance-none pl-3 pr-9 cursor-pointer`}>
        {children}
      </select>
      <ChevronDown size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint" />
    </div>
  );
}

function Stat({ label, value, sub, tone = "neutral" }) {
  return (
    <div className="bg-surface px-5 py-4">
      <div className="text-[13px] text-muted">{label}</div>
      <div className={`mt-1 text-[22px] font-semibold tracking-[-0.02em] tabular-nums ${TONE_TEXT[tone]}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-faint tabular-nums">{sub}</div>}
    </div>
  );
}

function PageHeader({ title, description, actions }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
      <div>
        <h1 className="text-[28px] sm:text-[32px] font-semibold tracking-[-0.03em] text-ink leading-tight">{title}</h1>
        {description && <p className="mt-2 text-[15px] text-muted max-w-2xl leading-relaxed">{description}</p>}
      </div>
      {actions && <div className="flex gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <Card className="py-16 px-6 text-center">
      <div className="mx-auto w-11 h-11 rounded-full bg-subtle grid place-items-center text-muted mb-4">
        <Icon size={18} />
      </div>
      <div className="text-[15px] font-medium text-ink">{title}</div>
      <div className="text-[14px] text-muted mt-1 max-w-sm mx-auto">{description}</div>
      {action && <div className="mt-5">{action}</div>}
    </Card>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="8" y="2" width="12" height="16" rx="2.5" className="fill-ink/30" />
      <rect x="4" y="6" width="12" height="16" rx="2.5" className="fill-ink" />
    </svg>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("theme") || "dark"; } catch (e) { return "dark"; }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try { localStorage.setItem("theme", theme); } catch (e) {}
  }, [theme]);
  const next = { dark: "light", light: "system", system: "dark" }[theme];
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  return (
    <IconButton label={`Theme: ${theme} (switch to ${next})`} onClick={() => setTheme(next)}>
      <Icon size={16} />
    </IconButton>
  );
}

// Table primitives — horizontally scrollable on small screens
function Table({ cols, minWidth = 760, head, children }) {
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <div style={{ minWidth }}>
          <div className="grid gap-4 px-5 h-10 items-center border-b border-line bg-subtle/50 text-[12px] font-medium text-muted" style={{ gridTemplateColumns: cols }}>
            {head}
          </div>
          {children}
        </div>
      </div>
    </Card>
  );
}

function Row({ cols, className = "", children }) {
  return (
    <div
      className={`grid gap-4 px-5 py-3 items-center border-b border-line last:border-b-0 hover:bg-subtle/50 transition-colors text-[14px] ${className}`}
      style={{ gridTemplateColumns: cols }}
    >
      {children}
    </div>
  );
}

function Thumb({ src }) {
  return src ? (
    <img src={src} alt="" className="w-9 h-12 object-cover rounded-md ring-1 ring-line bg-subtle shrink-0" />
  ) : (
    <div className="w-9 h-12 rounded-md bg-subtle ring-1 ring-line shrink-0" />
  );
}

// ===== Form fields =====

function NumField({ label, value, onChange, prefix, suffix, step = "any", hint }) {
  // Local string state lets us show empty while typing, instead of forcing "0"
  const [localValue, setLocalValue] = useState(String(value));

  // Sync local from prop when value changes externally (e.g. tier switch)
  React.useEffect(() => {
    if (parseFloat(localValue) !== value && document.activeElement?.dataset?.numfieldId !== label) {
      setLocalValue(String(value));
    }
  }, [value]);

  const handleChange = (e) => {
    const raw = e.target.value;
    setLocalValue(raw);
    const parsed = parseFloat(raw);
    if (!isNaN(parsed)) onChange(parsed);
    else if (raw === "" || raw === "-") onChange(0);
  };

  const handleBlur = () => {
    const parsed = parseFloat(localValue);
    if (isNaN(parsed)) setLocalValue("0");
    else setLocalValue(String(parsed));
  };

  return (
    <label className="block min-w-0">
      <Label hint={hint}>{label}</Label>
      <div className="relative">
        {prefix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-faint text-[14px]">{prefix}</span>}
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={localValue}
          data-numfield-id={label}
          onFocus={(e) => e.target.select()}
          onChange={handleChange}
          onBlur={handleBlur}
          className={`${inputCls} ${prefix ? "pl-6" : "pl-3"} ${suffix ? "pr-8" : "pr-3"}`}
        />
        {suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-faint text-[14px]">{suffix}</span>}
      </div>
    </label>
  );
}

function TextField({ label, value, onChange, placeholder }) {
  return (
    <label className="block">
      <Label>{label}</Label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${inputCls} px-3`}
      />
    </label>
  );
}

// Card image: supports drag-drop upload, file picker, paste URL.
function CardImageInput({ value, onChange }) {
  const [urlMode, setUrlMode] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInputRef = React.useRef(null);

  const handleFile = (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return;
    if (file.size > 5 * 1024 * 1024) {
      alert("Image too large. Try one under 5MB or use a URL.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => onChange(e.target.result);
    reader.readAsDataURL(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files?.[0]);
  };

  const handlePaste = () => {
    if (urlInput.trim()) {
      onChange(urlInput.trim());
      setUrlInput("");
      setUrlMode(false);
    }
  };

  return (
    <div>
      <Label>Image <span className="text-faint font-normal">(optional)</span></Label>
      {value ? (
        <div className="relative rounded-lg bg-subtle ring-1 ring-line p-3 flex justify-center">
          <img src={value} alt="Card" className="h-44 object-contain rounded-md" />
          <Button variant="secondary" size="sm" className="absolute top-2 right-2" onClick={() => onChange("")}>
            Remove
          </Button>
        </div>
      ) : urlMode ? (
        <div className="flex gap-2">
          <input
            type="text"
            value={urlInput}
            autoFocus
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handlePaste()}
            placeholder="https://…"
            className={`${inputCls} px-3 flex-1`}
          />
          <Button size="md" onClick={handlePaste}>Add</Button>
          <IconButton label="Cancel" className="h-9 w-9" onClick={() => { setUrlMode(false); setUrlInput(""); }}>
            <X size={15} />
          </IconButton>
        </div>
      ) : (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`rounded-lg border border-dashed py-6 px-4 text-center cursor-pointer transition-colors ${
            dragging ? "border-accent bg-accent/5" : "border-line-strong hover:border-faint hover:bg-subtle/60"
          }`}
        >
          <ImagePlus size={18} className="mx-auto text-faint mb-2" />
          <div className="text-[13px] text-ink-2">
            Drop an image or <span className="text-accent font-medium">browse</span>
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setUrlMode(true); }}
            className="mt-1 text-[12px] text-muted hover:text-ink underline-offset-2 hover:underline"
          >
            Paste a URL instead
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={(e) => handleFile(e.target.files?.[0])}
            className="hidden"
          />
        </div>
      )}
    </div>
  );
}

function FormSection({ title, description, children }) {
  return (
    <div className="px-5 py-5">
      <div className="mb-4">
        <h3 className="text-[14px] font-semibold text-ink tracking-[-0.01em]">{title}</h3>
        {description && <p className="text-[13px] text-muted mt-0.5 leading-snug">{description}</p>}
      </div>
      {children}
    </div>
  );
}

// ===== Charts =====

const GRADE_LABELS = { psa10: "PSA 10", psa9: "PSA 9", psa8: "PSA 8", psa7orLower: "PSA ≤7" };

// Diverging horizontal bar centered on zero
function DivergingBar({ value, max }) {
  const pct = max > 0 ? (Math.abs(value) / max) * 50 : 0;
  const positive = value >= 0;
  return (
    <div className="relative h-2">
      <div className="absolute inset-0 rounded-full bg-subtle" />
      <div className="absolute inset-y-[-3px] left-1/2 w-px bg-line-strong" />
      <div
        className={`absolute inset-y-0 rounded-full ${positive ? "bg-pos/70" : "bg-neg/70"}`}
        style={positive ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${pct}%` }}
      />
    </div>
  );
}

function OutcomeChart({ outcomes }) {
  const max = Math.max(...outcomes.map((o) => Math.abs(o.profit)), 1);
  return (
    <div className="px-5 pb-2">
      <div className="grid grid-cols-[64px_1fr_88px_56px] gap-4 pb-2 text-[12px] text-faint">
        <div>Grade</div>
        <div className="text-center">Loss ← → Profit</div>
        <div className="text-right">Profit</div>
        <div className="text-right">Odds</div>
      </div>
      {outcomes.map((o) => (
        <div key={o.grade} className="grid grid-cols-[64px_1fr_88px_56px] gap-4 items-center py-2.5 border-t border-line">
          <div className="text-[14px] font-medium text-ink">{GRADE_LABELS[o.grade]}</div>
          <DivergingBar value={o.profit} max={max} />
          <div className={`text-[14px] font-medium text-right tabular-nums ${o.profit >= 0 ? "text-pos" : "text-neg"}`}>
            {fmtSigned$(o.profit)}
          </div>
          <div className="text-[14px] text-muted text-right tabular-nums">{(o.prob * 100).toFixed(1)}%</div>
        </div>
      ))}
    </div>
  );
}

// ===== Stress test (sensitivity to PSA 10 rate) =====
function StressTest({ baseInputs }) {
  const points = [];
  for (let p10 = 0; p10 <= 100; p10 += 2) {
    const others = 100 - p10;
    const oldOthers = baseInputs.gradeProbabilities.psa9 + baseInputs.gradeProbabilities.psa8 + baseInputs.gradeProbabilities.psa7orLower;
    const scale = oldOthers > 0 ? others / oldOthers : 0;
    const probs = {
      psa10: p10,
      psa9: baseInputs.gradeProbabilities.psa9 * scale,
      psa8: baseInputs.gradeProbabilities.psa8 * scale,
      psa7orLower: baseInputs.gradeProbabilities.psa7orLower * scale,
    };
    const result = computeEV({ ...baseInputs, gradeProbabilities: probs });
    points.push({ p10, ev: result.ev });
  }
  const maxEV = Math.max(...points.map((p) => Math.abs(p.ev)), 1);
  const breakEvenPoint = points.find((p) => p.ev >= 0);
  const currentP10 = baseInputs.gradeProbabilities.psa10;
  const currentEV = points.find((p) => p.p10 === Math.round(currentP10 / 2) * 2)?.ev || 0;

  const w = 100, h = 100;
  const yScale = (ev) => h / 2 - (ev / maxEV) * (h / 2 - 8);
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${(p.p10 / 100) * w} ${yScale(p.ev)}`).join(" ");
  const areaD = `${pathD} L ${w} ${h / 2} L 0 ${h / 2} Z`;
  const headroom = breakEvenPoint ? currentP10 - breakEvenPoint.p10 : null;

  return (
    <Card>
      <CardHeader
        title="Sensitivity to PSA 10 rate"
        subtitle="How expected value changes if your gem rate is higher or lower than modeled"
        right={<Pill tone={signTone(currentEV)}>{fmtSigned$(currentEV)}</Pill>}
      />
      <div className="px-5">
        <div className="relative h-52">
          <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full overflow-visible">
            <defs>
              <linearGradient id="stress-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: col("accent", 0.22) }} />
                <stop offset="50%" style={{ stopColor: col("accent", 0.04) }} />
                <stop offset="100%" style={{ stopColor: col("accent", 0.22) }} />
              </linearGradient>
            </defs>
            {[0, 25, 75, 100].map((y) => (
              <line key={y} x1="0" y1={y} x2={w} y2={y} style={{ stroke: col("line") }} strokeWidth="1" vectorEffect="non-scaling-stroke" />
            ))}
            <line x1="0" y1={h / 2} x2={w} y2={h / 2} style={{ stroke: col("line-strong") }} strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <path d={areaD} fill="url(#stress-fill)" />
            <path d={pathD} fill="none" style={{ stroke: col("accent") }} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {breakEvenPoint && (
              <line x1={breakEvenPoint.p10} y1="0" x2={breakEvenPoint.p10} y2={h} style={{ stroke: col("faint") }} strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            )}
            <line x1={currentP10} y1="0" x2={currentP10} y2={h} style={{ stroke: col("accent", 0.5) }} strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </svg>

          {/* Current position dot */}
          <div
            className="absolute w-3 h-3 rounded-full bg-accent ring-[3px] ring-surface -translate-x-1/2 -translate-y-1/2 shadow"
            style={{ left: `${Math.min(100, Math.max(0, currentP10))}%`, top: `${yScale(currentEV)}%` }}
          />
          {breakEvenPoint && (
            <div
              className="absolute top-1 translate-x-1.5 px-1.5 py-0.5 rounded-md bg-surface ring-1 ring-line text-[11px] text-muted tabular-nums whitespace-nowrap"
              style={{ left: `${breakEvenPoint.p10}%` }}
            >
              Break-even {breakEvenPoint.p10}%
            </div>
          )}

          <div className="absolute top-1 left-1.5 text-[11px] text-faint tabular-nums">+{fmt$(maxEV)}</div>
          <div className="absolute top-1/2 left-1.5 -translate-y-[calc(100%+2px)] text-[11px] text-faint">$0</div>
          <div className="absolute bottom-1 left-1.5 text-[11px] text-faint tabular-nums">-{fmt$(maxEV)}</div>
        </div>
        <div className="flex justify-between pt-2 text-[11px] text-faint tabular-nums">
          <span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100% PSA 10 rate</span>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-px bg-line border-t border-line mt-4 rounded-b-xl overflow-hidden">
        <Stat label="Your rate" value={`${currentP10.toFixed(1)}%`} />
        <Stat label="Break-even" value={breakEvenPoint ? `${breakEvenPoint.p10}%` : "N/A"} />
        <Stat
          label="Headroom"
          value={headroom !== null ? `${headroom > 0 ? "+" : ""}${headroom.toFixed(1)} pts` : "—"}
          tone={headroom !== null && headroom > 0 ? "pos" : "neg"}
        />
      </div>
    </Card>
  );
}

// ===== Cost / Revenue P&L statement =====
function CostWaterfall({ rawCost, salesTaxPct, buyShippingCost, gradingCost, shippingCost, sellFeePct, result, ownsCard }) {
  const tax = rawCost * salesTaxPct / 100;
  const expectedGross = result.outcomes.reduce((s, o) => s + o.prob * o.grossPrice, 0);
  const sellFee = expectedGross * sellFeePct / 100;

  let bars;
  if (ownsCard) {
    bars = [
      { label: "Graded sale (expected)", value: expectedGross, type: "rev" },
      { label: "Sell fees", value: -sellFee, type: "cost" },
      { label: "Grading", value: -gradingCost, type: "cost" },
      { label: "Round-trip shipping", value: -shippingCost, type: "cost" },
      { label: "Raw sale forgone", value: -rawCost * (1 - sellFeePct / 100), type: "alt" },
    ];
  } else {
    bars = [
      { label: "Graded sale (expected)", value: expectedGross, type: "rev" },
      { label: "Sell fees", value: -sellFee, type: "cost" },
      { label: "Raw card", value: -rawCost, type: "cost" },
      { label: "Sales tax", value: -tax, type: "cost" },
      { label: "Buy shipping", value: -buyShippingCost, type: "cost" },
      { label: "Grading", value: -gradingCost, type: "cost" },
      { label: "Round-trip shipping", value: -shippingCost, type: "cost" },
    ];
  }

  const maxAbs = Math.max(...bars.map((b) => Math.abs(b.value)), 1);
  const final = bars.reduce((s, b) => s + b.value, 0);

  return (
    <Card className="flex flex-col">
      <CardHeader title="Expected P&L" subtitle="Probability-weighted, per card" />
      <div className="px-5 flex-1">
        {bars.map((bar, i) => {
          const positive = bar.value >= 0;
          return (
            <div key={i} className="grid grid-cols-[1fr_64px_80px] gap-3 items-center py-2 border-t border-line first:border-t-0">
              <div className={`text-[13px] truncate ${bar.type === "rev" ? "text-ink font-medium" : "text-ink-2"}`}>{bar.label}</div>
              <div className="h-1.5 rounded-full bg-subtle overflow-hidden flex justify-end">
                <div className={`h-full rounded-full ${positive ? "bg-pos/70" : "bg-neg/60"}`} style={{ width: `${(Math.abs(bar.value) / maxAbs) * 100}%` }} />
              </div>
              <div className={`text-[13px] text-right tabular-nums ${positive ? "text-pos" : "text-ink-2"}`}>
                {fmtSigned$(bar.value)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mx-5 mb-5 mt-2 flex items-center justify-between rounded-lg bg-subtle px-3 h-10">
        <span className="text-[13px] font-medium text-ink">Expected profit</span>
        <span className={`text-[15px] font-semibold tabular-nums ${final >= 0 ? "text-pos" : "text-neg"}`}>{fmtSigned$(final)}</span>
      </div>
    </Card>
  );
}

// ===== Risk / Reward scatter =====
function RiskRewardScatter({ outcomes }) {
  const maxProb = Math.max(...outcomes.map((o) => o.prob), 0.01);
  const maxAbsProfit = Math.max(...outcomes.map((o) => Math.abs(o.profit)), 1);

  const points = outcomes.map((o) => ({
    ...o,
    x: (o.prob / maxProb) * 72 + 16,
    y: 50 - (o.profit / maxAbsProfit) * 34,
    size: 30 + Math.sqrt(o.prob) * 40,
  }));
  const dominant = points.reduce((best, p) => (p.profit * p.prob > best.profit * best.prob ? p : best), points[0]);

  return (
    <Card className="flex flex-col">
      <CardHeader title="Risk vs. reward" subtitle="Bubble size = probability of that grade" />
      <div className="px-5 flex-1">
        <div className="relative h-56 rounded-lg overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-1/2 bg-pos/[0.04]" />
          <div className="absolute inset-x-0 bottom-0 h-1/2 bg-neg/[0.04]" />
          <div className="absolute inset-x-0 top-1/2 h-px bg-line-strong" />
          {[25, 75].map((y) => (
            <div key={y} className="absolute inset-x-0 h-px bg-line" style={{ top: `${y}%` }} />
          ))}
          <div className="absolute top-2 left-2.5 text-[11px] text-faint">Profit ↑</div>
          <div className="absolute bottom-2 left-2.5 text-[11px] text-faint">Loss ↓</div>
          <div className="absolute bottom-2 right-2.5 text-[11px] text-faint">More likely →</div>
          {points.map((p) => {
            const positive = p.profit >= 0;
            const isDominant = p.grade === dominant.grade && p.profit > 0;
            return (
              <div
                key={p.grade}
                className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full grid place-items-center text-[11px] font-semibold border transition-all ${
                  isDominant ? "ring-2 ring-accent/50 ring-offset-2 ring-offset-surface" : ""
                }`}
                style={{
                  left: `${p.x}%`,
                  top: `${p.y}%`,
                  width: p.size,
                  height: p.size,
                  background: col(positive ? "pos" : "neg", 0.14),
                  borderColor: col(positive ? "pos" : "neg", 0.45),
                  color: col(positive ? "pos" : "neg"),
                }}
                title={`${GRADE_LABELS[p.grade]}: ${(p.prob * 100).toFixed(1)}% · ${fmtSigned$(p.profit)}`}
              >
                {GRADE_LABELS[p.grade].replace("PSA ", "")}
              </div>
            );
          })}
        </div>
      </div>
      <div className="px-5 py-4 text-[13px] text-muted">
        Best risk-adjusted outcome:{" "}
        <span className="text-ink font-medium">{GRADE_LABELS[dominant.grade] || "—"}</span>
        {" · "}
        <span className="tabular-nums">{fmtPct(dominant.prob * 100)}</span> chance at{" "}
        <span className={`font-medium tabular-nums ${dominant.profit >= 0 ? "text-pos" : "text-neg"}`}>{fmtSigned$(dominant.profit)}</span>
      </div>
    </Card>
  );
}

// ===== Monte Carlo simulation =====
function MonteCarloDistribution({ outcomes, runs = 5000 }) {
  // Memoized so the histogram doesn't reshuffle on unrelated re-renders
  const sim = useMemo(() => {
    const cumulative = [];
    let acc = 0;
    for (const o of outcomes) {
      acc += o.prob;
      cumulative.push({ grade: o.grade, profit: o.profit, cum: acc });
    }

    const results = [];
    for (let i = 0; i < runs; i++) {
      const r = Math.random();
      for (const c of cumulative) {
        if (r <= c.cum) {
          results.push(c.profit);
          break;
        }
      }
    }

    const minProfit = Math.min(...results);
    const maxProfit = Math.max(...results);
    const range = maxProfit - minProfit || 1;
    const numBuckets = 30;
    const buckets = Array(numBuckets).fill(0);
    results.forEach((p) => {
      const idx = Math.min(Math.floor(((p - minProfit) / range) * numBuckets), numBuckets - 1);
      buckets[idx]++;
    });
    const maxCount = Math.max(...buckets);

    const sorted = [...results].sort((a, b) => a - b);
    const n = sorted.length;
    return {
      buckets, maxCount, minProfit, maxProfit, range, numBuckets,
      p5: sorted[Math.floor(n * 0.05)],
      p25: sorted[Math.floor(n * 0.25)],
      p50: sorted[Math.floor(n * 0.5)],
      p75: sorted[Math.floor(n * 0.75)],
      p95: sorted[Math.floor(n * 0.95)],
      mean: sorted.reduce((s, v) => s + v, 0) / n,
      winRate: (sorted.filter((v) => v > 0).length / n) * 100,
    };
  }, [outcomes, runs]);

  const { buckets, maxCount, minProfit, maxProfit, range, numBuckets, p5, p25, p50, p75, p95, mean, winRate } = sim;
  const xFor = (val) => ((val - minProfit) / range) * 100;

  const Marker = ({ value, className }) => (
    <div className={`absolute top-0 bottom-0 border-l ${className}`} style={{ left: `${xFor(value)}%` }} />
  );

  return (
    <Card>
      <CardHeader
        title="Monte Carlo simulation"
        subtitle={`${runs.toLocaleString()} simulated submissions of this card`}
        right={
          <div className="flex gap-2">
            <Pill tone={signTone(mean)}>Mean {fmtSigned$(mean)}</Pill>
            <Pill>Win rate {winRate.toFixed(0)}%</Pill>
          </div>
        }
      />
      <div className="px-5">
        <div className="relative h-44">
          <div className="absolute inset-0 flex items-end gap-[3px]">
            {buckets.map((count, i) => {
              const bucketStart = minProfit + (i / numBuckets) * range;
              const bucketEnd = minProfit + ((i + 1) / numBuckets) * range;
              const tone = bucketStart >= 0 ? "pos" : bucketStart < 0 && bucketEnd > 0 ? "faint" : "neg";
              const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
              return (
                <div
                  key={i}
                  className="flex-1 rounded-t-[3px]"
                  style={{ height: count > 0 ? `max(${pct}%, 2px)` : 0, background: col(tone, tone === "faint" ? 0.6 : 0.55) }}
                />
              );
            })}
          </div>
          {minProfit < 0 && maxProfit > 0 && <Marker value={0} className="border-line-strong" />}
          <Marker value={p5} className="border-dashed border-neg" />
          <Marker value={p50} className="border-ink" />
          <Marker value={p95} className="border-dashed border-pos" />
        </div>
        <div className="flex justify-between pt-2 text-[11px] text-faint tabular-nums border-t border-line">
          <span>{fmt$(minProfit)}</span>
          <span>{fmt$(maxProfit)}</span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-[12px] text-muted">
          <span className="inline-flex items-center gap-1.5"><span className="w-3 border-t border-dashed border-neg" />5th percentile</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-3 border-t border-ink" />Median</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-3 border-t border-dashed border-pos" />95th percentile</span>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-px bg-line border-t border-line mt-4 rounded-b-xl overflow-hidden">
        <Stat label="Worst 5% (VaR)" value={fmtSigned$(Math.round(p5))} tone={signTone(p5)} />
        <Stat label="25th pct" value={fmtSigned$(Math.round(p25))} tone={signTone(p25)} />
        <Stat label="Median" value={fmtSigned$(Math.round(p50))} tone={signTone(p50)} />
        <Stat label="75th pct" value={fmtSigned$(Math.round(p75))} tone={signTone(p75)} />
        <Stat label="Best 5%" value={fmtSigned$(Math.round(p95))} tone={signTone(p95)} />
      </div>
    </Card>
  );
}

// Stacked bar of the probabilities actually being used
function ProbabilityBar({ probabilities }) {
  const segs = [
    { key: "psa10", label: "PSA 10", a: 1 },
    { key: "psa9", label: "PSA 9", a: 0.6 },
    { key: "psa8", label: "PSA 8", a: 0.35 },
    { key: "psa7orLower", label: "≤7", a: 0.15 },
  ];
  return (
    <div>
      <div className="flex h-2 rounded-full overflow-hidden bg-subtle gap-[2px]">
        {segs.map((s) => (
          <div key={s.key} style={{ width: `${Math.max(0, probabilities[s.key])}%`, background: col("accent", s.a) }} />
        ))}
      </div>
      <div className="grid grid-cols-4 gap-2 mt-3">
        {segs.map((s) => (
          <div key={s.key}>
            <div className="flex items-center gap-1.5 text-[12px] text-muted">
              <span className="w-2 h-2 rounded-sm" style={{ background: col("accent", s.a) }} />
              {s.label}
            </div>
            <div className="text-[14px] font-medium text-ink tabular-nums mt-0.5">{probabilities[s.key].toFixed(1)}%</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ===== Main app =====
export default function CardGradingEV() {
  const [cardName, setCardName] = useState("");
  const [cardImage, setCardImage] = useState(""); // data URL or http URL
  const [ownsCard, setOwnsCard] = useState(false); // false = buying to grade, true = already owns
  const [rawCost, setRawCost] = useState(50);
  const [salesTaxPct, setSalesTaxPct] = useState(8);
  const [buyShippingCost, setBuyShippingCost] = useState(5);
  const [tierId, setTierId] = useState("standard");
  const [shippingCost, setShippingCost] = useState(15);
  const [cardsInSubmission, setCardsInSubmission] = useState(1);
  const [sellFeePct, setSellFeePct] = useState(13);

  const [pricePSA10, setPricePSA10] = useState(400);
  const [pricePSA9, setPricePSA9] = useState(120);
  const [pricePSA8, setPricePSA8] = useState(60);
  const [priceLower, setPriceLower] = useState(40);

  const [usePopReport, setUsePopReport] = useState(true);
  const [popPSA10, setPopPSA10] = useState(450);
  const [popPSA9, setPopPSA9] = useState(900);
  const [popPSA8, setPopPSA8] = useState(200);
  const [popLower, setPopLower] = useState(50);
  const [biasHaircut, setBiasHaircut] = useState(35);

  const [manualP10, setManualP10] = useState(25);
  const [manualP9, setManualP9] = useState(55);
  const [manualP8, setManualP8] = useState(15);
  const [manualPLower, setManualPLower] = useState(5);

  const [watchlist, setWatchlist] = useState([]);
  const [activeTab, setActiveTab] = useState("input");

  // Submission builder state
  const [submission, setSubmission] = useState([]);
  const [submissionTier, setSubmissionTier] = useState("standard");
  const [submissionShipping, setSubmissionShipping] = useState(15);
  const [submissionSellFee, setSubmissionSellFee] = useState(13);

  // Scanner state
  const [scanResults, setScanResults] = useState([]);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [scanFilter, setScanFilter] = useState("all"); // all, basketball, football
  const [scanLastUpdated, setScanLastUpdated] = useState(null);
  const [customQuery, setCustomQuery] = useState("");
  const [customScanLoading, setCustomScanLoading] = useState(false);

  // Load watchlist from browser localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem("watchlist");
      if (stored) setWatchlist(JSON.parse(stored));
      const sub = localStorage.getItem("submission");
      if (sub) setSubmission(JSON.parse(sub));
      const subSettings = localStorage.getItem("submissionSettings");
      if (subSettings) {
        const s = JSON.parse(subSettings);
        if (s.tier && PSA_TIERS.some((t) => t.id === s.tier)) setSubmissionTier(s.tier);
        if (s.shipping !== undefined) setSubmissionShipping(s.shipping);
        if (s.sellFee !== undefined) setSubmissionSellFee(s.sellFee);
      }
      const cachedScan = localStorage.getItem("scanResults");
      if (cachedScan) {
        const c = JSON.parse(cachedScan);
        if (c.results) setScanResults(c.results);
        if (c.scannedAt) setScanLastUpdated(c.scannedAt);
      }
    } catch (e) {}
  }, []);

  // --- Scanner functions ---
  const runScan = async () => {
    setScanLoading(true);
    setScanError(null);
    try {
      const sportParam = scanFilter !== "all" ? `?sport=${scanFilter}` : "";
      const resp = await fetch(`/api/scan${sportParam}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error || `Scanner returned ${resp.status}`);
      }
      const data = await resp.json();
      setScanResults(data.results || []);
      setScanLastUpdated(data.scannedAt);
      try {
        localStorage.setItem("scanResults", JSON.stringify(data));
      } catch (e) {}
    } catch (err) {
      setScanError(err.message);
    } finally {
      setScanLoading(false);
    }
  };

  const scanCustomCard = async () => {
    if (!customQuery.trim()) return;
    setCustomScanLoading(true);
    setScanError(null);
    try {
      const resp = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: customQuery.trim() }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error || `Scanner returned ${resp.status}`);
      }
      const data = await resp.json();
      // Prepend the custom card result to existing results
      if (data.result) {
        const updated = [data.result, ...scanResults];
        setScanResults(updated);
        try {
          localStorage.setItem("scanResults", JSON.stringify({ results: updated, scannedAt: new Date().toISOString() }));
        } catch (e) {}
      }
      setCustomQuery("");
    } catch (err) {
      setScanError(err.message);
    } finally {
      setCustomScanLoading(false);
    }
  };

  // Load a scanner result into the calculator for deeper review
  const loadIntoCalculator = (result) => {
    setCardName(`${result.year || ""} ${result.set || ""} ${result.player || ""}`.trim());
    setRawCost(result.prices?.raw?.median || 50);
    setPricePSA10(result.prices?.psa10?.median || 400);
    setPricePSA9(result.prices?.psa9?.median || 120);
    setActiveTab("input");
  };

  const tier = PSA_TIERS.find((t) => t.id === tierId) || PSA_TIERS[0];

  const probabilities = useMemo(() => {
    if (usePopReport) {
      return adjustPopReport({ popPSA10, popPSA9, popPSA8, popLower, biasHaircut });
    }
    return { psa10: manualP10, psa9: manualP9, psa8: manualP8, psa7orLower: manualPLower };
  }, [usePopReport, popPSA10, popPSA9, popPSA8, popLower, biasHaircut, manualP10, manualP9, manualP8, manualPLower]);

  const probSum = probabilities.psa10 + probabilities.psa9 + probabilities.psa8 + probabilities.psa7orLower;
  const probsValid = Math.abs(probSum - 100) < 0.5;

  const perCardShipping = useMemo(
    () => shippingCost / Math.max(1, cardsInSubmission),
    [shippingCost, cardsInSubmission]
  );

  const result = useMemo(
    () =>
      computeEV({
        rawCost,
        salesTaxPct,
        buyShippingCost,
        ownsCard,
        gradeProbabilities: probabilities,
        gradePrices: { psa10: pricePSA10, psa9: pricePSA9, psa8: pricePSA8, psa7orLower: priceLower },
        gradingCost: tier.cost,
        shippingCost: perCardShipping,
        sellFeePct,
      }),
    [rawCost, salesTaxPct, buyShippingCost, ownsCard, probabilities, pricePSA10, pricePSA9, pricePSA8, priceLower, tier.cost, perCardShipping, sellFeePct]
  );

  const evTone = result.ev > 50 ? "positive" : result.ev < 0 ? "negative" : "warning";

  const saveToWatchlist = async () => {
    if (!cardName.trim()) return;
    const entry = {
      id: Date.now(),
      name: cardName,
      image: cardImage || "",
      rawCost,
      tier: tier.name,
      mode: ownsCard ? "owns" : "buy",
      ev: result.ev,
      roi: result.roi,
      probOfLoss: result.probOfLoss,
      sharpe: result.sharpe,
      p10Rate: probabilities.psa10,
      timestamp: new Date().toISOString(),
    };
    const updated = [entry, ...watchlist].slice(0, 50);
    setWatchlist(updated);
    try {
      localStorage.setItem("watchlist", JSON.stringify(updated));
    } catch (e) {}
  };

  const removeFromWatchlist = async (id) => {
    const updated = watchlist.filter((w) => w.id !== id);
    setWatchlist(updated);
    try {
      localStorage.setItem("watchlist", JSON.stringify(updated));
    } catch (e) {}
  };

  // --- Submission helpers ---
  const saveSubmission = (next) => {
    try { localStorage.setItem("submission", JSON.stringify(next)); } catch (e) {}
  };
  const saveSubmissionSettings = (next) => {
    try { localStorage.setItem("submissionSettings", JSON.stringify(next)); } catch (e) {}
  };

  const addToSubmission = () => {
    const newCard = {
      id: Date.now(),
      name: cardName || "Untitled card",
      image: cardImage || "",
      rawCost,
      ownsCard,
      pricePSA10,
      pricePSA9,
      pricePSA8,
      priceLower,
      pPSA10: probabilities.psa10,
      pPSA9: probabilities.psa9,
      pPSA8: probabilities.psa8,
      pLower: probabilities.psa7orLower,
    };
    const updated = [newCard, ...submission];
    setSubmission(updated);
    saveSubmission(updated);
  };

  const removeFromSubmission = (id) => {
    const updated = submission.filter((c) => c.id !== id);
    setSubmission(updated);
    saveSubmission(updated);
  };

  const updateSubmissionCard = (id, field, value) => {
    const updated = submission.map((c) => c.id === id ? { ...c, [field]: value } : c);
    setSubmission(updated);
    saveSubmission(updated);
  };

  const clearSubmission = () => {
    if (!confirm("Clear all cards from submission?")) return;
    setSubmission([]);
    saveSubmission([]);
  };

  const updateSubmissionSetting = (key, value) => {
    if (key === "tier") setSubmissionTier(value);
    else if (key === "shipping") setSubmissionShipping(value);
    else if (key === "sellFee") setSubmissionSellFee(value);
    saveSubmissionSettings({
      tier: key === "tier" ? value : submissionTier,
      shipping: key === "shipping" ? value : submissionShipping,
      sellFee: key === "sellFee" ? value : submissionSellFee,
    });
  };

  // Compute per-card and aggregate stats for the submission
  const submissionResults = useMemo(() => {
    const submissionTierObj = PSA_TIERS.find((t) => t.id === submissionTier) || PSA_TIERS[0];
    const n = submission.length;
    const perCardShip = n > 0 ? submissionShipping / n : submissionShipping;

    const cardResults = submission.map((c) => {
      const probs = { psa10: c.pPSA10, psa9: c.pPSA9, psa8: c.pPSA8, psa7orLower: c.pLower };
      const prices = { psa10: c.pricePSA10, psa9: c.pricePSA9, psa8: c.pricePSA8, psa7orLower: c.priceLower };
      const costs = {
        rawCost: c.rawCost,
        salesTaxPct: c.ownsCard ? 0 : 8, // submission builder uses 8% default
        buyShippingCost: c.ownsCard ? 0 : 5,
        ownsCard: c.ownsCard,
        gradeProbabilities: probs,
        gradePrices: prices,
        gradingCost: submissionTierObj.cost,
        shippingCost: perCardShip,
        sellFeePct: submissionSellFee,
      };
      const r = computeEV(costs);
      return { ...c, result: r };
    });

    const totalEV = cardResults.reduce((s, c) => s + c.result.ev, 0);
    const totalCost = cardResults.reduce((s, c) => s + c.result.totalCost + (c.result.opportunityCost || 0), 0);
    const totalVariance = cardResults.reduce((s, c) => s + Math.pow(c.result.stdDev, 2), 0); // assumes independence
    const totalStdDev = Math.sqrt(totalVariance);
    const aggSharpe = totalStdDev > 0 ? totalEV / totalStdDev : 0;
    const totalProbLossWeighted = cardResults.length > 0
      ? cardResults.reduce((s, c) => s + c.result.probOfLoss, 0) / cardResults.length
      : 0;
    const aggROI = totalCost > 0 ? (totalEV / totalCost) * 100 : 0;

    return {
      cardResults,
      totalEV,
      totalCost,
      totalStdDev,
      aggSharpe,
      avgProbLoss: totalProbLossWeighted,
      aggROI,
      perCardShip,
      tier: submissionTierObj,
    };
  }, [submission, submissionTier, submissionShipping, submissionSellFee]);

  const verdict = VERDICTS[result.verdict] || VERDICTS.MARGINAL;
  const evToneKey = { positive: "pos", negative: "neg", warning: "warn" }[evTone];
  const atRisk = result.totalCost + (result.opportunityCost || 0);
  const costLine = ownsCard
    ? `$${tier.cost.toFixed(2)} grading + $${perCardShipping.toFixed(2)} shipping · giving up $${(rawCost * (1 - sellFeePct / 100)).toFixed(2)} raw sale`
    : `$${rawCost.toFixed(2)} card + $${(rawCost * salesTaxPct / 100).toFixed(2)} tax + $${buyShippingCost.toFixed(2)} shipping + $${tier.cost.toFixed(2)} grading + $${perCardShipping.toFixed(2)} return shipping`;

  const tabs = [
    { id: "input", label: "Calculator" },
    { id: "scanner", label: "Scanner" },
    { id: "submission", label: "Submission", count: submission.length },
    { id: "watchlist", label: "Watchlist", count: watchlist.length },
    { id: "guide", label: "Method" },
  ];

  const okScans = [...scanResults].filter((r) => r.status === "ok").sort((a, b) => (b.sharpe || 0) - (a.sharpe || 0));
  const skippedScans = scanResults.filter((r) => r.status !== "ok");

  return (
    <div className="min-h-screen bg-bg text-ink">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-bg/80 backdrop-blur-xl backdrop-saturate-150 border-b border-line">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-6 h-14 flex items-center gap-4 sm:gap-8">
          <button onClick={() => setActiveTab("input")} className="flex items-center gap-2 shrink-0">
            <Logo />
            <span className="hidden sm:inline text-[15px] font-semibold tracking-[-0.02em]">Cardstack</span>
          </button>
          <nav className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto no-scrollbar">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`h-8 px-3 rounded-lg text-[13px] font-medium whitespace-nowrap transition-colors inline-flex items-center gap-1.5 ${
                  activeTab === t.id ? "text-ink bg-subtle" : "text-muted hover:text-ink"
                }`}
              >
                {t.label}
                {t.count > 0 && (
                  <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-line text-[11px] text-ink-2 tabular-nums grid place-items-center">
                    {t.count}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <ThemeToggle />
        </div>
      </header>

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 pt-10 pb-16">
        {/* ===================== CALCULATOR ===================== */}
        {activeTab === "input" && (
          <>
            <PageHeader
              title="Should you grade it?"
              description="Enter your costs, sold comps and grade odds. Cardstack prices every outcome and tells you whether the submission is worth the risk."
            />
            <div className="grid grid-cols-1 lg:grid-cols-[380px_minmax(0,1fr)] gap-6 items-start">
              {/* LEFT: Inputs */}
              <div className="space-y-4">
                <Card className="divide-y divide-line">
                  <FormSection title="Card">
                    <div className="space-y-4">
                      <TextField label="Description" value={cardName} onChange={setCardName} placeholder="2018 Prizm Luka Dončić #280" />
                      <CardImageInput value={cardImage} onChange={setCardImage} />
                      <div>
                        <Label>Scenario</Label>
                        <Segmented
                          value={ownsCard}
                          onChange={setOwnsCard}
                          options={[
                            { value: false, label: "Buying to grade" },
                            { value: true, label: "Already own it" },
                          ]}
                        />
                        <p className="mt-2 text-[12px] text-muted leading-snug">
                          {ownsCard
                            ? "Compares grading and selling against selling raw today. What you originally paid is a sunk cost."
                            : "Compares buying raw, grading and selling against doing nothing."}
                        </p>
                      </div>
                    </div>
                  </FormSection>

                  {!ownsCard ? (
                    <FormSection title="Buy costs">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="col-span-2">
                          <NumField label="Raw price" value={rawCost} onChange={setRawCost} prefix="$" />
                        </div>
                        <NumField label="Sales tax" value={salesTaxPct} onChange={setSalesTaxPct} suffix="%" hint="by state" />
                        <NumField label="Shipping to you" value={buyShippingCost} onChange={setBuyShippingCost} prefix="$" />
                      </div>
                      <div className="mt-3">
                        <SummaryRow label="All-in buy cost" value={`$${(rawCost + rawCost * salesTaxPct / 100 + buyShippingCost).toFixed(2)}`} />
                      </div>
                    </FormSection>
                  ) : (
                    <FormSection title="Opportunity cost" description="Grading means giving up the chance to sell raw at this price.">
                      <NumField label="Raw sell price today" value={rawCost} onChange={setRawCost} prefix="$" hint="what it'd sell for" />
                    </FormSection>
                  )}

                  <FormSection title="Grading & selling">
                    <div className="space-y-3">
                      <div>
                        <Label>PSA service level</Label>
                        <Select
                          value={tierId}
                          onChange={(e) => {
                            const newTier = e.target.value;
                            setTierId(newTier);
                          }}
                        >
                          {PSA_TIERS.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name} — ${t.cost}
                            </option>
                          ))}
                        </Select>
                        <p className="mt-1.5 text-[12px] text-muted">
                          Up to ${tier.maxValue.toLocaleString()} insured value · {tier.turnaround}
                          {tier.note && <> · {tier.note}</>}
                        </p>
                      </div>
                      {pricePSA10 > tier.maxValue && (
                        <Callout tone="warn">
                          PSA 10 price (${pricePSA10}) is above this tier's ${tier.maxValue.toLocaleString()} insured value. PSA may bump you up a tier.
                        </Callout>
                      )}
                      <div className="grid grid-cols-2 gap-3">
                        <NumField label="Batch shipping" value={shippingCost} onChange={setShippingCost} prefix="$" hint="round trip" />
                        <NumField label="Sell fee" value={sellFeePct} onChange={setSellFeePct} suffix="%" hint="eBay ≈13%" />
                        <NumField label="Cards in batch" value={cardsInSubmission} onChange={(v) => setCardsInSubmission(Math.max(1, Math.round(v)))} step="1" />
                        <div className="flex flex-col justify-end">
                          <SummaryRow label="Per card" value={`$${perCardShipping.toFixed(2)}`} />
                        </div>
                      </div>
                    </div>
                  </FormSection>

                  <FormSection title="Sold comps" description="Median of the last 90 days from 130point or eBay sold. Skip outlier highs.">
                    <div className="grid grid-cols-2 gap-3">
                      <NumField label="PSA 10" value={pricePSA10} onChange={setPricePSA10} prefix="$" />
                      <NumField label="PSA 9" value={pricePSA9} onChange={setPricePSA9} prefix="$" />
                      <NumField label="PSA 8" value={pricePSA8} onChange={setPricePSA8} prefix="$" />
                      <NumField label="PSA 7 or lower" value={priceLower} onChange={setPriceLower} prefix="$" />
                    </div>
                  </FormSection>

                  <FormSection title="Grade odds">
                    <Segmented
                      value={usePopReport}
                      onChange={setUsePopReport}
                      options={[
                        { value: true, label: "From pop report" },
                        { value: false, label: "Set manually" },
                      ]}
                    />
                    <div className="mt-4">
                      {usePopReport ? (
                        <div className="space-y-3">
                          <div className="grid grid-cols-2 gap-3">
                            <NumField label="Pop · PSA 10" value={popPSA10} onChange={setPopPSA10} step="1" />
                            <NumField label="Pop · PSA 9" value={popPSA9} onChange={setPopPSA9} step="1" />
                            <NumField label="Pop · PSA 8" value={popPSA8} onChange={setPopPSA8} step="1" />
                            <NumField label="Pop · ≤7" value={popLower} onChange={setPopLower} step="1" />
                          </div>
                          <NumField label="Selection-bias haircut" value={biasHaircut} onChange={setBiasHaircut} suffix="%" hint="default 35%" />
                          <p className="text-[12px] text-muted leading-snug">
                            Pop reports overstate gem rates because people only submit their best copies. The haircut adjusts toward what a random raw copy would grade.
                          </p>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-3">
                          <NumField label="PSA 10" value={manualP10} onChange={setManualP10} suffix="%" />
                          <NumField label="PSA 9" value={manualP9} onChange={setManualP9} suffix="%" />
                          <NumField label="PSA 8" value={manualP8} onChange={setManualP8} suffix="%" />
                          <NumField label="PSA ≤7" value={manualPLower} onChange={setManualPLower} suffix="%" />
                        </div>
                      )}
                    </div>

                    <div className="mt-5 pt-4 border-t border-line">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-[13px] font-medium text-ink-2">Odds used in the model</span>
                        {probsValid ? (
                          <span className="inline-flex items-center gap-1 text-[12px] text-muted tabular-nums">
                            <Check size={13} className="text-pos" /> {probSum.toFixed(1)}%
                          </span>
                        ) : (
                          <Pill tone="neg">{probSum.toFixed(1)}% · must total 100</Pill>
                        )}
                      </div>
                      <ProbabilityBar probabilities={probabilities} />
                    </div>
                  </FormSection>
                </Card>

                <div className="grid grid-cols-2 gap-2">
                  <Button variant="secondary" onClick={saveToWatchlist} disabled={!cardName.trim()} title={!cardName.trim() ? "Add a description first" : ""}>
                    <Bookmark size={15} /> Save
                  </Button>
                  <Button onClick={addToSubmission}>
                    <Package size={15} /> Add to batch
                  </Button>
                </div>
              </div>

              {/* RIGHT: Results */}
              <div className="space-y-4 order-first lg:order-none">
                <Card className="overflow-hidden">
                  <div className="p-6 sm:p-7">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0">
                        {cardImage && <img src={cardImage} alt="" className="w-10 h-14 object-cover rounded-md ring-1 ring-line shrink-0" />}
                        <div className="min-w-0">
                          <div className="text-[13px] text-muted">{ownsCard ? "Grading decision" : "Evaluating purchase"}</div>
                          <div className="text-[15px] font-medium text-ink truncate">{cardName || "Untitled card"}</div>
                        </div>
                      </div>
                      <VerdictPill code={result.verdict} />
                    </div>

                    <div className="mt-7">
                      <div className="text-[13px] text-muted">Expected profit per card</div>
                      <div className={`mt-1 text-[44px] sm:text-[56px] leading-[1.05] font-semibold tracking-[-0.04em] tabular-nums ${TONE_TEXT[evToneKey]}`}>
                        {fmtSigned$(result.ev)}
                      </div>
                      <p className="mt-3 text-[15px] text-ink-2 max-w-xl leading-relaxed">{verdict.blurb}</p>
                      <p className="mt-2 text-[12px] text-faint tabular-nums leading-relaxed">{costLine}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-line border-t border-line">
                    <Stat label="Return on risk" value={fmtPct(result.roi)} sub={`on ${fmt$Full(atRisk)}`} tone={result.roi > 0 ? "pos" : "neg"} />
                    <Stat label="Sharpe ratio" value={result.sharpe.toFixed(2)} sub="EV ÷ volatility" tone={sharpeTone(result.sharpe)} />
                    <Stat
                      label="Chance of loss"
                      value={fmtPct(result.probOfLoss * 100)}
                      tone={result.probOfLoss > 0.5 ? "neg" : result.probOfLoss > 0.3 ? "warn" : "pos"}
                    />
                    <Stat label="Volatility" value={`±${fmt$(result.stdDev)}`} sub="Std. dev. of profit" />
                    <Stat
                      label="Break-even PSA 10 rate"
                      value={result.breakEven10Rate !== null ? fmtPct(result.breakEven10Rate) : "N/A"}
                      sub={result.breakEven10Rate !== null ? `You're modeling ${probabilities.psa10.toFixed(1)}%` : "Profitable in every outcome"}
                      tone={
                        result.breakEven10Rate === null
                          ? "pos"
                          : probabilities.psa10 > result.breakEven10Rate
                          ? "pos"
                          : "neg"
                      }
                    />
                    <Stat label="Expected net sale" value={fmt$Full(result.evPlusCost)} sub="after fees" />
                  </div>
                </Card>

                <Card>
                  <CardHeader title="Profit by grade" subtitle="Net of fees and all costs" right={<span className="text-[12px] text-faint">{tier.name} · ${tier.cost}</span>} />
                  <OutcomeChart outcomes={result.outcomes} />
                </Card>
              </div>
            </div>

            {/* Deeper analysis */}
            <div className="mt-14">
              <div className="mb-5">
                <h2 className="text-[20px] font-semibold tracking-[-0.02em]">Risk analysis</h2>
                <p className="text-[14px] text-muted mt-1">Where the money comes from, and how wide the range of outcomes is.</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <CostWaterfall
                  rawCost={rawCost}
                  salesTaxPct={salesTaxPct}
                  buyShippingCost={buyShippingCost}
                  gradingCost={tier.cost}
                  shippingCost={perCardShipping}
                  sellFeePct={sellFeePct}
                  result={result}
                  ownsCard={ownsCard}
                />
                <RiskRewardScatter outcomes={result.outcomes} />
                <div className="md:col-span-2">
                  <MonteCarloDistribution outcomes={result.outcomes} />
                </div>
                <div className="md:col-span-2">
                  <StressTest
                    baseInputs={{
                      rawCost,
                      salesTaxPct,
                      buyShippingCost,
                      ownsCard,
                      gradeProbabilities: probabilities,
                      gradePrices: { psa10: pricePSA10, psa9: pricePSA9, psa8: pricePSA8, psa7orLower: priceLower },
                      gradingCost: tier.cost,
                      shippingCost: perCardShipping,
                      sellFeePct,
                    }}
                  />
                </div>
              </div>
            </div>
          </>
        )}

        {/* ===================== SCANNER ===================== */}
        {activeTab === "scanner" && (
          <div>
            <PageHeader
              title="Scanner"
              description="Scan modern basketball and football rookies and rank them by risk-adjusted return. Results are estimates, so verify against 130point before grading."
              actions={
                <Button onClick={runScan} disabled={scanLoading}>
                  {scanLoading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                  {scanLoading ? "Scanning…" : scanResults.length > 0 ? "Rescan" : "Run scan"}
                </Button>
              }
            />

            <Card className="p-4 mb-4 flex flex-col md:flex-row gap-3 md:items-center">
              <div className="md:w-[340px] shrink-0">
                <Segmented
                  value={scanFilter}
                  onChange={setScanFilter}
                  options={[
                    { value: "all", label: "All" },
                    { value: "basketball", label: "Basketball" },
                    { value: "football", label: "Football" },
                  ]}
                />
              </div>
              <div className="flex gap-2 flex-1">
                <div className="relative flex-1">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
                  <input
                    type="text"
                    value={customQuery}
                    onChange={(e) => setCustomQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && scanCustomCard()}
                    placeholder="Scan a specific card, e.g. 2023 Prizm CJ Stroud 339"
                    className={`${inputCls} pl-9 pr-3`}
                  />
                </div>
                <Button variant="secondary" onClick={scanCustomCard} disabled={customScanLoading || !customQuery.trim()}>
                  {customScanLoading && <Loader2 size={14} className="animate-spin" />}
                  Scan
                </Button>
              </div>
            </Card>

            {scanError && (
              <div className="mb-4">
                <Callout tone="neg">
                  <div className="font-medium">The scanner hit an error</div>
                  <div className="opacity-80 mt-0.5">{scanError}</div>
                </Callout>
              </div>
            )}

            {scanLastUpdated && (
              <div className="mb-3 flex items-center justify-between text-[12px] text-muted tabular-nums">
                <span>Updated {new Date(scanLastUpdated).toLocaleString()}</span>
                <span>{okScans.length} priced · {skippedScans.length} skipped</span>
              </div>
            )}

            {scanResults.length === 0 ? (
              <EmptyState
                icon={Radar}
                title="No scan results yet"
                description="Run a scan to pull current eBay prices and rank cards by expected return."
                action={<Button variant="secondary" onClick={runScan} disabled={scanLoading}><RefreshCw size={15} /> Run scan</Button>}
              />
            ) : (
              <>
                <Table
                  cols="minmax(0,2.2fr) repeat(6,minmax(0,1fr)) 72px"
                  minWidth={880}
                  head={
                    <>
                      <div>Card</div>
                      <div className="text-right">Raw</div>
                      <div className="text-right">PSA 9</div>
                      <div className="text-right">PSA 10</div>
                      <div className="text-right">EV</div>
                      <div className="text-right">Sharpe</div>
                      <div className="text-right">Verdict</div>
                      <div />
                    </>
                  }
                >
                  {okScans.map((r) => (
                    <Row key={r.id} cols="minmax(0,2.2fr) repeat(6,minmax(0,1fr)) 72px" className="group">
                      <div className="min-w-0">
                        <div className="text-ink font-medium truncate">{r.player}</div>
                        <div className="text-[12px] text-muted truncate">
                          {r.year} {r.set} {r.cardNumber && `#${r.cardNumber}`} · <span className="capitalize">{r.sport}</span>
                        </div>
                      </div>
                      <div className="text-right tabular-nums text-ink-2">${r.prices?.raw?.median?.toFixed(0) || "—"}</div>
                      <div className="text-right tabular-nums text-ink-2">${r.prices?.psa9?.median?.toFixed(0) || "—"}</div>
                      <div className="text-right tabular-nums text-ink-2">${r.prices?.psa10?.median?.toFixed(0) || "—"}</div>
                      <div className={`text-right tabular-nums font-medium ${r.ev > 0 ? "text-pos" : "text-neg"}`}>{r.ev > 0 ? "+" : ""}${r.ev?.toFixed(0)}</div>
                      <div className={`text-right tabular-nums ${TONE_TEXT[sharpeTone(r.sharpe)]}`}>{r.sharpe?.toFixed(2)}</div>
                      <div className="text-right"><VerdictPill code={r.verdict} /></div>
                      <div className="text-right">
                        <Button variant="ghost" size="sm" className="px-2" onClick={() => loadIntoCalculator(r)} title="Load into calculator">
                          Open <ArrowUpRight size={14} />
                        </Button>
                      </div>
                    </Row>
                  ))}
                </Table>

                {skippedScans.length > 0 && (
                  <details className="mt-4 group">
                    <summary className="cursor-pointer text-[13px] text-muted hover:text-ink select-none list-none inline-flex items-center gap-1">
                      <ChevronDown size={14} className="transition-transform group-open:rotate-180" />
                      {skippedScans.length} skipped {skippedScans.length === 1 ? "card" : "cards"}
                    </summary>
                    <Card className="mt-2 divide-y divide-line">
                      {skippedScans.map((r) => (
                        <div key={r.id} className="flex items-center justify-between gap-4 px-5 py-2.5 text-[13px]">
                          <div className="text-ink-2 truncate">
                            {r.player} <span className="text-faint">· {r.year} {r.set}</span>
                          </div>
                          <div className="text-muted truncate text-right">{r.note}</div>
                        </div>
                      ))}
                    </Card>
                  </details>
                )}
              </>
            )}

            <div className="mt-8 max-w-3xl text-[13px] text-muted leading-relaxed space-y-2">
              <div className="text-[14px] font-medium text-ink">How the scanner works</div>
              <p>For each card, the scanner pulls current eBay listings for raw, PSA 9 and PSA 10 copies. Median asking prices are discounted about 18% to approximate sold prices, since active listings run higher than what actually sells.</p>
              <p>EV uses default grade odds (PSA 10: 18%, PSA 9: 55%, PSA 8: 22%, lower: 5%). For a precise read, open a card in the calculator and enter its real pop data and service level.</p>
            </div>
          </div>
        )}

        {/* ===================== SUBMISSION ===================== */}
        {activeTab === "submission" && (
          <div>
            <PageHeader
              title="Submission builder"
              description="Build a batch and see the combined expected value. Return shipping is split across every card."
              actions={
                submission.length > 0 && (
                  <Button variant="danger" size="sm" onClick={clearSubmission}>
                    <X size={14} /> Clear all
                  </Button>
                )
              }
            />

            <Card className="p-5 mb-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <Label>PSA service level</Label>
                  <Select value={submissionTier} onChange={(e) => updateSubmissionSetting("tier", e.target.value)}>
                    {PSA_TIERS.map((t) => (
                      <option key={t.id} value={t.id}>{t.name} — ${t.cost}</option>
                    ))}
                  </Select>
                </div>
                <NumField
                  label="Round-trip shipping"
                  value={submissionShipping}
                  onChange={(v) => updateSubmissionSetting("shipping", v)}
                  prefix="$"
                  hint={submission.length > 0 ? `$${submissionResults.perCardShip.toFixed(2)} per card` : "whole batch"}
                />
                <NumField
                  label="Sell fee"
                  value={submissionSellFee}
                  onChange={(v) => updateSubmissionSetting("sellFee", v)}
                  suffix="%"
                  hint="eBay ≈13%"
                />
              </div>
            </Card>

            {submission.length === 0 ? (
              <EmptyState
                icon={Package}
                title="This batch is empty"
                description="Evaluate a card in the calculator, then choose “Add to batch” to see it here."
                action={<Button variant="secondary" onClick={() => setActiveTab("input")}>Open calculator</Button>}
              />
            ) : (
              <>
                <Card className="overflow-hidden mb-6">
                  <div className="px-5 pt-5 pb-1 text-[13px] text-muted">
                    Batch totals · {submission.length} {submission.length === 1 ? "card" : "cards"}
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-line border-t border-line mt-4">
                    <Stat label="Total expected value" value={fmtSigned$(submissionResults.totalEV)} tone={submissionResults.totalEV > 0 ? "pos" : "neg"} />
                    <Stat label="Batch return" value={fmtPct(submissionResults.aggROI)} sub={`on ${fmt$Full(submissionResults.totalCost)}`} tone={submissionResults.aggROI > 0 ? "pos" : "neg"} />
                    <Stat label="Batch Sharpe" value={submissionResults.aggSharpe.toFixed(2)} sub="risk-adjusted" tone={sharpeTone(submissionResults.aggSharpe)} />
                    <Stat
                      label="Avg. chance of loss"
                      value={fmtPct(submissionResults.avgProbLoss * 100)}
                      sub="per card"
                      tone={submissionResults.avgProbLoss > 0.5 ? "neg" : submissionResults.avgProbLoss > 0.3 ? "warn" : "pos"}
                    />
                  </div>
                </Card>

                <Table
                  cols="minmax(0,2.4fr) repeat(4,minmax(0,1fr)) 40px"
                  minWidth={720}
                  head={
                    <>
                      <div>Card</div>
                      <div className="text-right">Raw</div>
                      <div className="text-right">EV</div>
                      <div className="text-right">Return</div>
                      <div className="text-right">Verdict</div>
                      <div />
                    </>
                  }
                >
                  {[...submissionResults.cardResults]
                    .sort((a, b) => (b.result.sharpe || 0) - (a.result.sharpe || 0))
                    .map((c) => {
                      const isDrag = c.result.ev < 0;
                      return (
                        <Row key={c.id} cols="minmax(0,2.4fr) repeat(4,minmax(0,1fr)) 40px" className={isDrag ? "bg-neg/[0.04]" : ""}>
                          <div className="flex items-center gap-3 min-w-0">
                            <Thumb src={c.image} />
                            <div className="min-w-0">
                              <div className="text-ink font-medium truncate">{c.name}</div>
                              <div className="text-[12px] text-muted tabular-nums">
                                {c.ownsCard ? "Already own" : "Buying"} · PSA 10 odds {c.pPSA10.toFixed(0)}%
                              </div>
                            </div>
                          </div>
                          <div className="text-right tabular-nums text-ink-2">{fmt$Full(c.rawCost)}</div>
                          <div className={`text-right tabular-nums font-medium ${c.result.ev > 0 ? "text-pos" : "text-neg"}`}>{fmtSigned$(c.result.ev)}</div>
                          <div className={`text-right tabular-nums ${c.result.roi > 0 ? "text-pos" : "text-neg"}`}>{fmtPct(c.result.roi)}</div>
                          <div className="text-right"><VerdictPill code={c.result.verdict} /></div>
                          <IconButton label="Remove from batch" onClick={() => removeFromSubmission(c.id)}>
                            <Trash2 size={15} />
                          </IconButton>
                        </Row>
                      );
                    })}
                </Table>

                {submissionResults.cardResults.some((c) => c.result.ev < 0) && (
                  <div className="mt-4">
                    <Callout tone="neg">
                      Highlighted cards have negative EV and are dragging the batch down. Removing them raises your total expected return.
                    </Callout>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ===================== WATCHLIST ===================== */}
        {activeTab === "watchlist" && (
          <div>
            <PageHeader title="Watchlist" description="Saved evaluations, ranked by Sharpe ratio. Higher means a better return for the risk." />
            {watchlist.length === 0 ? (
              <EmptyState
                icon={Bookmark}
                title="Nothing saved yet"
                description="Evaluate a card in the calculator and choose “Save” to keep it here."
                action={<Button variant="secondary" onClick={() => setActiveTab("input")}>Open calculator</Button>}
              />
            ) : (
              <Table
                cols="minmax(0,2.4fr) repeat(5,minmax(0,1fr)) 40px"
                minWidth={780}
                head={
                  <>
                    <div>Card</div>
                    <div className="text-right">Raw</div>
                    <div className="text-right">EV</div>
                    <div className="text-right">Return</div>
                    <div className="text-right">Chance of loss</div>
                    <div className="text-right">Sharpe</div>
                    <div />
                  </>
                }
              >
                {[...watchlist].sort((a, b) => b.sharpe - a.sharpe).map((w) => (
                  <Row key={w.id} cols="minmax(0,2.4fr) repeat(5,minmax(0,1fr)) 40px">
                    <div className="flex items-center gap-3 min-w-0">
                      <Thumb src={w.image} />
                      <div className="min-w-0">
                        <div className="text-ink font-medium truncate">{w.name}</div>
                        <div className="text-[12px] text-muted">{w.tier} · {new Date(w.timestamp).toLocaleDateString()}</div>
                      </div>
                    </div>
                    <div className="text-right tabular-nums text-ink-2">{fmt$Full(w.rawCost)}</div>
                    <div className={`text-right tabular-nums font-medium ${w.ev > 0 ? "text-pos" : "text-neg"}`}>{fmtSigned$(w.ev)}</div>
                    <div className={`text-right tabular-nums ${w.roi > 0 ? "text-pos" : "text-neg"}`}>{fmtPct(w.roi)}</div>
                    <div className="text-right tabular-nums text-ink-2">{fmtPct(w.probOfLoss * 100)}</div>
                    <div className={`text-right tabular-nums ${TONE_TEXT[sharpeTone(w.sharpe)]}`}>{w.sharpe.toFixed(2)}</div>
                    <IconButton label="Remove" onClick={() => removeFromWatchlist(w.id)}>
                      <Trash2 size={15} />
                    </IconButton>
                  </Row>
                ))}
              </Table>
            )}
          </div>
        )}

        {/* ===================== METHOD ===================== */}
        {activeTab === "guide" && (
          <article className="max-w-2xl">
            <PageHeader
              title="The method"
              description="Cardstack computes the risk-adjusted expected value of grading a card. It isn't a crystal ball. It forces every assumption into the open so you can argue with the math instead of your gut."
            />

            <div className="space-y-10 text-[15px] text-ink-2 leading-relaxed">
              <Section title="The core equation">
                <p>For each possible grade outcome <em>i</em>:</p>
                <div className="my-4 rounded-lg bg-subtle ring-1 ring-line px-4 py-3 font-mono text-[13px] text-ink overflow-x-auto">
                  EV = Σ P(grade<sub>i</sub>) × [Price<sub>i</sub> × (1 − fee%)] − Raw − Grading − Shipping
                </div>
                <p>
                  Positive EV is necessary but not sufficient. A coin flip with $1,000 of upside and $500 of downside has +$250 EV, but it's dangerous to size up unless you can run it many times.
                </p>
              </Section>

              <Section title="Why the bias haircut matters">
                <p>
                  The PSA pop report shows the gem rate among <em className="text-ink not-italic font-medium">cards people chose to submit</em>. Submitters pre-screen, so they don't send rough copies. The gem rate among <em className="text-ink not-italic font-medium">random raw eBay copies</em> is meaningfully lower. The default 35% haircut is a starting point. If you have your own grading history, replace it with your observed difference.
                </p>
              </Section>

              <Section title="Reading the Sharpe ratio">
                <p className="mb-4">The Sharpe ratio divides expected profit by the standard deviation of profit across outcomes. Rough guide:</p>
                <Card className="divide-y divide-line">
                  {[
                    { range: "Below 0.3", tone: "neg", text: "A coin flip with a marginal edge. Pass unless you have many shots." },
                    { range: "0.3 – 0.7", tone: "warn", text: "Workable but thin. Verify comps and watch fees." },
                    { range: "0.7 – 1.5", tone: "pos", text: "Solid. Most good submissions live here." },
                    { range: "Above 1.5", tone: "pos", text: "Suspiciously good. Recheck inputs, you may have a stale comp." },
                  ].map((r) => (
                    <div key={r.range} className="flex gap-4 px-4 py-3 text-[14px]">
                      <span className={`w-20 shrink-0 font-medium tabular-nums ${TONE_TEXT[r.tone]}`}>{r.range}</span>
                      <span className="text-ink-2">{r.text}</span>
                    </div>
                  ))}
                </Card>
              </Section>

              <Section title="What this doesn't model">
                <ul className="space-y-3">
                  {[
                    ["Time value of money.", "A $200 EV that takes six months ties up capital. Discount accordingly."],
                    ["Liquidity.", "Some PSA 10s sit for months. EV assumes you can sell at the comp."],
                    ["Player and set drift.", "A slab that comes back in four months may face a different market than the one you priced."],
                    ["Card condition.", "Grade odds assume an average raw copy. Inspect the actual card."],
                  ].map(([b, t]) => (
                    <li key={b} className="flex gap-3">
                      <span className="mt-[10px] w-1 h-1 rounded-full bg-faint shrink-0" />
                      <span><strong className="text-ink font-medium">{b}</strong> {t}</span>
                    </li>
                  ))}
                </ul>
              </Section>

              <Section title="Recommended workflow">
                <ol className="space-y-3">
                  {[
                    "Pull median 90-day sold comps for each grade from 130point or eBay sold listings.",
                    "Pull current pop counts from psacard.com/pop for the exact card variant.",
                    "Use a 30–40% bias haircut by default. Tighten it for cards you can inspect in hand.",
                    "Skip anything below a 0.5 Sharpe unless you have a specific thesis, like a player breakout.",
                    "Re-run the numbers on the day you submit. Comps move.",
                  ].map((t, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="w-6 h-6 shrink-0 rounded-full bg-subtle ring-1 ring-line grid place-items-center text-[12px] font-medium text-ink tabular-nums">{i + 1}</span>
                      <span className="pt-0.5">{t}</span>
                    </li>
                  ))}
                </ol>
              </Section>
            </div>
          </article>
        )}
      </main>

      <footer className="border-t border-line">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-6 flex flex-col sm:flex-row gap-2 justify-between text-[13px] text-muted">
          <div className="flex items-center gap-2">
            <Logo />
            <span>Cardstack</span>
          </div>
          <div>Not financial advice. Always verify comps before you submit.</div>
        </div>
      </footer>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section>
      <h2 className="text-[19px] font-semibold tracking-[-0.02em] text-ink mb-3">{title}</h2>
      {children}
    </section>
  );
}
