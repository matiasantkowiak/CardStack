import React, { useState, useMemo, useEffect } from "react";
import { TrendingUp, TrendingDown, AlertTriangle, Plus, Trash2, Save, BarChart3, Calculator, Target, Activity, ChevronRight, Sparkles } from "lucide-react";

// ===== PSA grading tiers (current public pricing as of 2025; user can override) =====
const PSA_TIERS = [
  { id: "bulk",     name: "Bulk",          cost: 19,    maxValue: 199,   turnaround: "65 business days" },
  { id: "value",    name: "Value",         cost: 25,    maxValue: 499,   turnaround: "45 business days" },
  { id: "valueplus",name: "Value Plus",    cost: 40,    maxValue: 999,   turnaround: "20 business days" },
  { id: "regular",  name: "Regular",       cost: 75,    maxValue: 1499,  turnaround: "20 business days" },
  { id: "express",  name: "Express",       cost: 150,   maxValue: 2499,  turnaround: "10 business days" },
  { id: "superexp", name: "Super Express", cost: 300,   maxValue: 4999,  turnaround: "5 business days" },
  { id: "walkthru", name: "Walk-Through",  cost: 600,   maxValue: 9999,  turnaround: "3 business days" },
];

// ===== Core calculation engine =====
function computeEV({ rawCost, gradeProbabilities, gradePrices, gradingCost, shippingCost, sellFeePct }) {
  const grades = ["psa10", "psa9", "psa8", "psa7orLower"];
  const totalCost = rawCost + gradingCost + shippingCost;

  const outcomes = grades.map((g) => {
    const prob = gradeProbabilities[g] / 100;
    const grossPrice = gradePrices[g];
    const netPrice = grossPrice * (1 - sellFeePct / 100);
    const profit = netPrice - totalCost;
    return { grade: g, prob, grossPrice, netPrice, profit };
  });

  const ev = outcomes.reduce((sum, o) => sum + o.prob * o.profit, 0);
  const evPlusCost = ev + totalCost;
  const variance = outcomes.reduce((sum, o) => sum + o.prob * Math.pow(o.profit - ev, 2), 0);
  const stdDev = Math.sqrt(variance);
  const probOfLoss = outcomes.filter((o) => o.profit < 0).reduce((s, o) => s + o.prob, 0);
  const sharpe = stdDev > 0 ? ev / stdDev : 0;
  const breakEven10Rate = (() => {
    const p10Profit = gradePrices.psa10 * (1 - sellFeePct / 100) - totalCost;
    const otherEV = outcomes.filter((o) => o.grade !== "psa10").reduce((s, o) => {
      const reweighted = o.prob / (1 - gradeProbabilities.psa10 / 100);
      return s + reweighted * o.profit;
    }, 0);
    if (p10Profit <= otherEV) return null;
    return (-otherEV / (p10Profit - otherEV)) * 100;
  })();
  const roi = totalCost > 0 ? (ev / totalCost) * 100 : 0;

  return { outcomes, ev, evPlusCost, stdDev, probOfLoss, sharpe, breakEven10Rate, roi, totalCost };
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
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
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
  const max = Math.max(...outcomes.map((o) => Math.abs(o.profit)));
  return (
    <div className="space-y-2.5">
      {outcomes.map((o) => {
        const pct = max > 0 ? (Math.abs(o.profit) / max) * 100 : 0;
        const positive = o.profit >= 0;
        return (
          <div key={o.grade} className="grid grid-cols-[70px_1fr_90px_70px] gap-3 items-center">
            <div className="text-xs font-mono text-stone-300">{labels[o.grade]}</div>
            <div className="relative h-6 bg-stone-900 rounded-sm overflow-hidden">
              <div className="absolute inset-y-0 left-1/2 w-px bg-stone-700" />
              <div
                className={`absolute inset-y-0 ${positive ? "left-1/2 bg-emerald-600/60" : "right-1/2 bg-rose-600/60"} transition-all duration-500`}
                style={{ width: `${pct / 2}%` }}
              />
            </div>
            <div className={`text-xs font-mono text-right ${positive ? "text-emerald-400" : "text-rose-400"}`}>{fmt$Full(o.profit)}</div>
            <div className="text-xs font-mono text-stone-500 text-right">{fmtPct(o.prob * 100)}</div>
          </div>
        );
      })}
    </div>
  );
}

