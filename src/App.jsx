import React, { useState, useMemo, useEffect } from "react";
import { TrendingUp, TrendingDown, AlertTriangle, Plus, Trash2, Save, BarChart3, Calculator, Target, Activity, ChevronRight, Sparkles, Package, X, Radar, Search, RefreshCw, Loader2 } from "lucide-react";

// ===== PSA grading tiers (Feb 2026 pricing, current as of writing) =====
const PSA_TIERS = [
  { id: "valuebulk", name: "Value Bulk",    cost: 24.99, maxValue: 500,   turnaround: "140-160 business days", note: "Collectors Club only, 20+ card minimum" },
  { id: "value",     name: "Value",         cost: 32.99, maxValue: 500,   turnaround: "75 business days" },
  { id: "valueplus", name: "Value Plus",    cost: 49.99, maxValue: 1000,  turnaround: "45 business days" },
  { id: "valuemax",  name: "Value Max",     cost: 64.99, maxValue: 2500,  turnaround: "35 business days" },
  { id: "regular",   name: "Regular",       cost: 79.99, maxValue: 5000,  turnaround: "25 business days" },
  { id: "express",   name: "Express",       cost: 149,   maxValue: 10000, turnaround: "15 business days" },
  { id: "superexp",  name: "Super Express", cost: 349,   maxValue: 25000, turnaround: "7 business days" },
  { id: "walkthru",  name: "Walk-Through",  cost: 350,   maxValue: 50000, turnaround: "5 business days", note: "scales with declared value" },
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

// ===== Components =====

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
    // Only fire onChange when it parses to a valid number
    const parsed = parseFloat(raw);
    if (!isNaN(parsed)) onChange(parsed);
    else if (raw === "" || raw === "-") onChange(0);
  };

  const handleBlur = () => {
    // On blur, normalize the display
    const parsed = parseFloat(localValue);
    if (isNaN(parsed)) setLocalValue("0");
    else setLocalValue(String(parsed));
  };

  return (
    <label className="block">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-[0.18em] text-stone-400 font-medium">{label}</span>
        {hint && <span className="text-[9px] text-stone-500 italic">{hint}</span>}
      </div>
      <div className="relative">
        {prefix && <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-500 text-sm font-mono">{prefix}</span>}
        <input
          type="number"
          step={step}
          value={localValue}
          data-numfield-id={label}
          onFocus={(e) => e.target.select()}
          onChange={handleChange}
          onBlur={handleBlur}
          className={`w-full bg-stone-900 border border-stone-700 text-stone-100 font-mono text-sm py-2 ${prefix ? "pl-6" : "pl-3"} ${suffix ? "pr-8" : "pr-3"} rounded-sm focus:border-amber-500 focus:outline-none transition-colors`}
        />
        {suffix && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-500 text-sm font-mono">{suffix}</span>}
      </div>
    </label>
  );
}

function TextField({ label, value, onChange, placeholder }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-[0.18em] text-stone-400 font-medium mb-1.5">{label}</div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-stone-900 border border-stone-700 text-stone-100 text-sm py-2 px-3 rounded-sm focus:border-amber-500 focus:outline-none transition-colors placeholder:text-stone-600"
      />
    </label>
  );
}

// Card image: supports drag-drop upload, file picker, paste URL.
// Stores as data URL (from upload) or http URL (from paste).
function CardImageInput({ value, onChange }) {
  const [urlMode, setUrlMode] = useState(false);
  const [urlInput, setUrlInput] = useState("");
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
      <div className="text-[10px] uppercase tracking-[0.18em] text-stone-400 font-medium mb-1.5">Card Image</div>
      {value ? (
        <div className="relative group">
          <img src={value} alt="Card" className="w-full h-48 object-contain bg-stone-900 border border-stone-700 rounded-sm" />
          <button
            onClick={() => onChange("")}
            className="absolute top-2 right-2 bg-stone-950/80 hover:bg-rose-950 text-stone-300 hover:text-rose-300 border border-stone-700 rounded-sm px-2 py-1 text-[10px] uppercase tracking-wider transition-colors"
          >
            Remove
          </button>
        </div>
      ) : urlMode ? (
        <div className="flex gap-2">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handlePaste()}
            placeholder="Paste image URL..."
            className="flex-1 bg-stone-900 border border-stone-700 text-stone-100 text-sm py-2 px-3 rounded-sm focus:border-amber-500 focus:outline-none placeholder:text-stone-600"
          />
          <button
            onClick={handlePaste}
            className="bg-amber-500 hover:bg-amber-400 text-stone-950 text-xs uppercase tracking-wider px-3 rounded-sm font-medium"
          >
            Add
          </button>
          <button
            onClick={() => { setUrlMode(false); setUrlInput(""); }}
            className="text-stone-500 hover:text-stone-300 text-xs px-2"
          >
            ✕
          </button>
        </div>
      ) : (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-stone-700 hover:border-amber-500 bg-stone-900/50 rounded-sm py-8 px-4 text-center cursor-pointer transition-colors"
        >
          <div className="text-stone-500 text-xs mb-2">Drag image here, or click to upload</div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setUrlMode(true); }}
            className="text-amber-500 hover:text-amber-400 text-[10px] uppercase tracking-wider"
          >
            or paste a URL
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

function StatBlock({ label, value, sublabel, tone = "neutral", large = false }) {
  const tones = {
    positive: "text-emerald-400 border-emerald-900/40",
    negative: "text-rose-400 border-rose-900/40",
    warning:  "text-amber-400 border-amber-900/40",
    neutral:  "text-stone-100 border-stone-800",
  };
  return (
    <div className={`border-l-2 pl-3 py-1 ${tones[tone]}`}>
      <div className="text-[9px] uppercase tracking-[0.2em] text-stone-500 font-medium mb-1">{label}</div>
      <div className={`font-mono ${large ? "text-2xl" : "text-lg"} font-semibold leading-none`}>{value}</div>
      {sublabel && <div className="text-[10px] text-stone-500 mt-1.5 font-mono">{sublabel}</div>}
    </div>
  );
}

function VerdictBadge({ ev, sharpe, probOfLoss }) {
  let label, tone, blurb;
  if (ev <= 0) {
    label = "AVOID";
    tone = "rose";
    blurb = "Negative expected value. The math says don't grade.";
  } else if (sharpe < 0.3 || probOfLoss > 0.6) {
    label = "HIGH RISK";
    tone = "amber";
    blurb = "Positive EV but volatile. Only attempt if you can absorb variance.";
  } else if (sharpe < 0.7) {
    label = "MARGINAL";
    tone = "stone";
    blurb = "Reasonable bet, but edge is thin. Verify your comps.";
  } else if (sharpe < 1.5) {
    label = "FAVORABLE";
    tone = "emerald";
    blurb = "Solid risk-adjusted return. Worth a position.";
  } else {
    label = "STRONG BUY";
    tone = "emerald";
    blurb = "Exceptional risk/reward. Stress-test before scaling in.";
  }
  const bg = {
    rose: "bg-rose-950/30 border-rose-800 text-rose-300",
    amber: "bg-amber-950/30 border-amber-800 text-amber-300",
    stone: "bg-stone-800/50 border-stone-700 text-stone-300",
    emerald: "bg-emerald-950/30 border-emerald-800 text-emerald-300",
  };
  return (
    <div className={`border ${bg[tone]} px-4 py-3 rounded-sm`}>
      <div className="flex items-center gap-2 mb-1">
        <Sparkles size={14} />
        <span className="text-[11px] uppercase tracking-[0.25em] font-semibold">{label}</span>
      </div>
      <div className="text-xs text-stone-300/80 font-light leading-relaxed">{blurb}</div>
    </div>
  );
}

// ===== Outcome distribution bar chart =====
function OutcomeChart({ outcomes }) {
  const labels = { psa10: "PSA 10", psa9: "PSA 9", psa8: "PSA 8", psa7orLower: "PSA ≤7" };
  const max = Math.max(...outcomes.map((o) => Math.abs(o.profit)), 1);
  return (
    <div className="bg-stone-950 border border-stone-800 rounded-sm overflow-hidden">
      {/* Sub-header */}
      <div className="grid grid-cols-[60px_1fr_85px_55px] gap-3 px-3 py-1.5 bg-stone-900 text-[9px] uppercase tracking-wider text-stone-500 font-mono border-b border-stone-800">
        <div>Grade</div>
        <div className="text-center">P&amp;L Distribution</div>
        <div className="text-right">Profit</div>
        <div className="text-right">Prob</div>
      </div>
      <div className="divide-y divide-stone-900">
        {outcomes.map((o) => {
          const pct = max > 0 ? (Math.abs(o.profit) / max) * 100 : 0;
          const positive = o.profit >= 0;
          return (
            <div key={o.grade} className="grid grid-cols-[60px_1fr_85px_55px] gap-3 items-center px-3 py-2 hover:bg-stone-900/50 transition-colors">
              <div className="text-[11px] font-mono text-stone-300 font-medium">{labels[o.grade]}</div>
              <div className="relative h-3.5">
                {/* Center line */}
                <div className="absolute inset-y-0 left-1/2 w-px bg-stone-700" />
                {/* Bar */}
                <div
                  className={`absolute inset-y-0 ${positive ? "left-1/2 bg-emerald-500/70" : "right-1/2 bg-rose-500/70"}`}
                  style={{ width: `${pct / 2}%` }}
                />
                {/* End cap line */}
                <div
                  className={`absolute inset-y-0 w-px ${positive ? "bg-emerald-300" : "bg-rose-300"}`}
                  style={positive ? { left: `calc(50% + ${pct / 2}%)` } : { right: `calc(50% + ${pct / 2}%)` }}
                />
              </div>
              <div className={`text-[11px] font-mono text-right tabular-nums ${positive ? "text-emerald-300" : "text-rose-300"}`}>
                {positive ? "+" : ""}{o.profit.toFixed(2)}
              </div>
              <div className="text-[11px] font-mono text-stone-400 text-right tabular-nums">{(o.prob * 100).toFixed(1)}%</div>
            </div>
          );
        })}
      </div>
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
  const yScale = (ev) => h / 2 - (ev / maxEV) * (h / 2 - 6);
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${(p.p10 / 100) * w} ${yScale(p.ev)}`).join(" ");
  // Area fill path
  const areaD = `${pathD} L ${w} ${h / 2} L 0 ${h / 2} Z`;
  const isUp = currentEV >= 0;

  return (
    <div>
      {/* Bloomberg-style ticker header */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-stone-800">
        <div className="flex items-center gap-2">
          <Activity size={10} className="text-amber-500" />
          <span className="text-[10px] uppercase tracking-[0.2em] text-stone-400 font-medium">EV · PSA 10 RATE</span>
          <span className="text-[9px] text-stone-600 font-mono">SENSITIVITY</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-mono">
          <span className="text-stone-600">{fmtPct(currentP10)}</span>
          <span className={isUp ? "text-emerald-400" : "text-rose-400"}>
            {isUp ? "▲" : "▼"} {fmt$(currentEV)}
          </span>
        </div>
      </div>

      <div className="relative bg-stone-950 border border-stone-800 rounded-sm h-44 overflow-hidden">
        {/* Grid */}
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
          {/* Horizontal grid lines */}
          {[0, 25, 50, 75, 100].map((pct) => (
            <line key={`h${pct}`} x1="0" y1={pct} x2={w} y2={pct} stroke="rgb(41 37 36)" strokeWidth="0.2" vectorEffect="non-scaling-stroke" />
          ))}
          {/* Vertical grid lines */}
          {[0, 20, 40, 60, 80, 100].map((pct) => (
            <line key={`v${pct}`} x1={pct} y1="0" x2={pct} y2={h} stroke="rgb(41 37 36)" strokeWidth="0.2" vectorEffect="non-scaling-stroke" />
          ))}
          {/* Zero line */}
          <line x1="0" y1={h / 2} x2={w} y2={h / 2} stroke="rgb(87 83 78)" strokeWidth="0.3" vectorEffect="non-scaling-stroke" />
          {/* Area fill */}
          <path d={areaD} fill="rgb(245 158 11)" fillOpacity="0.08" />
          {/* Curve */}
          <path d={pathD} fill="none" stroke="rgb(245 158 11)" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
          {/* Break-even marker */}
          {breakEvenPoint && (
            <line x1={breakEvenPoint.p10} y1="0" x2={breakEvenPoint.p10} y2={h} stroke="rgb(120 113 108)" strokeWidth="0.3" strokeDasharray="2,2" vectorEffect="non-scaling-stroke" />
          )}
          {/* Current position crosshair */}
          <line x1={currentP10} y1="0" x2={currentP10} y2={h} stroke="rgb(245 158 11)" strokeWidth="0.4" strokeDasharray="1,1" vectorEffect="non-scaling-stroke" />
          <line x1="0" y1={yScale(currentEV)} x2={w} y2={yScale(currentEV)} stroke="rgb(245 158 11)" strokeWidth="0.4" strokeDasharray="1,1" vectorEffect="non-scaling-stroke" />
          {/* Current dot */}
          <circle cx={currentP10} cy={yScale(currentEV)} r="1.4" fill="rgb(245 158 11)" stroke="rgb(28 25 23)" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
        </svg>
        {/* Y-axis labels */}
        <div className="absolute top-1 left-2 text-[9px] text-stone-600 font-mono">+{fmt$(maxEV)}</div>
        <div className="absolute top-1/2 left-2 text-[9px] text-stone-600 font-mono -translate-y-1/2">$0</div>
        <div className="absolute bottom-1 left-2 text-[9px] text-stone-600 font-mono">-{fmt$(maxEV)}</div>
        {/* X-axis labels */}
        <div className="absolute bottom-1 right-12 text-[9px] text-stone-600 font-mono">50%</div>
        <div className="absolute bottom-1 right-2 text-[9px] text-stone-600 font-mono">100%</div>
        {/* Break-even ticker */}
        {breakEvenPoint && (
          <div
            className="absolute top-1 text-[9px] font-mono px-1 bg-stone-900 border border-stone-700 text-stone-400"
            style={{ left: `${breakEvenPoint.p10}%`, transform: "translateX(-50%)" }}
          >
            BE {breakEvenPoint.p10}%
          </div>
        )}
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] font-mono">
        <div className="text-stone-500">Current: <span className="text-amber-400">{currentP10.toFixed(1)}%</span></div>
        <div className="text-stone-500 text-center">Break-even: <span className="text-stone-300">{breakEvenPoint ? `${breakEvenPoint.p10}%` : "N/A"}</span></div>
        <div className="text-stone-500 text-right">Headroom: <span className={breakEvenPoint && currentP10 > breakEvenPoint.p10 ? "text-emerald-400" : "text-rose-400"}>{breakEvenPoint ? `${(currentP10 - breakEvenPoint.p10).toFixed(1)}pp` : "—"}</span></div>
      </div>
    </div>
  );
}

// ===== Cost / Revenue P&L statement (waterfall) =====
function CostWaterfall({ rawCost, salesTaxPct, buyShippingCost, gradingCost, shippingCost, sellFeePct, result, ownsCard }) {
  const tax = rawCost * salesTaxPct / 100;
  const expectedGross = result.outcomes.reduce((s, o) => s + o.prob * o.grossPrice, 0);
  const sellFee = expectedGross * sellFeePct / 100;

  let bars;
  if (ownsCard) {
    bars = [
      { label: "GRADED SALE (E)", value: expectedGross, type: "rev" },
      { label: "Sell fees", value: -sellFee, type: "cost" },
      { label: "Grading", value: -gradingCost, type: "cost" },
      { label: "Round-trip ship", value: -shippingCost, type: "cost" },
      { label: "Raw sell forgone", value: -rawCost * (1 - sellFeePct / 100), type: "alt" },
    ];
  } else {
    bars = [
      { label: "GRADED SALE (E)", value: expectedGross, type: "rev" },
      { label: "Sell fees", value: -sellFee, type: "cost" },
      { label: "Raw cost", value: -rawCost, type: "cost" },
      { label: "Sales tax", value: -tax, type: "cost" },
      { label: "Buy shipping", value: -buyShippingCost, type: "cost" },
      { label: "Grading", value: -gradingCost, type: "cost" },
      { label: "Round-trip ship", value: -shippingCost, type: "cost" },
    ];
  }

  // Compute running balance + max abs for bar scaling
  const maxAbs = Math.max(...bars.map((b) => Math.abs(b.value)), 1);
  let runningTotal = 0;
  const rows = bars.map((b) => {
    runningTotal += b.value;
    return { ...b, runningTotal };
  });

  const final = runningTotal;

  return (
    <div>
      {/* Terminal header */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-stone-800">
        <div className="flex items-center gap-2">
          <span className="text-emerald-500 font-mono text-[10px]">▮</span>
          <span className="text-[10px] uppercase tracking-[0.2em] text-stone-400 font-medium">P&amp;L · EXPECTED VALUE</span>
        </div>
        <div className={`text-[10px] font-mono px-2 py-0.5 rounded-sm ${final >= 0 ? "bg-emerald-950/40 text-emerald-300 border border-emerald-900/40" : "bg-rose-950/40 text-rose-300 border border-rose-900/40"}`}>
          NET: {final >= 0 ? "+" : ""}${final.toFixed(2)}
        </div>
      </div>

      {/* P&L rows */}
      <div className="space-y-px font-mono text-[11px] bg-stone-950 border border-stone-800 rounded-sm overflow-hidden">
        {rows.map((bar, i) => {
          const widthPct = (Math.abs(bar.value) / maxAbs) * 50; // half width max
          const positive = bar.value >= 0;
          return (
            <div key={i} className="grid grid-cols-[150px_1fr_85px_90px] items-center px-3 py-1.5 hover:bg-stone-900/50 transition-colors">
              <div className={`text-[10px] truncate ${bar.type === "rev" ? "text-emerald-400 font-medium" : "text-stone-400"}`}>{bar.label}</div>
              <div className="relative h-3 mx-2">
                <div className="absolute inset-y-0 left-1/2 w-px bg-stone-700" />
                <div
                  className={`absolute inset-y-0 ${positive ? "left-1/2 bg-emerald-500/60" : "right-1/2 bg-rose-500/60"}`}
                  style={{ width: `${widthPct}%` }}
                />
              </div>
              <div className={`text-right tabular-nums ${positive ? "text-emerald-300" : "text-rose-300"}`}>
                {positive ? "+" : ""}{bar.value.toFixed(2)}
              </div>
              <div className="text-right tabular-nums text-stone-500 text-[10px]">
                = {bar.runningTotal >= 0 ? "+" : ""}{bar.runningTotal.toFixed(2)}
              </div>
            </div>
          );
        })}
        {/* Final summary row */}
        <div className={`grid grid-cols-[150px_1fr_85px_90px] items-center px-3 py-2 border-t border-stone-700 ${final >= 0 ? "bg-emerald-950/20" : "bg-rose-950/20"}`}>
          <div className="text-[10px] uppercase tracking-wider text-stone-300 font-medium">Expected Profit</div>
          <div></div>
          <div></div>
          <div className={`text-right tabular-nums font-medium ${final >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
            {final >= 0 ? "+" : ""}${final.toFixed(2)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ===== Risk / Reward scatter =====
function RiskRewardScatter({ outcomes }) {
  const labels = { psa10: "PSA10", psa9: "PSA9", psa8: "PSA8", psa7orLower: "≤PSA7" };
  const w = 100, h = 100;
  const maxProb = Math.max(...outcomes.map((o) => o.prob), 0.01);
  const maxAbsProfit = Math.max(...outcomes.map((o) => Math.abs(o.profit)), 1);

  const points = outcomes.map((o) => {
    const x = (o.prob / maxProb) * 80 + 12;
    const y = h / 2 - (o.profit / maxAbsProfit) * (h / 2 - 10);
    return { ...o, x, y };
  });

  // Compute the dominant point (highest profit × probability)
  const dominant = points.reduce((best, p) => (p.profit * p.prob > best.profit * best.prob ? p : best), points[0]);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-stone-800">
        <div className="flex items-center gap-2">
          <span className="text-amber-500 font-mono text-[10px]">◆</span>
          <span className="text-[10px] uppercase tracking-[0.2em] text-stone-400 font-medium">RISK · REWARD MATRIX</span>
        </div>
        <span className="text-[9px] text-stone-600 font-mono">bubble = probability</span>
      </div>

      <div className="relative bg-stone-950 border border-stone-800 rounded-sm h-44 overflow-hidden">
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
          {/* Quadrant tints - profitable top, loss bottom */}
          <rect x="0" y="0" width={w} height={h / 2} fill="rgb(16 185 129)" fillOpacity="0.03" />
          <rect x="0" y={h / 2} width={w} height={h / 2} fill="rgb(239 68 68)" fillOpacity="0.03" />
          {/* Grid */}
          {[20, 40, 60, 80].map((v) => (
            <line key={`vg${v}`} x1={v} y1="0" x2={v} y2={h} stroke="rgb(41 37 36)" strokeWidth="0.2" vectorEffect="non-scaling-stroke" />
          ))}
          {[25, 75].map((v) => (
            <line key={`hg${v}`} x1="0" y1={v} x2={w} y2={v} stroke="rgb(41 37 36)" strokeWidth="0.2" vectorEffect="non-scaling-stroke" />
          ))}
          {/* Zero axes */}
          <line x1="0" y1={h / 2} x2={w} y2={h / 2} stroke="rgb(87 83 78)" strokeWidth="0.3" vectorEffect="non-scaling-stroke" />
          <line x1="12" y1="0" x2="12" y2={h} stroke="rgb(87 83 78)" strokeWidth="0.3" vectorEffect="non-scaling-stroke" />

          {/* Points */}
          {points.map((p) => {
            const positive = p.profit >= 0;
            const radius = 2.5 + Math.sqrt(p.prob) * 7;
            const isDominant = p.grade === dominant.grade && p.profit > 0;
            return (
              <g key={p.grade}>
                {isDominant && (
                  <circle cx={p.x} cy={p.y} r={radius + 1.5} fill="none" stroke="rgb(245 158 11)" strokeWidth="0.4" strokeDasharray="1.5,1" vectorEffect="non-scaling-stroke" />
                )}
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={radius}
                  fill={positive ? "rgb(16 185 129)" : "rgb(239 68 68)"}
                  fillOpacity="0.4"
                  stroke={positive ? "rgb(110 231 183)" : "rgb(252 165 165)"}
                  strokeWidth="0.5"
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={p.x}
                  y={p.y + 1}
                  fontSize="2.4"
                  fill={positive ? "rgb(220 252 231)" : "rgb(254 226 226)"}
                  textAnchor="middle"
                  fontFamily="ui-monospace, monospace"
                  fontWeight="500"
                >
                  {labels[p.grade]}
                </text>
              </g>
            );
          })}
        </svg>

        {/* Axis labels */}
        <div className="absolute top-1 right-2 text-[8px] text-emerald-700 font-mono uppercase tracking-wider">↑ profit</div>
        <div className="absolute bottom-1 right-2 text-[8px] text-rose-700 font-mono uppercase tracking-wider">↓ loss</div>
        <div className="absolute bottom-1 left-2 text-[8px] text-stone-600 font-mono uppercase tracking-wider">prob →</div>

        {/* Y-axis labels */}
        <div className="absolute top-1 left-2 text-[9px] text-stone-600 font-mono">+{fmt$(maxAbsProfit)}</div>
        <div className="absolute bottom-6 left-2 text-[9px] text-stone-600 font-mono">-{fmt$(maxAbsProfit)}</div>
      </div>

      <div className="mt-2 text-[10px] font-mono text-stone-500">
        Best risk-adjusted: <span className="text-amber-400">{labels[dominant.grade] || "—"}</span>
        <span className="text-stone-700"> · </span>
        <span className="text-stone-400">{fmtPct(dominant.prob * 100)}</span>
        <span className="text-stone-700"> @ </span>
        <span className={dominant.profit >= 0 ? "text-emerald-400" : "text-rose-400"}>
          {dominant.profit >= 0 ? "+" : ""}{fmt$(dominant.profit)}
        </span>
      </div>
    </div>
  );
}

// ===== Monte Carlo simulation =====
function MonteCarloDistribution({ outcomes, runs = 5000 }) {
  // Run simulation
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

  // Histogram
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

  // Percentiles
  const sorted = [...results].sort((a, b) => a - b);
  const p5 = sorted[Math.floor(runs * 0.05)];
  const p25 = sorted[Math.floor(runs * 0.25)];
  const p50 = sorted[Math.floor(runs * 0.50)];
  const p75 = sorted[Math.floor(runs * 0.75)];
  const p95 = sorted[Math.floor(runs * 0.95)];
  const mean = sorted.reduce((s, v) => s + v, 0) / runs;

  // Win rate
  const winCount = sorted.filter((v) => v > 0).length;
  const winRate = (winCount / runs) * 100;

  // x position helper
  const xFor = (val) => ((val - minProfit) / range) * 100;
  const zeroX = xFor(0);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-stone-800">
        <div className="flex items-center gap-2">
          <span className="text-blue-500 font-mono text-[10px]">▦</span>
          <span className="text-[10px] uppercase tracking-[0.2em] text-stone-400 font-medium">MONTE CARLO · DISTRIBUTION</span>
          <span className="text-[9px] text-stone-600 font-mono">N={runs.toLocaleString()}</span>
        </div>
        <div className="flex gap-3 text-[10px] font-mono">
          <span className="text-stone-500">μ=<span className={mean >= 0 ? "text-emerald-400" : "text-rose-400"}>{mean >= 0 ? "+" : ""}{mean.toFixed(2)}</span></span>
          <span className="text-stone-500">WIN=<span className="text-stone-300">{winRate.toFixed(1)}%</span></span>
        </div>
      </div>

      <div className="relative bg-stone-950 border border-stone-800 rounded-sm h-44 overflow-hidden">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
          {/* Background grid */}
          {[20, 40, 60, 80].map((v) => (
            <line key={`g${v}`} x1="0" y1={v} x2="100" y2={v} stroke="rgb(41 37 36)" strokeWidth="0.2" vectorEffect="non-scaling-stroke" />
          ))}

          {/* Histogram bars */}
          {buckets.map((count, i) => {
            const height = (count / maxCount) * 88;
            const x = (i / numBuckets) * 100;
            const barW = 100 / numBuckets - 0.3;
            const bucketStart = minProfit + (i / numBuckets) * range;
            const bucketEnd = minProfit + ((i + 1) / numBuckets) * range;
            const positive = bucketStart >= 0;
            const straddlesZero = bucketStart < 0 && bucketEnd > 0;
            return (
              <rect
                key={i}
                x={x}
                y={100 - height - 6}
                width={barW}
                height={height}
                fill={positive ? "rgb(16 185 129)" : straddlesZero ? "rgb(120 113 108)" : "rgb(239 68 68)"}
                fillOpacity="0.6"
                stroke={positive ? "rgb(16 185 129)" : straddlesZero ? "rgb(120 113 108)" : "rgb(239 68 68)"}
                strokeWidth="0.2"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {/* P5 line (VaR) */}
          <line x1={xFor(p5)} y1="0" x2={xFor(p5)} y2="100" stroke="rgb(239 68 68)" strokeWidth="0.5" strokeDasharray="2,1" vectorEffect="non-scaling-stroke" />
          {/* P50 line (median) */}
          <line x1={xFor(p50)} y1="0" x2={xFor(p50)} y2="100" stroke="rgb(245 158 11)" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
          {/* P95 line */}
          <line x1={xFor(p95)} y1="0" x2={xFor(p95)} y2="100" stroke="rgb(16 185 129)" strokeWidth="0.5" strokeDasharray="2,1" vectorEffect="non-scaling-stroke" />
          {/* Zero line */}
          {minProfit < 0 && maxProfit > 0 && (
            <line x1={zeroX} y1="0" x2={zeroX} y2="100" stroke="rgb(244 244 245)" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
          )}
        </svg>

        {/* Floating labels */}
        <div className="absolute top-1 left-2 text-[9px] text-rose-500 font-mono" style={{ left: `${xFor(p5)}%`, transform: "translateX(-50%)" }}>
          P5
        </div>
        <div className="absolute top-1 text-[9px] text-amber-400 font-mono" style={{ left: `${xFor(p50)}%`, transform: "translateX(-50%)" }}>
          MED
        </div>
        <div className="absolute top-1 text-[9px] text-emerald-400 font-mono" style={{ left: `${xFor(p95)}%`, transform: "translateX(-50%)" }}>
          P95
        </div>

        {/* x-axis labels */}
        <div className="absolute bottom-1 left-2 text-[9px] text-stone-600 font-mono">{fmt$(minProfit)}</div>
        <div className="absolute bottom-1 right-2 text-[9px] text-stone-600 font-mono">{fmt$(maxProfit)}</div>
      </div>

      {/* Percentile readout */}
      <div className="mt-2 grid grid-cols-5 gap-1 text-[9px] font-mono">
        <div className="bg-rose-950/30 border border-rose-900/40 px-2 py-1 rounded-sm">
          <div className="text-rose-500 uppercase tracking-wider text-[8px]">P5 VaR</div>
          <div className={`${p5 < 0 ? "text-rose-300" : "text-emerald-300"}`}>{p5 >= 0 ? "+" : ""}${p5.toFixed(0)}</div>
        </div>
        <div className="bg-stone-900 border border-stone-800 px-2 py-1 rounded-sm">
          <div className="text-stone-500 uppercase tracking-wider text-[8px]">P25</div>
          <div className={`${p25 < 0 ? "text-rose-300" : "text-emerald-300"}`}>{p25 >= 0 ? "+" : ""}${p25.toFixed(0)}</div>
        </div>
        <div className="bg-amber-950/30 border border-amber-900/40 px-2 py-1 rounded-sm">
          <div className="text-amber-500 uppercase tracking-wider text-[8px]">MEDIAN</div>
          <div className={`${p50 < 0 ? "text-rose-300" : "text-emerald-300"}`}>{p50 >= 0 ? "+" : ""}${p50.toFixed(0)}</div>
        </div>
        <div className="bg-stone-900 border border-stone-800 px-2 py-1 rounded-sm">
          <div className="text-stone-500 uppercase tracking-wider text-[8px]">P75</div>
          <div className={`${p75 < 0 ? "text-rose-300" : "text-emerald-300"}`}>{p75 >= 0 ? "+" : ""}${p75.toFixed(0)}</div>
        </div>
        <div className="bg-emerald-950/30 border border-emerald-900/40 px-2 py-1 rounded-sm">
          <div className="text-emerald-500 uppercase tracking-wider text-[8px]">P95</div>
          <div className="text-emerald-300">+${p95.toFixed(0)}</div>
        </div>
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
  const [tierId, setTierId] = useState("value");
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
  const [submissionTier, setSubmissionTier] = useState("value");
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
        if (s.tier) setSubmissionTier(s.tier);
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

  const tier = PSA_TIERS.find((t) => t.id === tierId) || PSA_TIERS[1];

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
    const submissionTierObj = PSA_TIERS.find((t) => t.id === submissionTier) || PSA_TIERS[1];
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

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100" style={{ fontFamily: '"Söhne", "Inter", system-ui, sans-serif' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@300;400;500;600&display=swap');
        body { font-family: 'Inter', system-ui, sans-serif; }
        .font-display { font-family: 'Fraunces', Georgia, serif; font-optical-sizing: auto; }
        .font-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
        .grain { position: relative; }
        .grain::before { content: ''; position: absolute; inset: 0; pointer-events: none; opacity: 0.03; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' /%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' /%3E%3C/svg%3E"); }
      `}</style>

      {/* Header */}
      <header className="border-b border-stone-800 grain">
        <div className="max-w-[1400px] mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-baseline gap-3">
            <div className="font-display text-2xl font-semibold tracking-tight">Cardstack</div>
            <div className="text-[10px] uppercase tracking-[0.3em] text-stone-500 font-medium">Grading EV Terminal</div>
          </div>
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-[0.2em] text-stone-500">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="ml-1">Live · Risk-Adjusted Model v1.0</span>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="border-b border-stone-800">
        <div className="max-w-[1400px] mx-auto px-6 flex gap-1">
          {[
            { id: "input", label: "Calculator", icon: Calculator },
            { id: "scanner", label: "Scanner", icon: Radar },
            { id: "submission", label: `Submission (${submission.length})`, icon: Package },
            { id: "watchlist", label: `Watchlist (${watchlist.length})`, icon: BarChart3 },
            { id: "guide", label: "Method", icon: Target },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-2 px-4 py-3 text-[11px] uppercase tracking-[0.18em] font-medium transition-colors ${
                activeTab === id ? "text-amber-400 border-b-2 border-amber-500" : "text-stone-500 hover:text-stone-300 border-b-2 border-transparent"
              }`}
            >
              <Icon size={12} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Main content */}
      <main className="max-w-[1400px] mx-auto px-6 py-8">
        {activeTab === "input" && (
          <div className="grid grid-cols-1 lg:grid-cols-[420px_1fr] gap-8">
            {/* LEFT: Inputs */}
            <div className="space-y-7">
              {/* Card identity */}
              <section>
                <SectionHeader num="01" title="Card" />
                <div className="space-y-4 mt-4">
                  <TextField label="Card Description" value={cardName} onChange={setCardName} placeholder="e.g. 2018 Prizm Luka Dončić #280" />
                  <CardImageInput value={cardImage} onChange={setCardImage} />

                  {/* Mode toggle */}
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-stone-400 font-medium mb-1.5">Scenario</div>
                    <div className="flex gap-1 bg-stone-900 p-1 rounded-sm border border-stone-800">
                      <button
                        onClick={() => setOwnsCard(false)}
                        className={`flex-1 py-2 text-[10px] uppercase tracking-[0.15em] font-medium rounded-sm transition-colors ${
                          !ownsCard ? "bg-stone-800 text-amber-400" : "text-stone-500 hover:text-stone-300"
                        }`}
                      >
                        Buying to Grade
                      </button>
                      <button
                        onClick={() => setOwnsCard(true)}
                        className={`flex-1 py-2 text-[10px] uppercase tracking-[0.15em] font-medium rounded-sm transition-colors ${
                          ownsCard ? "bg-stone-800 text-amber-400" : "text-stone-500 hover:text-stone-300"
                        }`}
                      >
                        Already Own It
                      </button>
                    </div>
                    <div className="mt-2 text-[10px] text-stone-500 italic leading-relaxed">
                      {ownsCard
                        ? "Comparing: grade & sell vs. sell raw now. What you paid for the card is a sunk cost — ignore it."
                        : "Comparing: buy raw, grade, and sell vs. doing nothing."}
                    </div>
                  </div>
                </div>
              </section>

              {/* Buy/sell costs section — adapts to mode */}
              {!ownsCard ? (
                <section>
                  <SectionHeader num="02" title="Buy Costs" />
                  <div className="grid grid-cols-2 gap-3 mt-4">
                    <NumField label="Raw Buy Price" value={rawCost} onChange={setRawCost} prefix="$" />
                    <NumField label="Sales Tax" value={salesTaxPct} onChange={setSalesTaxPct} suffix="%" hint="varies by state" />
                    <NumField label="Shipping to You" value={buyShippingCost} onChange={setBuyShippingCost} prefix="$" hint="from seller" />
                  </div>
                  <div className="mt-3 px-3 py-2 bg-stone-900/50 border border-stone-800 rounded-sm flex justify-between text-[11px] font-mono">
                    <span className="text-stone-500">All-in buy cost</span>
                    <span className="text-stone-300">${(rawCost + rawCost * salesTaxPct / 100 + buyShippingCost).toFixed(2)}</span>
                  </div>
                </section>
              ) : (
                <section>
                  <SectionHeader num="02" title="Opportunity Cost" />
                  <div className="mt-4">
                    <NumField label="Raw Sell Price Today" value={rawCost} onChange={setRawCost} prefix="$" hint="what you'd net selling raw" />
                  </div>
                  <div className="mt-3 px-3 py-2 bg-amber-950/20 border border-amber-900/40 rounded-sm text-[10px] text-amber-300/80 italic leading-relaxed">
                    By grading, you give up the chance to sell raw at this price. That's the real "cost" of grading a card you already own.
                  </div>
                </section>
              )}

              {/* Grading tier */}
              <section>
                <SectionHeader num="03" title="Grading & Sell" />
                <div className="space-y-3 mt-4">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-stone-400 font-medium mb-1.5">PSA Tier</div>
                    <select
                      value={tierId}
                      onChange={(e) => {
                        const newTier = e.target.value;
                        setTierId(newTier);
                        if (newTier === "valuebulk" && cardsInSubmission < 20) {
                          setCardsInSubmission(20);
                        }
                      }}
                      className="w-full bg-stone-900 border border-stone-700 text-stone-100 text-sm py-2 px-3 rounded-sm focus:border-amber-500 focus:outline-none"
                    >
                      {PSA_TIERS.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} — ${t.cost} · max ${t.maxValue} · {t.turnaround}
                        </option>
                      ))}
                    </select>
                    {tier.note && (
                      <div className="mt-2 text-[10px] text-stone-500 italic">{tier.note}</div>
                    )}
                    {pricePSA10 > tier.maxValue && (
                      <div className="mt-2 flex items-start gap-1.5 text-[10px] text-amber-400">
                        <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                        <span>PSA 10 price (${pricePSA10}) exceeds tier max (${tier.maxValue}). PSA may bump you up a tier.</span>
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <NumField label="Round-Trip Shipping" value={shippingCost} onChange={setShippingCost} prefix="$" hint="full batch" />
                    <NumField label="Sell Fee" value={sellFeePct} onChange={setSellFeePct} suffix="%" hint="eBay ≈13%" />
                    <NumField label="Cards in Submission" value={cardsInSubmission} onChange={(v) => setCardsInSubmission(Math.max(1, Math.round(v)))} step="1" hint="shipping divides by this" />
                    <div className="flex flex-col justify-end">
                      <div className="px-3 py-2 bg-stone-900/50 border border-stone-800 rounded-sm flex justify-between text-[11px] font-mono">
                        <span className="text-stone-500">/card ship</span>
                        <span className="text-stone-300">${perCardShipping.toFixed(2)}</span>
                      </div>
                    </div>
                  </div>
                  {tierId === "valuebulk" && cardsInSubmission < 20 && (
                    <div className="mt-2 flex items-start gap-1.5 text-[10px] text-amber-400">
                      <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                      <span>Value Bulk requires a 20-card minimum submission.</span>
                    </div>
                  )}
                </div>
              </section>

              {/* Sold comps */}
              <section>
                <SectionHeader num="04" title="Sold Comps" />
                <div className="grid grid-cols-2 gap-3 mt-4">
                  <NumField label="PSA 10 Sale Price" value={pricePSA10} onChange={setPricePSA10} prefix="$" />
                  <NumField label="PSA 9 Sale Price" value={pricePSA9} onChange={setPricePSA9} prefix="$" />
                  <NumField label="PSA 8 Sale Price" value={pricePSA8} onChange={setPricePSA8} prefix="$" />
                  <NumField label="PSA ≤7 Sale Price" value={priceLower} onChange={setPriceLower} prefix="$" />
                </div>
                <p className="text-[10px] text-stone-500 italic mt-3 leading-relaxed">Use median of last 90 days from 130point or eBay sold listings. Avoid outlier highs.</p>
              </section>

              {/* Probability source */}
              <section>
                <SectionHeader num="05" title="Grade Probabilities" />
                <div className="flex gap-1 mt-4 mb-4 bg-stone-900 p-1 rounded-sm border border-stone-800">
                  <button
                    onClick={() => setUsePopReport(true)}
                    className={`flex-1 py-1.5 text-[10px] uppercase tracking-[0.15em] font-medium rounded-sm transition-colors ${
                      usePopReport ? "bg-stone-800 text-amber-400" : "text-stone-500"
                    }`}
                  >
                    From PSA Pop Report
                  </button>
                  <button
                    onClick={() => setUsePopReport(false)}
                    className={`flex-1 py-1.5 text-[10px] uppercase tracking-[0.15em] font-medium rounded-sm transition-colors ${
                      !usePopReport ? "bg-stone-800 text-amber-400" : "text-stone-500"
                    }`}
                  >
                    Manual Override
                  </button>
                </div>

                {usePopReport ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <NumField label="Pop · PSA 10" value={popPSA10} onChange={setPopPSA10} step="1" />
                      <NumField label="Pop · PSA 9" value={popPSA9} onChange={setPopPSA9} step="1" />
                      <NumField label="Pop · PSA 8" value={popPSA8} onChange={setPopPSA8} step="1" />
                      <NumField label="Pop · ≤7" value={popLower} onChange={setPopLower} step="1" />
                    </div>
                    <div>
                      <NumField
                        label="Selection Bias Haircut"
                        value={biasHaircut}
                        onChange={setBiasHaircut}
                        suffix="%"
                        hint="Default 35%"
                      />
                      <p className="text-[10px] text-stone-500 italic mt-2 leading-relaxed">
                        Pop reports overstate 10-rates because submitters cherry-pick. A 35% haircut adjusts toward what a random raw eBay copy would grade.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <NumField label="P(PSA 10)" value={manualP10} onChange={setManualP10} suffix="%" />
                    <NumField label="P(PSA 9)" value={manualP9} onChange={setManualP9} suffix="%" />
                    <NumField label="P(PSA 8)" value={manualP8} onChange={setManualP8} suffix="%" />
                    <NumField label="P(≤7)" value={manualPLower} onChange={setManualPLower} suffix="%" />
                  </div>
                )}

                <div className={`mt-3 px-3 py-2 rounded-sm border text-[11px] font-mono flex justify-between ${
                  probsValid ? "bg-stone-900/50 border-stone-800 text-stone-400" : "bg-rose-950/30 border-rose-900 text-rose-300"
                }`}>
                  <span>Probability total</span>
                  <span>{probSum.toFixed(1)}% {probsValid ? "✓" : "(must equal 100)"}</span>
                </div>

                <div className="mt-4 p-3 bg-stone-900/50 border border-stone-800 rounded-sm">
                  <div className="text-[9px] uppercase tracking-[0.2em] text-stone-500 mb-2">Effective probabilities used</div>
                  <div className="grid grid-cols-4 gap-2 text-center">
                    {[
                      { l: "10", v: probabilities.psa10 },
                      { l: "9",  v: probabilities.psa9  },
                      { l: "8",  v: probabilities.psa8  },
                      { l: "≤7", v: probabilities.psa7orLower },
                    ].map((p) => (
                      <div key={p.l}>
                        <div className="text-[9px] text-stone-500 font-mono">PSA {p.l}</div>
                        <div className="text-sm font-mono text-stone-200">{p.v.toFixed(1)}%</div>
                      </div>
                    ))}
                  </div>
                </div>
              </section>

              {/* Save / Add */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={saveToWatchlist}
                  disabled={!cardName.trim()}
                  className="bg-amber-500 hover:bg-amber-400 disabled:bg-stone-800 disabled:text-stone-600 text-stone-950 disabled:cursor-not-allowed font-medium text-xs uppercase tracking-[0.2em] py-3 rounded-sm transition-colors flex items-center justify-center gap-2"
                >
                  <Save size={13} />
                  To Watchlist
                </button>
                <button
                  onClick={addToSubmission}
                  className="bg-stone-800 hover:bg-stone-700 border border-stone-700 text-stone-100 font-medium text-xs uppercase tracking-[0.2em] py-3 rounded-sm transition-colors flex items-center justify-center gap-2"
                >
                  <Package size={13} />
                  To Submission
                </button>
              </div>
            </div>

            {/* RIGHT: Output */}
            <div className="space-y-6">
              {/* Card preview */}
              {(cardImage || cardName) && (
                <div className="border border-stone-800 rounded-sm p-4 flex gap-4 items-center bg-stone-900/30">
                  {cardImage && (
                    <img src={cardImage} alt="" className="w-16 h-22 object-contain bg-stone-950 border border-stone-700 rounded-sm flex-shrink-0" style={{ height: '88px' }} />
                  )}
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-stone-500 font-medium">{ownsCard ? "Grading Decision" : "Evaluating"}</div>
                    <div className="text-stone-100 text-base truncate">{cardName || "Untitled card"}</div>
                    <div className="text-[10px] text-stone-500 font-mono mt-1">
                      {ownsCard
                        ? `${tier.cost.toFixed(2)} grade + $${shippingCost.toFixed(2)} ship · risking $${(rawCost * (1 - sellFeePct/100)).toFixed(2)} raw sell`
                        : `$${rawCost.toFixed(2)} raw + $${(rawCost * salesTaxPct / 100).toFixed(2)} tax + $${buyShippingCost.toFixed(2)} ship + $${tier.cost} grade`}
                    </div>
                  </div>
                </div>
              )}

              {/* Verdict */}
              <VerdictBadge ev={result.ev} sharpe={result.sharpe} probOfLoss={result.probOfLoss} />

              {/* Headline metrics */}
              <div className="border border-stone-800 rounded-sm p-6 bg-gradient-to-br from-stone-900/40 to-stone-950">
                <div className="grid grid-cols-3 gap-6">
                  <StatBlock
                    label="Expected Value"
                    value={fmt$(result.ev)}
                    sublabel={fmt$Full(result.ev)}
                    tone={evTone}
                    large
                  />
                  <StatBlock
                    label="ROI on Total Cost"
                    value={fmtPct(result.roi)}
                    sublabel={`Cost basis ${fmt$(result.totalCost)}`}
                    tone={result.roi > 0 ? "positive" : "negative"}
                    large
                  />
                  <StatBlock
                    label="Sharpe-Like Ratio"
                    value={result.sharpe.toFixed(2)}
                    sublabel="EV ÷ stdev"
                    tone={result.sharpe > 0.7 ? "positive" : result.sharpe > 0.3 ? "warning" : "negative"}
                    large
                  />
                </div>
                <div className="grid grid-cols-3 gap-6 mt-6 pt-5 border-t border-stone-800">
                  <StatBlock
                    label="Probability of Loss"
                    value={fmtPct(result.probOfLoss * 100)}
                    tone={result.probOfLoss > 0.5 ? "negative" : result.probOfLoss > 0.3 ? "warning" : "positive"}
                  />
                  <StatBlock
                    label="Std. Dev of Profit"
                    value={`±${fmt$(result.stdDev)}`}
                    sublabel="Outcome volatility"
                  />
                  <StatBlock
                    label="Break-even 10 Rate"
                    value={result.breakEven10Rate !== null ? fmtPct(result.breakEven10Rate) : "N/A"}
                    sublabel={result.breakEven10Rate !== null ? `Modeling ${probabilities.psa10.toFixed(1)}%` : "Profitable in all cases"}
                    tone={
                      result.breakEven10Rate === null
                        ? "positive"
                        : probabilities.psa10 > result.breakEven10Rate
                        ? "positive"
                        : "negative"
                    }
                  />
                </div>
              </div>

              {/* Outcome distribution */}
              <div className="border border-stone-800 rounded-sm p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <BarChart3 size={12} className="text-amber-500" />
                    <span className="text-[10px] uppercase tracking-[0.2em] text-stone-400 font-medium">Profit by Outcome</span>
                  </div>
                  <div className="text-[10px] text-stone-500 font-mono">net of fees</div>
                </div>
                <OutcomeChart outcomes={result.outcomes} />
                <div className="grid grid-cols-3 gap-3 mt-5 pt-4 border-t border-stone-800 text-[10px] font-mono">
                  <div className="text-stone-500">Raw + Grade + Ship: <span className="text-stone-300">{fmt$Full(result.totalCost)}</span></div>
                  <div className="text-stone-500">Avg Net Sale: <span className="text-stone-300">{fmt$Full(result.evPlusCost)}</span></div>
                  <div className="text-stone-500">Tier: <span className="text-stone-300">{tier.name} (${tier.cost})</span></div>
                </div>
              </div>

              {/* Cost waterfall + risk/reward scatter side by side */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border border-stone-800 rounded-sm p-5">
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
                </div>
                <div className="border border-stone-800 rounded-sm p-5">
                  <RiskRewardScatter outcomes={result.outcomes} />
                </div>
              </div>

              {/* Monte Carlo */}
              <div className="border border-stone-800 rounded-sm p-5">
                <MonteCarloDistribution outcomes={result.outcomes} />
              </div>

              {/* Stress test */}
              <div className="border border-stone-800 rounded-sm p-5">
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
        )}

        {activeTab === "scanner" && (
          <div>
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-2xl font-semibold mb-1">Scanner</h2>
                <p className="text-sm text-stone-500">Scan modern basketball &amp; football rookies and rank by expected return. Results are estimates — verify against 130point before grading.</p>
              </div>
              <button
                onClick={runScan}
                disabled={scanLoading}
                className="bg-amber-500 hover:bg-amber-400 disabled:bg-stone-800 disabled:text-stone-600 text-stone-950 disabled:cursor-not-allowed font-medium text-xs uppercase tracking-[0.2em] py-2.5 px-4 rounded-sm transition-colors flex items-center gap-2"
              >
                {scanLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                {scanLoading ? "Scanning..." : (scanResults.length > 0 ? "Rescan" : "Run Scan")}
              </button>
            </div>

            {/* Filters and custom card */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              {/* Sport filter */}
              <div className="border border-stone-800 rounded-sm p-4">
                <div className="text-[10px] uppercase tracking-[0.2em] text-stone-400 font-medium mb-2">Filter</div>
                <div className="flex gap-1 bg-stone-900 p-1 rounded-sm border border-stone-800">
                  {[
                    { id: "all", label: "All" },
                    { id: "basketball", label: "Basketball" },
                    { id: "football", label: "Football" },
                  ].map(({ id, label }) => (
                    <button
                      key={id}
                      onClick={() => setScanFilter(id)}
                      className={`flex-1 py-1.5 text-[10px] uppercase tracking-[0.15em] font-medium rounded-sm transition-colors ${
                        scanFilter === id ? "bg-stone-800 text-amber-400" : "text-stone-500 hover:text-stone-300"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="mt-3 text-[10px] text-stone-500 italic leading-relaxed">
                  Click "Run Scan" above to fetch current eBay prices for cards in this category.
                </div>
              </div>

              {/* Custom card scan */}
              <div className="border border-stone-800 rounded-sm p-4">
                <div className="text-[10px] uppercase tracking-[0.2em] text-stone-400 font-medium mb-2">Add Custom Card</div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={customQuery}
                    onChange={(e) => setCustomQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && scanCustomCard()}
                    placeholder="e.g. 2023 Prizm CJ Stroud 339"
                    className="flex-1 bg-stone-900 border border-stone-700 text-stone-100 text-sm py-2 px-3 rounded-sm focus:border-amber-500 focus:outline-none placeholder:text-stone-600"
                  />
                  <button
                    onClick={scanCustomCard}
                    disabled={customScanLoading || !customQuery.trim()}
                    className="bg-stone-800 hover:bg-stone-700 disabled:bg-stone-900 disabled:text-stone-600 border border-stone-700 text-stone-100 text-xs uppercase tracking-wider px-3 rounded-sm flex items-center gap-2"
                  >
                    {customScanLoading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                    Scan
                  </button>
                </div>
                <div className="mt-3 text-[10px] text-stone-500 italic leading-relaxed">
                  Type a card description and we'll add it to your results.
                </div>
              </div>
            </div>

            {/* Error state */}
            {scanError && (
              <div className="mb-6 px-4 py-3 bg-rose-950/30 border border-rose-900/40 rounded-sm text-[11px] text-rose-300 leading-relaxed">
                <div className="font-medium mb-1">Scanner error</div>
                <div className="font-mono text-[10px] opacity-80">{scanError}</div>
              </div>
            )}

            {/* Status bar */}
            {scanLastUpdated && (
              <div className="mb-4 flex items-center justify-between text-[10px] text-stone-500 font-mono">
                <span>Last scan: {new Date(scanLastUpdated).toLocaleString()}</span>
                <span>{scanResults.filter((r) => r.status === "ok").length} valid · {scanResults.filter((r) => r.status !== "ok").length} skipped</span>
              </div>
            )}

            {/* Results table */}
            {scanResults.length === 0 ? (
              <div className="border border-dashed border-stone-800 rounded-sm py-16 text-center">
                <Radar className="mx-auto text-stone-700 mb-3" size={32} />
                <div className="text-stone-500 text-sm">No scan results yet.</div>
                <div className="text-stone-600 text-xs mt-1">Click "Run Scan" above to fetch current eBay prices.</div>
              </div>
            ) : (
              <div className="border border-stone-800 rounded-sm overflow-hidden">
                <div className="grid grid-cols-[2fr_repeat(6,1fr)_60px] gap-3 px-4 py-2 bg-stone-900 text-[10px] uppercase tracking-[0.15em] text-stone-500 font-medium">
                  <div>Card</div>
                  <div className="text-right">Raw $</div>
                  <div className="text-right">PSA 9 $</div>
                  <div className="text-right">PSA 10 $</div>
                  <div className="text-right">EV</div>
                  <div className="text-right">Sharpe</div>
                  <div className="text-right">Verdict</div>
                  <div></div>
                </div>
                {[...scanResults]
                  .filter((r) => r.status === "ok")
                  .sort((a, b) => (b.sharpe || 0) - (a.sharpe || 0))
                  .map((r) => (
                    <div key={r.id} className="grid grid-cols-[2fr_repeat(6,1fr)_60px] gap-3 px-4 py-2.5 border-t border-stone-800 hover:bg-stone-900/50 transition-colors items-center text-sm">
                      <div className="min-w-0">
                        <div className="text-stone-100 font-medium truncate">{r.player}</div>
                        <div className="text-[10px] text-stone-500 font-mono">{r.year} {r.set} {r.cardNumber && `#${r.cardNumber}`} · {r.sport}</div>
                      </div>
                      <div className="text-right font-mono text-stone-300">${r.prices?.raw?.median?.toFixed(0) || "—"}</div>
                      <div className="text-right font-mono text-stone-300">${r.prices?.psa9?.median?.toFixed(0) || "—"}</div>
                      <div className="text-right font-mono text-stone-300">${r.prices?.psa10?.median?.toFixed(0) || "—"}</div>
                      <div className={`text-right font-mono ${r.ev > 0 ? "text-emerald-400" : "text-rose-400"}`}>{r.ev > 0 ? "+" : ""}${r.ev?.toFixed(0)}</div>
                      <div className={`text-right font-mono ${r.sharpe > 0.7 ? "text-emerald-400" : r.sharpe > 0.3 ? "text-amber-400" : "text-rose-400"}`}>{r.sharpe?.toFixed(2)}</div>
                      <div className={`text-right text-[10px] font-mono uppercase tracking-wider ${
                        r.verdict === "STRONG_BUY" ? "text-emerald-300" :
                        r.verdict === "FAVORABLE" ? "text-emerald-400" :
                        r.verdict === "MARGINAL" ? "text-stone-300" :
                        r.verdict === "HIGH_RISK" ? "text-amber-400" :
                        "text-rose-400"
                      }`}>{r.verdict?.replace("_", " ")}</div>
                      <button
                        onClick={() => loadIntoCalculator(r)}
                        className="text-stone-600 hover:text-amber-400 text-[10px] uppercase tracking-wider transition-colors"
                        title="Load into calculator"
                      >
                        Open →
                      </button>
                    </div>
                  ))}
                {/* Skipped cards section */}
                {scanResults.some((r) => r.status !== "ok") && (
                  <div className="border-t-2 border-stone-700">
                    <div className="px-4 py-2 bg-stone-900/50 text-[10px] uppercase tracking-[0.15em] text-stone-500 font-medium">
                      Skipped ({scanResults.filter((r) => r.status !== "ok").length})
                    </div>
                    {scanResults.filter((r) => r.status !== "ok").map((r) => (
                      <div key={r.id} className="grid grid-cols-[2fr_2fr] gap-3 px-4 py-2 border-t border-stone-800 text-xs">
                        <div className="text-stone-400 truncate">{r.player} <span className="text-[10px] text-stone-600">({r.year} {r.set})</span></div>
                        <div className="text-[10px] text-stone-500 italic truncate">{r.note}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Notes */}
            <div className="mt-6 px-4 py-3 bg-stone-900/30 border border-stone-800 rounded-sm text-[11px] text-stone-400 leading-relaxed">
              <div className="font-medium text-stone-300 mb-1">How the scanner works</div>
              <p className="mb-1">For each card, the scanner pulls current eBay listings for raw, PSA 9, and PSA 10 versions. Median prices are discounted ~18% to estimate sold prices (active listings tend to be priced higher than actuals).</p>
              <p>EV uses default probabilities (P10: 18%, P9: 55%, P8: 22%, lower: 5%). For accurate per-card analysis, click "Open →" to load the card into the Calculator and refine pop data and tier.</p>
            </div>
          </div>
        )}

        {activeTab === "submission" && (
          <div>
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-2xl font-semibold mb-1">Submission Builder</h2>
                <p className="text-sm text-stone-500">Build a batch, see the aggregate EV and per-card breakdown. Shipping divides across all cards.</p>
              </div>
              {submission.length > 0 && (
                <button
                  onClick={clearSubmission}
                  className="text-[10px] text-stone-500 hover:text-rose-400 uppercase tracking-[0.18em] flex items-center gap-1 mt-2"
                >
                  <X size={12} /> Clear All
                </button>
              )}
            </div>

            {/* Submission settings */}
            <div className="border border-stone-800 rounded-sm p-4 mb-6">
              <div className="text-[10px] uppercase tracking-[0.2em] text-stone-400 font-medium mb-3">Submission Settings</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-stone-400 font-medium mb-1.5">PSA Tier</div>
                  <select
                    value={submissionTier}
                    onChange={(e) => updateSubmissionSetting("tier", e.target.value)}
                    className="w-full bg-stone-900 border border-stone-700 text-stone-100 text-sm py-2 px-3 rounded-sm focus:border-amber-500 focus:outline-none"
                  >
                    {PSA_TIERS.map((t) => (
                      <option key={t.id} value={t.id}>{t.name} — ${t.cost}</option>
                    ))}
                  </select>
                </div>
                <NumField
                  label="Round-Trip Shipping (Batch)"
                  value={submissionShipping}
                  onChange={(v) => updateSubmissionSetting("shipping", v)}
                  prefix="$"
                  hint={submission.length > 0 ? `÷${submission.length} = $${submissionResults.perCardShip.toFixed(2)}/card` : "for entire batch"}
                />
                <NumField
                  label="Sell Fee"
                  value={submissionSellFee}
                  onChange={(v) => updateSubmissionSetting("sellFee", v)}
                  suffix="%"
                  hint="eBay ≈13%"
                />
              </div>
              {submissionTier === "valuebulk" && submission.length < 20 && submission.length > 0 && (
                <div className="mt-2 flex items-start gap-1.5 text-[10px] text-amber-400">
                  <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                  <span>Value Bulk requires 20+ cards. You have {submission.length}.</span>
                </div>
              )}
            </div>

            {submission.length === 0 ? (
              <div className="border border-dashed border-stone-800 rounded-sm py-16 text-center">
                <Package className="mx-auto text-stone-700 mb-3" size={32} />
                <div className="text-stone-500 text-sm">No cards in this submission yet.</div>
                <div className="text-stone-600 text-xs mt-1">Use the Calculator tab, then click "To Submission" to add cards here.</div>
              </div>
            ) : (
              <>
                {/* Aggregate stats */}
                <div className="border border-stone-800 rounded-sm p-6 mb-6 bg-gradient-to-br from-stone-900/40 to-stone-950">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-stone-500 font-medium mb-4">Batch Totals · {submission.length} cards</div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                    <StatBlock
                      label="Total Expected Value"
                      value={fmt$(submissionResults.totalEV)}
                      sublabel={fmt$Full(submissionResults.totalEV)}
                      tone={submissionResults.totalEV > 0 ? "positive" : "negative"}
                      large
                    />
                    <StatBlock
                      label="Batch ROI"
                      value={fmtPct(submissionResults.aggROI)}
                      sublabel={`Cost ${fmt$(submissionResults.totalCost)}`}
                      tone={submissionResults.aggROI > 0 ? "positive" : "negative"}
                      large
                    />
                    <StatBlock
                      label="Aggregate Sharpe"
                      value={submissionResults.aggSharpe.toFixed(2)}
                      sublabel="risk-adjusted"
                      tone={submissionResults.aggSharpe > 0.7 ? "positive" : submissionResults.aggSharpe > 0.3 ? "warning" : "negative"}
                      large
                    />
                    <StatBlock
                      label="Avg P(Loss)"
                      value={fmtPct(submissionResults.avgProbLoss * 100)}
                      sublabel="per card avg"
                      tone={submissionResults.avgProbLoss > 0.5 ? "negative" : submissionResults.avgProbLoss > 0.3 ? "warning" : "positive"}
                      large
                    />
                  </div>
                </div>

                {/* Per-card breakdown */}
                <div className="border border-stone-800 rounded-sm overflow-hidden">
                  <div className="grid grid-cols-[44px_2fr_repeat(4,1fr)_40px] gap-3 px-4 py-3 bg-stone-900 text-[10px] uppercase tracking-[0.15em] text-stone-500 font-medium">
                    <div></div>
                    <div>Card</div>
                    <div className="text-right">Raw $</div>
                    <div className="text-right">EV</div>
                    <div className="text-right">ROI</div>
                    <div className="text-right">Verdict</div>
                    <div></div>
                  </div>
                  {[...submissionResults.cardResults]
                    .sort((a, b) => (b.result.sharpe || 0) - (a.result.sharpe || 0))
                    .map((c) => {
                      const isDrag = c.result.ev < 0;
                      return (
                        <div key={c.id} className={`grid grid-cols-[44px_2fr_repeat(4,1fr)_40px] gap-3 px-4 py-3 border-t border-stone-800 hover:bg-stone-900/50 transition-colors items-center text-sm ${isDrag ? "bg-rose-950/10" : ""}`}>
                          {c.image ? (
                            <img src={c.image} alt="" className="w-10 h-14 object-cover bg-stone-800 border border-stone-700 rounded-sm" />
                          ) : (
                            <div className="w-10 h-14 bg-stone-900 border border-stone-800 rounded-sm" />
                          )}
                          <div className="min-w-0">
                            <div className="text-stone-100 font-medium truncate">{c.name}</div>
                            <div className="text-[10px] text-stone-500 font-mono">
                              {c.ownsCard ? "Already own" : "Buying"} · P(10) {c.pPSA10.toFixed(0)}%
                            </div>
                          </div>
                          <div className="text-right font-mono text-stone-300">{fmt$Full(c.rawCost)}</div>
                          <div className={`text-right font-mono ${c.result.ev > 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmt$Full(c.result.ev)}</div>
                          <div className={`text-right font-mono ${c.result.roi_pct > 0 || c.result.roi > 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtPct(c.result.roi)}</div>
                          <div className={`text-right text-[10px] font-mono uppercase tracking-wider ${
                            c.result.verdict === "STRONG_BUY" ? "text-emerald-300" :
                            c.result.verdict === "FAVORABLE" ? "text-emerald-400" :
                            c.result.verdict === "MARGINAL" ? "text-stone-300" :
                            c.result.verdict === "HIGH_RISK" ? "text-amber-400" :
                            "text-rose-400"
                          }`}>{c.result.verdict.replace("_", " ")}</div>
                          <button
                            onClick={() => removeFromSubmission(c.id)}
                            className="text-stone-600 hover:text-rose-400 transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      );
                    })}
                </div>

                {/* Hint about drags */}
                {submissionResults.cardResults.some((c) => c.result.ev < 0) && (
                  <div className="mt-4 px-4 py-3 bg-rose-950/20 border border-rose-900/40 rounded-sm text-[11px] text-rose-300/80 leading-relaxed">
                    Cards highlighted in red are <strong>dragging down the batch</strong> (negative EV). Removing them improves total expected return.
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === "watchlist" && (
          <div>
            <div className="mb-6">
              <h2 className="font-display text-2xl font-semibold mb-1">Watchlist</h2>
              <p className="text-sm text-stone-500">Saved evaluations, ranked by Sharpe ratio. Higher = better risk-adjusted return.</p>
            </div>
            {watchlist.length === 0 ? (
              <div className="border border-dashed border-stone-800 rounded-sm py-16 text-center">
                <BarChart3 className="mx-auto text-stone-700 mb-3" size={32} />
                <div className="text-stone-500 text-sm">No saved evaluations yet.</div>
                <div className="text-stone-600 text-xs mt-1">Run a calculation and click "Save to Watchlist."</div>
              </div>
            ) : (
              <div className="border border-stone-800 rounded-sm overflow-hidden">
                <div className="grid grid-cols-[2fr_repeat(5,1fr)_40px] gap-3 px-4 py-3 bg-stone-900 text-[10px] uppercase tracking-[0.15em] text-stone-500 font-medium">
                  <div>Card</div>
                  <div className="text-right">Raw $</div>
                  <div className="text-right">EV</div>
                  <div className="text-right">ROI</div>
                  <div className="text-right">P(Loss)</div>
                  <div className="text-right">Sharpe</div>
                  <div></div>
                </div>
                {[...watchlist].sort((a, b) => b.sharpe - a.sharpe).map((w) => (
                  <div key={w.id} className="grid grid-cols-[2fr_repeat(5,1fr)_40px] gap-3 px-4 py-3 border-t border-stone-800 hover:bg-stone-900/50 transition-colors items-center text-sm">
                    <div className="flex items-center gap-3">
                      {w.image ? (
                        <img src={w.image} alt="" className="w-10 h-14 object-cover bg-stone-800 border border-stone-700 rounded-sm flex-shrink-0" />
                      ) : (
                        <div className="w-10 h-14 bg-stone-900 border border-stone-800 rounded-sm flex-shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="text-stone-100 font-medium truncate">{w.name}</div>
                        <div className="text-[10px] text-stone-500 font-mono">{w.tier} · {new Date(w.timestamp).toLocaleDateString()}</div>
                      </div>
                    </div>
                    <div className="text-right font-mono text-stone-300">{fmt$Full(w.rawCost)}</div>
                    <div className={`text-right font-mono ${w.ev > 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmt$Full(w.ev)}</div>
                    <div className={`text-right font-mono ${w.roi > 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtPct(w.roi)}</div>
                    <div className="text-right font-mono text-stone-300">{fmtPct(w.probOfLoss * 100)}</div>
                    <div className={`text-right font-mono ${w.sharpe > 0.7 ? "text-emerald-400" : w.sharpe > 0.3 ? "text-amber-400" : "text-rose-400"}`}>{w.sharpe.toFixed(2)}</div>
                    <button
                      onClick={() => removeFromWatchlist(w.id)}
                      className="text-stone-600 hover:text-rose-400 transition-colors"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "guide" && (
          <div className="max-w-3xl space-y-8">
            <div>
              <h2 className="font-display text-3xl font-semibold mb-3">The Method</h2>
              <p className="text-stone-400 leading-relaxed">
                This tool computes the risk-adjusted expected value of buying a raw card and submitting it for PSA grading. It's not a crystal ball — it's a discipline that forces every assumption into the open so you can argue with the math instead of your gut.
              </p>
            </div>

            <Section title="The core equation">
              <p className="text-stone-400 leading-relaxed mb-3">
                For each possible grade outcome <span className="font-mono text-amber-400">i</span>:
              </p>
              <div className="bg-stone-900 border-l-2 border-amber-500 px-4 py-3 my-3 font-mono text-xs text-stone-300">
                EV = Σ P(grade<sub>i</sub>) × [Price<sub>i</sub> × (1 − fee%)] − Raw − Grading − Shipping
              </div>
              <p className="text-stone-400 leading-relaxed">
                Positive EV is necessary but not sufficient. A coin flip with $1,000 upside and −$500 downside has +$250 EV but is dangerous to size up unless you can run it many times.
              </p>
            </Section>

            <Section title="Why the bias haircut matters">
              <p className="text-stone-400 leading-relaxed">
                The PSA pop report tells you the 10-rate among <em className="text-stone-300">cards people chose to submit</em>. Submitters pre-screen — they don't send rough copies. The 10-rate among <em className="text-stone-300">random raw eBay copies</em> is meaningfully lower. The default 35% haircut is a starting heuristic; if you have personal grading data, replace it with your own observed delta.
              </p>
            </Section>

            <Section title="What Sharpe ratio means here">
              <p className="text-stone-400 leading-relaxed mb-2">
                The "Sharpe-like" ratio divides expected profit by the standard deviation of profit across outcomes. Rough heuristics:
              </p>
              <ul className="space-y-1.5 text-sm text-stone-400 font-mono">
                <li><span className="text-rose-400">&lt; 0.3</span> · Coin flip with marginal edge — pass unless you have many shots</li>
                <li><span className="text-amber-400">0.3 – 0.7</span> · Workable but thin. Verify comps, watch fees</li>
                <li><span className="text-emerald-400">0.7 – 1.5</span> · Solid. Most "good" submissions live here</li>
                <li><span className="text-emerald-300">&gt; 1.5</span> · Suspicious. Recheck inputs — you may have a stale comp</li>
              </ul>
            </Section>

            <Section title="What this tool doesn't model">
              <ul className="space-y-2 text-sm text-stone-400 list-none pl-0">
                <li className="flex gap-2"><ChevronRight size={14} className="text-amber-500 mt-1 flex-shrink-0" /><span><strong className="text-stone-300">Time value of money.</strong> A $200 EV that takes 6 months ties up capital. Discount accordingly.</span></li>
                <li className="flex gap-2"><ChevronRight size={14} className="text-amber-500 mt-1 flex-shrink-0" /><span><strong className="text-stone-300">Liquidity.</strong> Some PSA 10s sit for months. EV assumes you can sell at the comp.</span></li>
                <li className="flex gap-2"><ChevronRight size={14} className="text-amber-500 mt-1 flex-shrink-0" /><span><strong className="text-stone-300">Player/set drift.</strong> A graded card that emerges in 4 months may face a different market than the one you priced.</span></li>
                <li className="flex gap-2"><ChevronRight size={14} className="text-amber-500 mt-1 flex-shrink-0" /><span><strong className="text-stone-300">Card condition.</strong> P(10) is conditioned on a hypothetical "average" raw copy. Inspect the actual card.</span></li>
              </ul>
            </Section>

            <Section title="Recommended workflow">
              <ol className="space-y-2 text-sm text-stone-400 list-decimal pl-5">
                <li>Pull median 90-day sold comps for each grade from 130point or eBay sold listings.</li>
                <li>Pull current pop counts from psacard.com/pop for the exact card variant.</li>
                <li>Use a 30–40% bias haircut by default; tighten it for cards you can inspect in hand.</li>
                <li>Reject anything below 0.5 Sharpe unless you have a specific thesis (e.g., player breakout).</li>
                <li>Re-run the calc on the day you submit — comps move.</li>
              </ol>
            </Section>
          </div>
        )}
      </main>

      <footer className="border-t border-stone-800 mt-16">
        <div className="max-w-[1400px] mx-auto px-6 py-5 flex justify-between items-center text-[10px] text-stone-600 uppercase tracking-[0.2em]">
          <div>Cardstack · Risk-Adjusted Grading EV</div>
          <div>Not financial advice · Verify all comps</div>
        </div>
      </footer>
    </div>
  );
}

function SectionHeader({ num, title }) {
  return (
    <div className="flex items-baseline gap-3 pb-2 border-b border-stone-800">
      <span className="font-mono text-[10px] text-amber-500">{num}</span>
      <span className="font-display text-lg font-semibold tracking-tight">{title}</span>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <h3 className="font-display text-lg font-semibold mb-3 text-stone-100">{title}</h3>
      {children}
    </div>
  );
}