// ===== Stress test (sensitivity to PSA 10 rate) =====
function StressTest({ baseInputs }) {
  const points = [];
  for (let p10 = 0; p10 <= 100; p10 += 5) {
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
  const maxEV = Math.max(...points.map((p) => Math.abs(p.ev)));
  const breakEvenPoint = points.find((p) => p.ev >= 0);
  const currentP10 = baseInputs.gradeProbabilities.psa10;

  // Build SVG path
  const w = 100, h = 100;
  const pathD = points.map((p, i) => {
    const x = (p.p10 / 100) * w;
    const y = h / 2 - (p.ev / maxEV) * (h / 2 - 5);
    return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Activity size={12} className="text-amber-500" />
        <span className="text-[10px] uppercase tracking-[0.2em] text-stone-400 font-medium">EV vs. PSA 10 Rate</span>
      </div>
      <div className="relative bg-stone-900 rounded-sm p-3 h-44">
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-full overflow-visible">
          <line x1="0" y1={h / 2} x2={w} y2={h / 2} stroke="rgb(68 64 60)" strokeWidth="0.3" strokeDasharray="1,1" />
          {breakEvenPoint && (
            <line x1={breakEvenPoint.p10} y1="0" x2={breakEvenPoint.p10} y2={h} stroke="rgb(245 158 11 / 0.4)" strokeWidth="0.3" strokeDasharray="1,1" />
          )}
          <line x1={currentP10} y1="0" x2={currentP10} y2={h} stroke="rgb(244 244 245 / 0.4)" strokeWidth="0.4" />
          <path d={pathD} fill="none" stroke="rgb(245 158 11)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
          <circle cx={currentP10} cy={h / 2 - (points.find((p) => p.p10 === Math.round(currentP10 / 5) * 5)?.ev / maxEV) * (h / 2 - 5)} r="1.2" fill="rgb(245 158 11)" />
        </svg>
        <div className="absolute top-2 left-3 text-[9px] text-stone-600 font-mono">+{fmt$(maxEV)}</div>
        <div className="absolute bottom-2 left-3 text-[9px] text-stone-600 font-mono">-{fmt$(maxEV)}</div>
        <div className="absolute bottom-2 right-3 text-[9px] text-stone-600 font-mono">100%</div>
      </div>
      <div className="mt-2 text-[10px] text-stone-500 leading-relaxed font-light">
        {breakEvenPoint
          ? <>Break-even at <span className="text-amber-400 font-mono">{breakEvenPoint.p10}%</span> PSA 10 rate. You're modeling <span className="text-stone-300 font-mono">{currentP10.toFixed(1)}%</span>.</>
          : <span>EV remains negative across the entire 10-rate spectrum. Comps are off, costs are too high, or the card isn't worth grading.</span>}
      </div>
    </div>
  );
}

// ===== Main app =====
export default function CardGradingEV() {
  const [cardName, setCardName] = useState("");
  const [rawCost, setRawCost] = useState(50);
  const [tierId, setTierId] = useState("value");
  const [shippingCost, setShippingCost] = useState(15);
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

  // Load watchlist from browser localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem("watchlist");
      if (stored) setWatchlist(JSON.parse(stored));
    } catch (e) {}
  }, []);

  const tier = PSA_TIERS.find((t) => t.id === tierId) || PSA_TIERS[1];

  const probabilities = useMemo(() => {
    if (usePopReport) {
      return adjustPopReport({ popPSA10, popPSA9, popPSA8, popLower, biasHaircut });
    }
    return { psa10: manualP10, psa9: manualP9, psa8: manualP8, psa7orLower: manualPLower };
  }, [usePopReport, popPSA10, popPSA9, popPSA8, popLower, biasHaircut, manualP10, manualP9, manualP8, manualPLower]);

  const probSum = probabilities.psa10 + probabilities.psa9 + probabilities.psa8 + probabilities.psa7orLower;
  const probsValid = Math.abs(probSum - 100) < 0.5;

  const result = useMemo(
    () =>
      computeEV({
        rawCost,
        gradeProbabilities: probabilities,
        gradePrices: { psa10: pricePSA10, psa9: pricePSA9, psa8: pricePSA8, psa7orLower: priceLower },
        gradingCost: tier.cost,
        shippingCost,
        sellFeePct,
      }),
    [rawCost, probabilities, pricePSA10, pricePSA9, pricePSA8, priceLower, tier.cost, shippingCost, sellFeePct]
  );

  const evTone = result.ev > 50 ? "positive" : result.ev < 0 ? "negative" : "warning";

  const saveToWatchlist = async () => {
    if (!cardName.trim()) return;
    const entry = {
      id: Date.now(),
      name: cardName,
      rawCost,
      tier: tier.name,
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
                  <div className="grid grid-cols-2 gap-3">
                    <NumField label="Raw Buy Price" value={rawCost} onChange={setRawCost} prefix="$" />
                    <NumField label="Sell Fee" value={sellFeePct} onChange={setSellFeePct} suffix="%" hint="eBay ≈13%" />
                  </div>
                </div>
              </section>

              {/* Grading tier */}
              <section>
                <SectionHeader num="02" title="Grading" />
                <div className="space-y-3 mt-4">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-stone-400 font-medium mb-1.5">PSA Tier</div>
                    <select
                      value={tierId}
                      onChange={(e) => setTierId(e.target.value)}
                      className="w-full bg-stone-900 border border-stone-700 text-stone-100 text-sm py-2 px-3 rounded-sm focus:border-amber-500 focus:outline-none"
                    >
                      {PSA_TIERS.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} — ${t.cost} · max ${t.maxValue} · {t.turnaround}
                        </option>
                      ))}
                    </select>
                    {pricePSA10 > tier.maxValue && (
                      <div className="mt-2 flex items-start gap-1.5 text-[10px] text-amber-400">
                        <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                        <span>PSA 10 price (${pricePSA10}) exceeds tier max (${tier.maxValue}). PSA may bump you up a tier.</span>
                      </div>
                    )}
                  </div>
                  <NumField label="Shipping (Round Trip + Insurance)" value={shippingCost} onChange={setShippingCost} prefix="$" />
                </div>
              </section>

              {/* Sold comps */}
              <section>
                <SectionHeader num="03" title="Sold Comps" />
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
                <SectionHeader num="04" title="Grade Probabilities" />
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

              {/* Save */}
              <button
                onClick={saveToWatchlist}
                disabled={!cardName.trim()}
                className="w-full bg-amber-500 hover:bg-amber-400 disabled:bg-stone-800 disabled:text-stone-600 text-stone-950 disabled:cursor-not-allowed font-medium text-xs uppercase tracking-[0.2em] py-3 rounded-sm transition-colors flex items-center justify-center gap-2"
              >
                <Save size={13} />
                Save to Watchlist
              </button>
            </div>

            {/* RIGHT: Output */}
            <div className="space-y-6">
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

              {/* Stress test */}
              <div className="border border-stone-800 rounded-sm p-5">
                <StressTest
                  baseInputs={{
                    rawCost,
                    gradeProbabilities: probabilities,
                    gradePrices: { psa10: pricePSA10, psa9: pricePSA9, psa8: pricePSA8, psa7orLower: priceLower },
                    gradingCost: tier.cost,
                    shippingCost,
                    sellFeePct,
                  }}
                />
              </div>
            </div>
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
                    <div>
                      <div className="text-stone-100 font-medium">{w.name}</div>
                      <div className="text-[10px] text-stone-500 font-mono">{w.tier} · {new Date(w.timestamp).toLocaleDateString()}</div>
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
