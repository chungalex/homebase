import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import * as XLSX from "xlsx";

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
// localStorage mock — swap for real Supabase when deploying
const sb = {
  from: (table) => ({
    select: (cols) => ({
      order: (col, opts) => {
        try { return Promise.resolve({ data: JSON.parse(localStorage.getItem('hb_'+table) || '[]'), error: null }); } catch { return Promise.resolve({ data: [], error: null }); }
      }
    }),
    insert: (rows) => {
      try {
        const existing = JSON.parse(localStorage.getItem('hb_'+table) || '[]');
        const newRows = rows.map(r => ({ ...r, id: r.id || Date.now().toString(), created_at: r.created_at || new Date().toISOString() }));
        localStorage.setItem('hb_'+table, JSON.stringify([...newRows, ...existing]));
        return Promise.resolve({ error: null });
      } catch(e) { return Promise.resolve({ error: e }); }
    },
    delete: () => ({
      eq: (col, val) => {
        try {
          const existing = JSON.parse(localStorage.getItem('hb_'+table) || '[]');
          localStorage.setItem('hb_'+table, JSON.stringify(existing.filter(r => r[col] !== val)));
          return Promise.resolve({ error: null });
        } catch(e) { return Promise.resolve({ error: e }); }
      }
    }),
    update: (data) => ({
      eq: (col, val) => Promise.resolve({ error: null })
    }),
  })
};
const CLAUDE_KEY = import.meta.env.VITE_ANTHROPIC_KEY || "";

// ─── CLAUDE API ───────────────────────────────────────────────────────────────
async function callClaude(messages, system, tools) {
  const body = { model: "claude-sonnet-4-20250514", max_tokens: 1800, messages };
  if (system) body.system = system;
  if (tools) body.tools = tools;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
}

// ─── CALC ENGINE ──────────────────────────────────────────────────────────────
function solveIRR(cfs) {
  let lo = -0.9999, hi = 50;
  for (let i = 0; i < 3000; i++) {
    const mid = (lo + hi) / 2;
    const npv = cfs.reduce((s, c, t) => s + c / Math.pow(1 + mid, t), 0);
    if (Math.abs(npv) < 0.0001) return mid * 100;
    npv > 0 ? (lo = mid) : (hi = mid);
  }
  return ((lo + hi) / 2) * 100;
}
function mtgPay(p, r, n) { if (!p || !r) return p / n; const m = r / 12; return p * (m * Math.pow(1 + m, n)) / (Math.pow(1 + m, n) - 1); }
function remBal(p, r, n, paid) { if (!p || !r) return p * (1 - paid / n); const m = r / 12; return p * (Math.pow(1 + m, n) - Math.pow(1 + m, paid)) / (Math.pow(1 + m, n) - 1); }

function calc(f) {
  const price = +f.price || 0; if (!price) return null;
  const dp = (+f.downPct || 20) / 100, rate = (+f.interestRate || 7.25) / 100;
  const termYrs = +f.loanTerm || 30, units = +f.units || 1, rent = +f.monthlyRent || 0;
  const sqft = +f.sqft || 0, taxes = +f.taxes || 0, ins = +f.insurance || 0, hoa = +f.hoa || 0;
  const maint = +f.maintenance || price * 0.01, capex = +f.capex || price * 0.005;
  const mgmtPct = f.propertyMgmt ? (+f.mgmtPct || 10) / 100 : 0;
  const vac = (+f.vacancyRate || 8) / 100, app = (+f.appreciation || 3) / 100;
  const tb = (+f.taxBracket || 24) / 100, clPct = (+f.closingCosts || 3) / 100;
  const exitCap = (+f.exitCapRate || 5.5) / 100, holdYrs = +f.holdYears || 5, reno = +f.renovation || 0;
  const downAmt = price * dp, loanAmt = price - downAmt, clAmt = price * clPct;
  const totalCost = downAmt + clAmt + reno, n = termYrs * 12;
  const moMtg = mtgPay(loanAmt, rate, n), annDebt = moMtg * 12;
  const grossMoRent = rent * units, annGross = grossMoRent * 12;
  const vacLossMo = grossMoRent * vac, vacLossAnn = annGross * vac, egi = annGross - vacLossAnn;
  const taxMo = taxes / 12, insMo = ins / 12, maintMo = maint / 12, capexMo = capex / 12, mgmtMo = grossMoRent * mgmtPct;
  const opexMo = taxMo + insMo + hoa + maintMo + capexMo + mgmtMo, annOpex = opexMo * 12, noi = egi - annOpex;
  const annCF = noi - annDebt, moCF = annCF / 12;
  const capRate = noi / price * 100, coc = totalCost > 0 ? annCF / totalCost * 100 : 0;
  const grm = annGross > 0 ? price / annGross : 0, dscr = annDebt > 0 ? noi / annDebt : 0;
  const grossYield = annGross / price * 100, netYield = noi / price * 100;
  const expRatio = egi > 0 ? annOpex / egi * 100 : 0, breakEven = annGross > 0 ? (annOpex + annDebt) / annGross * 100 : 0;
  const debtYield = loanAmt > 0 ? noi / loanAmt * 100 : 0, yoc = totalCost > 0 ? noi / totalCost * 100 : 0;
  const annDepr = (price * 0.8) / 27.5, taxSav = annDepr * tb, effCF = annCF + taxSav, effCoC = totalCost > 0 ? effCF / totalCost * 100 : 0;
  const proj = []; let cumCF = 0; const irrCFs = [-totalCost];
  for (let y = 1; y <= 10; y++) {
    const pv = price * Math.pow(1 + app, y), rl = remBal(loanAmt, rate, n, y * 12), eq = pv - rl;
    const rg = grossMoRent * Math.pow(1.025, y - 1), egiY = rg * 12 * (1 - vac), opY = annOpex * Math.pow(1.02, y - 1);
    const noiY = egiY - opY, cfY = noiY - annDebt; cumCF += cfY;
    const exitPrc = y === holdYrs ? noiY / exitCap : null, exitProc = exitPrc ? exitPrc * 0.94 - rl : null;
    proj.push({ y, pv, rl, eq, cfY, effCFY: cfY + taxSav, cumCF, totalRet: (eq - downAmt) + cumCF, roi: totalCost > 0 ? ((eq - downAmt) + cumCF) / totalCost * 100 : 0, exitProc });
    irrCFs.push(y === holdYrs && exitProc ? cfY + exitProc : cfY);
  }
  const irr = solveIRR(irrCFs), exitProc = proj[holdYrs - 1]?.exitProc || 0;
  const totalDist = proj.slice(0, holdYrs).reduce((s, p) => s + p.cfY, 0) + exitProc, em = totalCost > 0 ? totalDist / totalCost : 0;
  const npv8 = irrCFs.reduce((s, c, t) => s + c / Math.pow(1.08, t), 0), npv10 = irrCFs.reduce((s, c, t) => s + c / Math.pow(1.10, t), 0);
  const rentMods = [-0.1, 0, 0.1], vacMods = [0.05, 0.08, 0.12];
  const sens = vacMods.map(v => rentMods.map(r => { const g = grossMoRent * (1 + r) * 12, e = g * (1 - v) - annOpex; return Math.round((e - annDebt) / 12); }));
  let score = "PASS", scoreLabel = "Does Not Meet Criteria", scoreVi = "Không Đạt Tiêu Chí", scoreColor = "#DC2626", scoreBg = "#FEF2F2";
  if (moCF > 300 && capRate > 5.5 && dscr > 1.25 && irr > 12) { score = "STRONG BUY"; scoreLabel = "Institutional-Grade Opportunity"; scoreVi = "Cơ Hội Đầu Tư Cấp Tổ Chức"; scoreColor = "#059669"; scoreBg = "#ECFDF5"; }
  else if (moCF > 100 && capRate > 4.5 && dscr > 1.1 && irr > 8) { score = "BUY"; scoreLabel = "Solid Investment — Proceed"; scoreVi = "Đầu Tư Tốt — Nên Tiến Hành"; scoreColor = "#2563EB"; scoreBg = "#EFF6FF"; }
  else if (moCF > 0 && capRate > 4 && dscr > 1.0) { score = "NEGOTIATE"; scoreLabel = "Marginal — Renegotiate Terms"; scoreVi = "Biên Mỏng — Cần Đàm Phán"; scoreColor = "#D97706"; scoreBg = "#FFFBEB"; }
  return { price, dp, downAmt, loanAmt, clAmt, reno, totalCost, rate, termYrs, n, moMtg, annDebt, totalInterest: annDebt * termYrs - loanAmt, ltv: loanAmt / price * 100, grossMoRent, annGross, vacLossMo, vacLossAnn, egi, taxMo, insMo, hoa, maintMo, capexMo, mgmtMo, opexMo, annOpex, totalMoExp: moMtg + opexMo + vacLossMo, noi, annCF, moCF, capRate, coc, grm, dscr, grossYield, netYield, expRatio, breakEven, debtYield, yoc, ppu: price / units, pricePerSqft: sqft ? price / sqft : 0, sqft, units, annDepr, taxSav, effCF, effCoC, irr, em, npv8, npv10, exitProc, holdYrs, proj, sens, rentMods, vacMods, score, scoreLabel, scoreVi, scoreColor, scoreBg };
}

const f$ = v => v == null ? "—" : `$${Math.round(Math.abs(v)).toLocaleString()}`;
const f$s = v => v == null ? "—" : `${v < 0 ? "-" : ""}$${Math.round(Math.abs(v)).toLocaleString()}`;
const fP = (v, d = 2) => v == null ? "—" : `${v.toFixed(d)}%`;
const fX = (v, d = 2) => v == null ? "—" : `${v.toFixed(d)}x`;

const DEF = { address: "", price: "", downPct: "20", interestRate: "7.25", loanTerm: "30", units: "1", monthlyRent: "", sqft: "", taxes: "", insurance: "", hoa: "0", maintenance: "", capex: "", mgmtPct: "10", vacancyRate: "8", appreciation: "3", taxBracket: "24", closingCosts: "3", exitCapRate: "5.5", holdYears: "5", renovation: "0", propertyMgmt: true, notes: "" };

// ─── VIRTUAL ASSISTANT ────────────────────────────────────────────────────────
const ASSISTANT_MSGS = {
  home: ["Welcome back! 🌸 How are you feeling today? Ready to look at some deals?", "Chào mừng trở lại! 🌸 Hôm nay bạn cảm thấy thế nào? Sẵn sàng xem các giao dịch không?"],
  analyze: ["I see you're analyzing a deal! Once you fill in the price and rent, I'll watch the numbers with you. Don't worry — I'll flag anything that looks off. 📊", "Tôi thấy bạn đang phân tích một giao dịch! Khi bạn điền giá và tiền thuê, tôi sẽ theo dõi các con số cùng bạn."],
  compare: ["Here are all your saved deals. Use the Compare button to put them side by side — that's often when the best choice becomes obvious! 🗂️", "Đây là tất cả các giao dịch đã lưu của bạn. Dùng nút So Sánh để đặt chúng cạnh nhau!"],
  dd: ["Due diligence is where deals are won or lost. Take your time here — this checklist is what professionals use. You're doing great! ✅", "Thẩm định là nơi các giao dịch được quyết định. Hãy dành thời gian ở đây — danh sách này là những gì các chuyên gia sử dụng."],
  freedom: ["This is my favorite page. 🕊️ Every time you save a property that cash flows, that number moves closer to your goal. You're building something real.", "Đây là trang yêu thích của tôi. 🕊️ Mỗi khi bạn lưu một bất động sản tạo ra dòng tiền, con số đó tiến gần hơn đến mục tiêu của bạn."],
  find: ["Let me help you hunt for deals! The more specific your filters, the better I can search. Don't be afraid to set high standards — good deals exist. 🔍", "Hãy để tôi giúp bạn tìm kiếm giao dịch! Bộ lọc càng cụ thể, tôi tìm kiếm càng hiệu quả."],
  legal: ["This is your protection section. 🛡️ Real estate is mostly smooth sailing — but it helps to know your rights before you need them. Ask me anything.", "Đây là phần bảo vệ của bạn. 🛡️ Bất động sản hầu hết đều suôn sẻ — nhưng biết quyền lợi của bạn trước khi cần chúng là rất hữu ích."],
  learn: ["Ask me anything — no question is too basic! I love explaining these concepts. And everything I say comes in both English and Vietnamese, always. 💬", "Hỏi tôi bất cứ điều gì — không có câu hỏi nào quá cơ bản! Tôi thích giải thích các khái niệm này."],
};

// ─── LEGAL SCENARIOS ──────────────────────────────────────────────────────────
const LEGAL_SCENARIOS = [
  { id: "nonpayment", en: "Tenant Hasn't Paid Rent", vi: "Người Thuê Chưa Trả Tiền", icon: "💸", urgency: "high" },
  { id: "eviction", en: "Need to Evict a Tenant", vi: "Cần Trục Xuất Người Thuê", icon: "🚪", urgency: "high" },
  { id: "damage", en: "Tenant Damaged the Property", vi: "Người Thuê Làm Hỏng Tài Sản", icon: "🔨", urgency: "medium" },
  { id: "deposit", en: "Security Deposit Dispute", vi: "Tranh Chấp Tiền Đặt Cọc", icon: "🏦", urgency: "medium" },
  { id: "unauthorized", en: "Unauthorized Occupants / Pets", vi: "Người Ở / Thú Cưng Không Phép", icon: "🐕", urgency: "low" },
  { id: "harassment", en: "Tenant Claims Harassment", vi: "Người Thuê Khiếu Nại Quấy Rối", icon: "⚖️", urgency: "high" },
  { id: "lease_break", en: "Tenant Breaking Lease Early", vi: "Người Thuê Phá Vỡ Hợp Đồng Sớm", icon: "📄", urgency: "medium" },
  { id: "noise", en: "Noise / Neighbor Complaints", vi: "Khiếu Nại Tiếng Ồn / Hàng Xóm", icon: "📢", urgency: "low" },
  { id: "repairs", en: "Tenant Demands Repairs", vi: "Người Thuê Yêu Cầu Sửa Chữa", icon: "🔧", urgency: "medium" },
  { id: "discrimination", en: "Fair Housing / Discrimination Claim", vi: "Khiếu Nại Phân Biệt Đối Xử", icon: "🏛️", urgency: "high" },
];

// ─── DD PHASES ────────────────────────────────────────────────────────────────
const DD = [
  { phase: "Phase 1", en: "Initial Screening", vi: "Sàng Lọc Ban Đầu", time: "1–2 hrs", who: "Self", color: "#0EA5E9", tasks: [{ en: "Apply 1% Rule and GRM screen", vi: "Áp dụng Quy Tắc 1% và GRM" }, { en: "Verify price vs. comps on Zillow/Redfin", vi: "So sánh giá với giao dịch gần đây" }, { en: "Check market vacancy rates", vi: "Kiểm tra tỷ lệ phòng trống thị trường" }, { en: "Drive/walk the neighborhood", vi: "Đi qua khu vực" }, { en: "Search address for code violations", vi: "Tìm kiếm vi phạm xây dựng" }] },
  { phase: "Phase 2", en: "Financial Deep Dive", vi: "Phân Tích Tài Chính Sâu", time: "3–5 hrs", who: "Self", color: "#8B5CF6", tasks: [{ en: "Request trailing 12-month P&L from seller", vi: "Yêu cầu báo cáo P&L 12 tháng" }, { en: "Verify rent rolls and actual rents", vi: "Xác minh danh sách thuê và tiền thuê" }, { en: "Review all current leases", vi: "Xem tất cả hợp đồng thuê" }, { en: "Confirm utility responsibilities", vi: "Xác nhận trách nhiệm tiện ích" }, { en: "Run full HomeBase analysis with stress test", vi: "Chạy phân tích HomeBase đầy đủ" }] },
  { phase: "Phase 3", en: "Physical Inspection", vi: "Kiểm Tra Thực Tế", time: "Half day + 1wk", who: "Inspector ($400–700)", color: "#F59E0B", tasks: [{ en: "Hire licensed inspector — roof, foundation, plumbing, electrical", vi: "Thuê kiểm tra viên — mái, móng, ống nước, điện" }, { en: "Walk every unit — photograph deferred maintenance", vi: "Đi qua từng căn — chụp ảnh bảo trì trì hoãn" }, { en: "Get 3 contractor bids for major repairs", vi: "Lấy 3 báo giá thầu" }, { en: "Verify HVAC and water heater ages", vi: "Kiểm tra tuổi HVAC và máy nước nóng" }, { en: "Check for environmental concerns (lead, asbestos, mold)", vi: "Kiểm tra vấn đề môi trường (chì, amiang, nấm mốc)" }] },
  { phase: "Phase 4", en: "Market Research", vi: "Nghiên Cứu Thị Trường", time: "2–4 hrs", who: "Self", color: "#10B981", tasks: [{ en: "Pull 5–10 rental comps from Rentometer", vi: "Tìm 5–10 căn cho thuê tương đương" }, { en: "Research major employers and job growth", vi: "Nghiên cứu nhà tuyển dụng lớn" }, { en: "Check school ratings on GreatSchools.org", vi: "Kiểm tra xếp hạng trường học" }, { en: "Review crime statistics", vi: "Xem thống kê tội phạm" }, { en: "Confirm zoning and development plans", vi: "Xác nhận phân vùng" }] },
  { phase: "Phase 5", en: "Legal & Title", vi: "Pháp Lý & Quyền Sở Hữu", time: "2–3 weeks", who: "Attorney + Title", color: "#EF4444", tasks: [{ en: "Order title search — confirm no liens", vi: "Tìm kiếm quyền sở hữu" }, { en: "Purchase lender and owner title insurance", vi: "Mua bảo hiểm quyền sở hữu" }, { en: "Attorney review of purchase agreement", vi: "Luật sư xem xét hợp đồng" }, { en: "Confirm property boundaries and easements", vi: "Xác nhận ranh giới tài sản" }, { en: "Review all seller disclosures in full", vi: "Xem đầy đủ công bố của người bán" }] },
  { phase: "Phase 6", en: "Financing & Close", vi: "Vay Vốn & Đóng Giao Dịch", time: "30–45 days", who: "Lender + Escrow", color: "#6366F1", tasks: [{ en: "Submit complete loan application", vi: "Nộp đơn vay đầy đủ" }, { en: "Respond to underwriting conditions within 24 hrs", vi: "Trả lời điều kiện bảo lãnh trong 24 giờ" }, { en: "Lock interest rate when favorable", vi: "Khóa lãi suất khi thuận lợi" }, { en: "Final walkthrough 24–48 hours before closing", vi: "Kiểm tra lần cuối" }, { en: "Sign documents, wire funds, receive keys", vi: "Ký hợp đồng, chuyển tiền, nhận chìa khóa" }] },
];

const GLOSS = [
  { en: "Cap Rate", vi: "Tỷ Lệ Vốn Hóa", d: "NOI ÷ purchase price. Target 5–8% for stabilized rentals.", dvi: "NOI ÷ giá mua. Mục tiêu 5–8% cho thuê ổn định." },
  { en: "IRR", vi: "Tỷ Suất Hoàn Vốn Nội Bộ", d: "Annualized total return including all cash flows AND exit proceeds. Target >12% levered.", dvi: "Lợi nhuận hàng năm toàn diện. Mục tiêu >12% có vay." },
  { en: "Equity Multiple", vi: "Hệ Số Nhân Vốn", d: "Total money returned ÷ invested. 2.0x = doubled your money. Target >1.7x over 5 years.", dvi: "Tổng tiền nhận lại ÷ đầu tư. 2,0x = tăng gấp đôi. Mục tiêu >1,7x trong 5 năm." },
  { en: "DSCR", vi: "Tỷ Số Thanh Toán Nợ", d: "NOI ÷ annual mortgage. Must be >1.0. Lenders require >1.25x.", dvi: "NOI ÷ tiền trả vay năm. Phải >1,0. Ngân hàng yêu cầu >1,25x." },
  { en: "Debt Yield", vi: "Lãi Suất Nợ", d: "NOI ÷ loan amount. Institutional benchmark >8%.", dvi: "NOI ÷ số tiền vay. Điểm chuẩn tổ chức >8%." },
  { en: "Cash-on-Cash", vi: "Lợi Nhuận Tiền Mặt", d: "Annual cash flow ÷ total equity invested. Target >8%.", dvi: "Dòng tiền năm ÷ tổng vốn đầu tư. Mục tiêu >8%." },
  { en: "NOI", vi: "Thu Nhập Hoạt Động Ròng", d: "Effective Gross Income minus all operating expenses, before debt service.", dvi: "Thu nhập trừ mọi chi phí vận hành, TRƯỚC tiền trả nợ." },
  { en: "Break-even Occupancy", vi: "Lấp Đầy Hòa Vốn", d: "Min occupancy to cover all costs including mortgage. Target below 80%.", dvi: "Tỷ lệ lấp đầy tối thiểu. Mục tiêu dưới 80%." },
  { en: "1031 Exchange", vi: "Hoán Đổi 1031", d: "Sell and reinvest within 180 days — defer 100% capital gains tax.", dvi: "Bán và tái đầu tư trong 180 ngày — hoãn 100% thuế lãi vốn." },
  { en: "CapEx", vi: "Chi Phí Cải Tạo Lớn", d: "Major infrequent repairs. Budget 0.5–1% of value annually.", dvi: "Sửa chữa lớn không thường xuyên. Dự trù 0,5–1% giá trị/năm." },
];

// ─── ANIMATED NUMBER ──────────────────────────────────────────────────────────
function AnimNum({ target, prefix = "", suffix = "", duration = 1200 }) {
  const [display, setDisplay] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    const start = prev.current, end = +target || 0, startTime = Date.now();
    const step = () => {
      const p = Math.min((Date.now() - startTime) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(start + (end - start) * ease));
      if (p < 1) requestAnimationFrame(step);
      else { prev.current = end; }
    };
    requestAnimationFrame(step);
  }, [target]);
  return <span>{prefix}{display.toLocaleString()}{suffix}</span>;
}

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [nav, setNav] = useState("home");
  const [form, setForm] = useState(DEF);
  const [m, setM] = useState(null);
  const [aiText, setAiText] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [properties, setProperties] = useState([]);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState(null);
  const [importMode, setImportMode] = useState(null);
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState(null);
  const [findQ, setFindQ] = useState({ location: "", budget: "", minBudget: "", type: "Single Family", strategy: "Buy & Hold", minCapRate: "5", maxGRM: "14", minCashFlow: "200", minUnits: "1", maxUnits: "10", yearBuiltMin: "", listingAge: "any", sellerMotivation: "any", state: "" });
  const [findRes, setFindRes] = useState(null);
  const [findLoad, setFindLoad] = useState(false);
  const [concerns, setConcerns] = useState([]);
  const [concernInput, setConcernInput] = useState("");
  const [concernCategory, setConcernCategory] = useState("general");
  const [concernAI, setConcernAI] = useState({});
  const [dealStatus, setDealStatus] = useState("prospect");
  const [legalNotes, setLegalNotes] = useState([]);
  const [legalLoading, setLegalLoading] = useState(false);
  const [legalResult, setLegalResult] = useState(null);
  const [selectedScenario, setSelectedScenario] = useState(null);
  const [legalContext, setLegalContext] = useState("");
  const [onboarding, setOnboarding] = useState(false);
  const [onboardStep, setOnboardStep] = useState(0);
  const [goals, setGoals] = useState({ currentDays: 5, targetDays: 3, incomePerDay: "", avgCFPerProp: "400", propsOwned: 0 });
  const [alertForm, setAlertForm] = useState({ location: "", budget: "", type: "Single Family", strategy: "Buy & Hold", minCapRate: "5", minCF: "200", email: "", frequency: "weekly" });
  const [alertSaved, setAlertSaved] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantMsgs, setAssistantMsgs] = useState([]);
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [assistantPulse, setAssistantPulse] = useState(false);
  const fileRef = useRef();

  useEffect(() => { setM(calc(form)); }, [form]);
  const sf = useCallback((k, v) => setForm(p => ({ ...p, [k]: v })), []);

  // Load from Supabase
  useEffect(() => {
    loadProps();
    const visited = localStorage.getItem("hb_visited");
    if (!visited) { setOnboarding(true); localStorage.setItem("hb_visited", "1"); }
    // Load legal notes from localStorage
    const ln = localStorage.getItem("hb_legal_notes");
    if (ln) setLegalNotes(JSON.parse(ln));
    const concerns_saved = localStorage.getItem("hb_concerns");
    if (concerns_saved) setConcerns(JSON.parse(concerns_saved));
  }, []);

  // Show assistant message when nav changes
  useEffect(() => {
    const msgs = ASSISTANT_MSGS[nav];
    if (msgs) {
      setTimeout(() => {
        setAssistantPulse(true);
        setTimeout(() => setAssistantPulse(false), 3000);
      }, 800);
    }
  }, [nav]);

  async function loadProps() {
    const { data } = await sb.from("properties").select("*").order("created_at", { ascending: false });
    if (data) setProperties(data);
  }

  async function saveProperty() {
    if (!m) return;
    setSaving(true);
    const row = {
      address: form.address, price: +form.price || 0, units: +form.units || 1, sqft: +form.sqft || 0,
      down_pct: +form.downPct || 20, interest_rate: +form.interestRate || 7.25, loan_term: +form.loanTerm || 30,
      closing_costs: +form.closingCosts || 3, renovation: +form.renovation || 0,
      monthly_rent: +form.monthlyRent || 0, vacancy_rate: +form.vacancyRate || 8,
      taxes: +form.taxes || 0, insurance: +form.insurance || 0, hoa: +form.hoa || 0,
      maintenance: +form.maintenance || 0, capex: +form.capex || 0,
      property_mgmt: form.propertyMgmt, mgmt_pct: +form.mgmtPct || 10,
      appreciation: +form.appreciation || 3, tax_bracket: +form.taxBracket || 24,
      exit_cap_rate: +form.exitCapRate || 5.5, hold_years: +form.holdYears || 5,
      notes: form.notes || "", deal_status: dealStatus,
      monthly_cf: Math.round(m.moCF), cap_rate: +m.capRate.toFixed(2),
      irr: +m.irr.toFixed(2), coc_return: +m.coc.toFixed(2), dscr: +m.dscr.toFixed(2),
      equity_multiple: +m.em.toFixed(2), score: m.score, score_color: m.scoreColor,
    };
    const { error } = await sb.from("properties").insert([row]);
    setSaving(false);
    if (!error) { setSavedMsg("Saved! · Đã lưu! ✓"); loadProps(); setTimeout(() => setSavedMsg(null), 3000); }
  }

  async function deleteProperty(id) {
    await sb.from("properties").delete().eq("id", id);
    loadProps();
  }

  async function importFromUrl() {
    if (!importUrl.trim()) return;
    setImporting(true); setImportStatus("Searching listing…");
    try {
      const text = await callClaude(
        [{ role: "user", content: `Extract all financial and property data from this listing: ${importUrl}\nReturn ONLY valid JSON: {address,price,units,sqft,monthlyRent,taxes,insurance,hoa,capRate,noi,notes}. Null for missing.` }],
        "Real estate data extraction. Return ONLY valid JSON.",
        [{ type: "web_search_20250305", name: "web_search" }]
      );
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      const up = {}; Object.entries(parsed).forEach(([k, v]) => { if (v !== null && DEF.hasOwnProperty(k)) up[k] = String(v); });
      setForm(p => ({ ...p, ...up }));
      setImportStatus("success");
      setTimeout(() => { setImportMode(null); setImportStatus(null); setImportUrl(""); }, 2000);
    } catch { setImportStatus("Could not auto-extract all fields. Fill remaining manually."); }
    setImporting(false);
  }

  async function importPdf(file) {
    setImporting(true); setImportStatus("Reading Offering Memorandum…");
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = rej; r.readAsDataURL(file); });
    setImportStatus("Extracting data…");
    try {
      const text = await callClaude([{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }, { type: "text", text: "Extract all financial data. Return ONLY valid JSON: {address,price,units,sqft,monthlyRent,taxes,insurance,hoa,maintenance,capex,vacancyRate,capRate,noi,notes}." }] }], "Extract real estate data. Return ONLY valid JSON.");
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      const up = {}; Object.entries(parsed).forEach(([k, v]) => { if (v !== null) up[k] = String(v); });
      setForm(p => ({ ...p, ...up }));
      setImportStatus("success");
      setTimeout(() => { setImportMode(null); setImportStatus(null); }, 2000);
    } catch { setImportStatus("Partially extracted. Please verify fields."); }
    setImporting(false);
  }

  async function runAI() {
    if (!m) return;
    setAiLoading(true); setAiText(null);
    const concernsSummary = concerns.length > 0 ? `\n\nDEAL CONCERNS LOGGED:\n${concerns.map(c => `- [${c.category.toUpperCase()}] ${c.text}`).join("\n")}` : "";
    const prompt = `You are a senior PE real estate analyst. Analyze this rental property for a Vietnamese-American dentist building passive income. Write in BOTH English AND Vietnamese — alternate sections.

Property: ${form.address || "Subject Property"} | Price: ${f$(m.price)} | Units: ${m.units}
Total Equity: ${f$(m.totalCost)} | Monthly CF: ${f$s(m.moCF)} | NOI: ${f$(m.noi)}
IRR: ${fP(m.irr)} | EM: ${fX(m.em)} | Cap Rate: ${fP(m.capRate)} | DSCR: ${fX(m.dscr)}
GRM: ${fX(m.grm)} | Break-even: ${fP(m.breakEven)} | NPV @8%: ${f$(m.npv8)}
Deal Status: ${dealStatus}${concernsSummary}
Notes: ${form.notes || "None"}

Sections required:
**Executive Summary / Tóm Tắt**
**Investment Thesis / Luận Điểm**  
**Strengths / Điểm Mạnh**
**Risks & Mitigants / Rủi Ro** (address each logged concern specifically if any)
**Concern Assessment / Đánh Giá Mối Lo Ngại** (if concerns exist: is this still a viable deal despite them? What is the impact on returns?)
**Negotiation Leverage / Đòn Bẩy Đàm Phán**
**Verdict / Kết Luận**`;
    try { setAiText(await callClaude([{ role: "user", content: prompt }])); } catch { setAiText("Analysis unavailable. Please try again."); }
    setAiLoading(false);
  }

  async function analyzeConcern(idx) {
    const concern = concerns[idx];
    if (!concern || !m) return;
    setConcernAI(p => ({ ...p, [idx]: "loading" }));
    const prompt = `A real estate investor has logged this concern about a property they're analyzing:

Category: ${concern.category}
Concern: ${concern.text}
Property: ${form.address || "Subject Property"} | Price: ${f$(m.price)} | Monthly CF: ${f$s(m.moCF)} | Cap Rate: ${fP(m.capRate)}

Provide a brief analysis in BOTH English AND Vietnamese:
1. Severity (Low/Medium/High/Deal-Breaker)
2. Impact on the deal financially if real
3. How to verify this concern
4. Whether the deal can continue if this is confirmed
5. One specific action to take

Keep it concise — 2-3 sentences per point. Format: [EN] ... [VI] ...`;
    try {
      const text = await callClaude([{ role: "user", content: prompt }]);
      setConcernAI(p => ({ ...p, [idx]: text }));
    } catch { setConcernAI(p => ({ ...p, [idx]: "Error analyzing. Please try again." })); }
  }

  function addConcern() {
    if (!concernInput.trim()) return;
    const newConcerns = [...concerns, { text: concernInput, category: concernCategory, date: new Date().toLocaleDateString(), id: Date.now() }];
    setConcerns(newConcerns);
    localStorage.setItem("hb_concerns", JSON.stringify(newConcerns));
    setConcernInput("");
  }

  function removeConcern(id) {
    const newC = concerns.filter(c => c.id !== id);
    setConcerns(newC);
    localStorage.setItem("hb_concerns", JSON.stringify(newC));
  }

  async function runLegalAnalysis() {
    if (!selectedScenario || !legalContext.trim()) return;
    setLegalLoading(true); setLegalResult(null);
    const scenario = LEGAL_SCENARIOS.find(s => s.id === selectedScenario);
    const prompt = `You are an experienced real estate attorney advising a Vietnamese-American landlord. Provide PRACTICAL, ACTIONABLE advice in BOTH English AND Vietnamese.

Situation: ${scenario?.en}
Details provided: ${legalContext}
Property state (if mentioned): ${form.address?.split(",").slice(-2).join(",") || "Not specified"}

Provide:
**Immediate Steps (Next 48 Hours) / Bước Ngay Lập Tức**
**Your Legal Rights / Quyền Lợi Của Bạn**  
**What NOT to Do / Những Điều Không Được Làm**
**Timeline & Process / Tiến Trình & Quy Trình**
**When to Hire an Attorney / Khi Nào Thuê Luật Sư**
**Estimated Cost of Resolution / Chi Phí Ước Tính**
**Key Documents to Prepare / Tài Liệu Cần Chuẩn Bị**

Important disclaimer: This is general information, not legal advice. Always consult a licensed attorney in your state for specific situations.

Format: [EN] section content [VI] Vietnamese translation. Alternate.`;
    try {
      const text = await callClaude([{ role: "user", content: prompt }]);
      setLegalResult(text);
      // Save to notes
      const note = { scenario: scenario?.en, context: legalContext, result: text, date: new Date().toLocaleDateString(), id: Date.now() };
      const newNotes = [note, ...legalNotes];
      setLegalNotes(newNotes);
      localStorage.setItem("hb_legal_notes", JSON.stringify(newNotes));
    } catch { setLegalResult("Analysis unavailable. Please try again."); }
    setLegalLoading(false);
  }

  async function runFind() {
    setFindLoad(true); setFindRes(null);
    const q = findQ;
    const prompt = `You are a senior real estate acquisitions analyst finding SPECIFIC, CURRENT rental property deals. Search the web right now for real listings.

SEARCH CRITERIA:
- Location: ${q.location || "best US rental markets"}
- Price Range: $${(+q.minBudget || 0).toLocaleString()} – $${(+q.budget || 0).toLocaleString() || "flexible"}
- Asset Type: ${q.type}
- Investment Strategy: ${q.strategy}
- Min Cap Rate: ${q.minCapRate}%
- Max GRM: ${q.maxGRM}x
- Min Monthly Cash Flow Target: $${q.minCashFlow}
- Units Range: ${q.minUnits}–${q.maxUnits}
- Year Built After: ${q.yearBuiltMin || "any"}
- Listing Age: ${q.listingAge}
- State: ${q.state || "any"}
- Seller Motivation: ${q.sellerMotivation}

Search LoopNet, Zillow, Realtor.com, CoStar, MLS listings, and Crexi right now.

Return a structured report for a Vietnamese-American dentist who is a beginner investor:

For each deal found (aim for 4-6 specific properties), use EXACTLY this format:

---DEAL---
ADDRESS: [full address]
PRICE: $[price]
UNITS: [number]
ASKING CAP RATE: [%]
ESTIMATED MONTHLY CASH FLOW: $[amount]
LISTING PLATFORM: [LoopNet/Zillow/etc]
LISTING URL: [direct URL if available, or search URL]
HOW TO CONTACT: [agent name if available, phone, email, or how to reach seller]
WHY THIS DEAL: [2-3 sentences on why it fits the criteria]
GREEN FLAGS: [2-3 specific positives]
WATCH OUT FOR: [1-2 specific concerns]
HOMEBASE SCORE: [Strong Buy / Buy / Negotiate / Pass]
---END DEAL---

After the deals, add:
MARKET OVERVIEW: Current cap rates, trends, what's happening in this market
BEST PLATFORMS RIGHT NOW: Top 5 with direct search URLs for these criteria
OFF-MARKET STRATEGY: How to find deals before they list publicly
NEGOTIATION ENVIRONMENT: Is it buyer's or seller's market? How aggressive to bid?

Write everything in BOTH English and Vietnamese.`;

    try { setFindRes(await callClaude([{ role: "user", content: prompt }], null, [{ type: "web_search_20250305", name: "web_search" }])); }
    catch { setFindRes("Error searching. Please try again."); }
    setFindLoad(false);
  }

  async function chatWithAssistant(msg) {
    if (!msg.trim() || assistantLoading) return;
    setAssistantInput("");
    setAssistantLoading(true);
    const currentMsg = ASSISTANT_MSGS[nav];
    const contextStr = m ? `Current deal: ${form.address || "unnamed"}, Price: ${f$(m.price)}, Monthly CF: ${f$s(m.moCF)}, Score: ${m.score}` : "No deal currently loaded";
    const newMsgs = [...assistantMsgs, { role: "user", content: msg }];
    setAssistantMsgs(newMsgs);
    try {
      const text = await callClaude(
        newMsgs.map(m => ({ role: m.role, content: m.content })),
        `You are Lan — a warm, knowledgeable, bilingual Vietnamese-American real estate advisor and personal guide built into this app. You are helping a Vietnamese-American dentist named "Mẹ" (or whatever she tells you her name is) learn to invest in rental properties to eventually work less. 

Current page: ${nav}
${contextStr}
User's freedom goal: Replace ${goals.currentDays - goals.targetDays} clinic days per week

Personality: warm, encouraging like a smart friend, never condescending, uses both English and Vietnamese naturally. Give short, actionable responses. Format: brief English paragraph, then brief Vietnamese paragraph. Max 150 words total. Be specific to what she's currently doing on the app.`
      );
      setAssistantMsgs([...newMsgs, { role: "assistant", content: text }]);
    } catch { setAssistantMsgs([...newMsgs, { role: "assistant", content: "Sorry, I had a connection issue! Try again 🌸 / Xin lỗi, có sự cố kết nối! Thử lại nhé 🌸" }]); }
    setAssistantLoading(false);
  }

  const fc = useMemo(() => {
    const dtr = goals.currentDays - goals.targetDays;
    const itr = dtr * (+goals.incomePerDay || 0) * 52 / 12;
    const pn = goals.avgCFPerProp > 0 ? Math.ceil(itr / +goals.avgCFPerProp) : 0;
    const prog = pn > 0 ? Math.min((goals.propsOwned / pn) * 100, 100) : 0;
    return { dtr, itr, pn, prog };
  }, [goals]);

  const pages = {
    home: <HomePage setNav={setNav} m={m} properties={properties} fc={fc} goals={goals} />,
    analyze: <AnalyzePage form={form} sf={sf} setForm={setForm} m={m} aiText={aiText} aiLoading={aiLoading} onAI={runAI} onSave={saveProperty} saving={saving} savedMsg={savedMsg} importMode={importMode} setImportMode={setImportMode} importUrl={importUrl} setImportUrl={setImportUrl} importing={importing} importStatus={importStatus} onImportUrl={importFromUrl} onImportPdf={importPdf} fileRef={fileRef} concerns={concerns} setConcerns={setConcerns} concernInput={concernInput} setConcernInput={setConcernInput} concernCategory={concernCategory} setConcernCategory={setConcernCategory} concernAI={concernAI} onAnalyzeConcern={analyzeConcern} onAddConcern={addConcern} onRemoveConcern={removeConcern} dealStatus={dealStatus} setDealStatus={setDealStatus} />,
    compare: <ComparePage properties={properties} onDelete={deleteProperty} onLoad={p => { setForm({ ...DEF, address: p.address || "", price: String(p.price || ""), units: String(p.units || 1), monthlyRent: String(p.monthly_rent || ""), downPct: String(p.down_pct || 20), interestRate: String(p.interest_rate || 7.25), loanTerm: String(p.loan_term || 30), taxes: String(p.taxes || ""), insurance: String(p.insurance || ""), hoa: String(p.hoa || 0), propertyMgmt: p.property_mgmt, notes: p.notes || "" }); setNav("analyze"); }} />,
    dd: <DDPage />,
    freedom: <FreedomPage goals={goals} setGoals={setGoals} fc={fc} properties={properties} />,
    find: <FindPage q={findQ} setQ={setFindQ} result={findRes} loading={findLoad} onFind={runFind} alertForm={alertForm} setAlertForm={setAlertForm} onSaveAlert={async () => { await sb.from("deal_alerts").insert([{ location: alertForm.location, max_budget: +alertForm.budget || null, property_type: alertForm.type, strategy: alertForm.strategy, min_cap_rate: +alertForm.minCapRate, min_cash_flow: +alertForm.minCF, email: alertForm.email, frequency: alertForm.frequency }]); setAlertSaved(true); }} alertSaved={alertSaved} />,
    legal: <LegalPage selectedScenario={selectedScenario} setSelectedScenario={setSelectedScenario} legalContext={legalContext} setLegalContext={setLegalContext} legalResult={legalResult} legalLoading={legalLoading} onAnalyze={runLegalAnalysis} legalNotes={legalNotes} onDeleteNote={id => { const n = legalNotes.filter(n => n.id !== id); setLegalNotes(n); localStorage.setItem("hb_legal_notes", JSON.stringify(n)); }} />,
    learn: <LearnPage />,
  };

  return (
    <>
      <style>{CSS}</style>
      {onboarding && <Onboarding step={onboardStep} setStep={setOnboardStep} onClose={() => setOnboarding(false)} setNav={setNav} />}
      <div className="root">
        <Sidebar nav={nav} setNav={setNav} />
        <main className="main">{pages[nav] || pages.home}</main>
      </div>
      <FloatingAssistant
        nav={nav} open={assistantOpen} setOpen={setAssistantOpen}
        msgs={assistantMsgs} input={assistantInput} setInput={setAssistantInput}
        loading={assistantLoading} onSend={() => chatWithAssistant(assistantInput)}
        pulse={assistantPulse} pageMsg={ASSISTANT_MSGS[nav]}
      />
    </>
  );
}

// ─── FLOATING ASSISTANT ───────────────────────────────────────────────────────
function FloatingAssistant({ nav, open, setOpen, msgs, input, setInput, loading, onSend, pulse, pageMsg }) {
  const ref = useRef();
  useEffect(() => { if (open) ref.current?.scrollTo(0, ref.current.scrollHeight); }, [msgs, open]);
  return (
    <div className="fa-wrap">
      {!open && pulse && (
        <div className="fa-bubble" onClick={() => setOpen(true)}>
          <div className="fa-bub-text">{pageMsg?.[0]?.split("!")[0] + "!" || "I'm here to help!"}</div>
          <div className="fa-bub-vi">{pageMsg?.[1]?.split("!")[0] + "!" || "Tôi ở đây để giúp!"}</div>
        </div>
      )}
      {open && (
        <div className="fa-panel">
          <div className="fa-header">
            <div className="fa-avatar">L</div>
            <div><div className="fa-name">Lan · Trợ Lý Của Bạn</div><div className="fa-status">● Online — always here for you</div></div>
            <button className="fa-close" onClick={() => setOpen(false)}>×</button>
          </div>
          <div className="fa-msgs" ref={ref}>
            {msgs.length === 0 && pageMsg && (
              <div className="fa-msg fa-bot">
                <div className="fa-msg-en">{pageMsg[0]}</div>
                <div className="fa-msg-vi">{pageMsg[1]}</div>
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={`fa-msg ${m.role === "user" ? "fa-user" : "fa-bot"}`}>
                <div className={m.role === "user" ? "fa-msg-en" : "fa-msg-en"}>{m.content?.split("[VI]")?.[0]?.replace("[EN]", "").trim()}</div>
                {m.role === "assistant" && m.content?.includes("[VI]") && <div className="fa-msg-vi">{m.content?.split("[VI]")?.[1]?.trim()}</div>}
              </div>
            ))}
            {loading && <div className="fa-msg fa-bot"><div className="fa-typing"><span /><span /><span /></div></div>}
          </div>
          <div className="fa-input-row">
            <input className="fa-input" placeholder="Ask Lan anything… / Hỏi Lan bất cứ điều gì…" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && onSend()} />
            <button className="fa-send" onClick={onSend} disabled={loading}>→</button>
          </div>
        </div>
      )}
      <button className={`fa-btn ${pulse ? "fa-pulse" : ""}`} onClick={() => setOpen(p => !p)}>
        {open ? "×" : "L"}
        {pulse && !open && <span className="fa-ping" />}
      </button>
    </div>
  );
}

// ─── ONBOARDING ───────────────────────────────────────────────────────────────
const OB = [
  { t: "Chào Mừng! Welcome! 🌸", tv: "Chào mừng đến với HomeBase", b: "This was built just for you — with love. Everything is in both English and Vietnamese. Your personal guide Lan is always available in the corner. 💛", bv: "Điều này được xây dựng riêng cho bạn — với tình yêu. Mọi thứ đều bằng tiếng Anh và tiếng Việt. Người hướng dẫn cá nhân Lan của bạn luôn sẵn sàng ở góc." },
  { t: "Import Any Listing Instantly ✨", tv: "Nhập Bất Kỳ Danh Sách Nào Ngay", b: "Paste a LoopNet or Zillow URL — or upload an OM PDF — and the app extracts all the numbers automatically. You shouldn't have to type much.", bv: "Dán URL LoopNet hoặc Zillow — hoặc tải lên PDF — và ứng dụng tự động trích xuất tất cả các con số." },
  { t: "Institutional Analysis 📊", tv: "Phân Tích Cấp Tổ Chức", b: "IRR, Equity Multiple, DSCR, Cap Rate, Debt Yield, NPV — every metric that the biggest funds use. Then AI explains it all in plain English and Vietnamese.", bv: "Mọi chỉ số mà các quỹ lớn nhất sử dụng. Sau đó AI giải thích tất cả bằng tiếng Anh và tiếng Việt đơn giản." },
  { t: "Log Concerns, Get Advice 📋", tv: "Ghi Lại Mối Lo Ngại, Nhận Tư Vấn", b: "Found something worrying during due diligence? Log it in the Concerns Tracker. I'll analyze each concern and tell you if the deal is still worth pursuing.", bv: "Phát hiện điều gì lo ngại trong quá trình thẩm định? Ghi vào Bộ Theo Dõi Mối Lo Ngại. Tôi sẽ phân tích và cho bạn biết giao dịch có còn đáng tiếp tục không." },
  { t: "Your Exit Plan 🕊️", tv: "Kế Hoạch Tự Do Của Bạn", b: "The Freedom Calculator shows exactly how many properties you need to replace X days of clinical work. This is your path to resting more and working less.", bv: "Máy Tính Tự Do cho thấy chính xác bạn cần bao nhiêu bất động sản để thay thế X ngày làm nha khoa. Đây là con đường của bạn." },
];

function Onboarding({ step, setStep, onClose, setNav }) {
  const s = OB[step], last = step === OB.length - 1;
  return (
    <div className="ob-overlay">
      <div className="ob-modal">
        <div className="ob-dots">{OB.map((_, i) => <span key={i} className={`ob-dot ${i <= step ? "ob-dot-on" : ""}`} />)}</div>
        <div className="ob-t">{s.t}</div><div className="ob-tv">{s.tv}</div>
        <p className="ob-b">{s.b}</p><p className="ob-bv">{s.bv}</p>
        <div className="ob-btns">
          {step > 0 && <button className="ob-back" onClick={() => setStep(p => p - 1)}>← Back</button>}
          <button className="ob-next" onClick={() => { if (last) { onClose(); setNav("freedom"); } else setStep(p => p + 1); }}>
            {last ? "Start Exploring 🌸" : "Next →"}
          </button>
        </div>
        <button className="ob-skip" onClick={onClose}>Skip · Bỏ qua</button>
      </div>
    </div>
  );
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────────
function Sidebar({ nav, setNav }) {
  const items = [
    { id: "home", en: "Home", vi: "Trang Chủ", icon: "🏡" },
    { id: "analyze", en: "Analyze", vi: "Phân Tích", icon: "📊" },
    { id: "compare", en: "My Properties", vi: "BĐS Đã Lưu", icon: "🗂️" },
    { id: "dd", en: "Due Diligence", vi: "Thẩm Định", icon: "✅" },
    { id: "freedom", en: "Freedom Calc", vi: "Tự Do", icon: "🕊️" },
    { id: "find", en: "Find + Alerts", vi: "Tìm Kiếm", icon: "🔍" },
    { id: "legal", en: "Legal Advisor", vi: "Tư Vấn Pháp Lý", icon: "⚖️" },
    { id: "learn", en: "Learn + Ask", vi: "Học & Hỏi", icon: "💬" },
  ];
  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <div className="sb-mark">H</div>
        <div><div className="sb-name">HomeBase</div><div className="sb-vi">Đầu Tư Nhà</div></div>
      </div>
      <nav className="sb-nav">{items.map(({ id, en, vi, icon }) => (
        <button key={id} className={`sbi ${nav === id ? "sbi-on" : ""}`} onClick={() => setNav(id)}>
          <span className="sbi-icon">{icon}</span>
          <div><div className="sbi-en">{en}</div><div className="sbi-vi">{vi}</div></div>
          {nav === id && <span className="sbi-pip" />}
        </button>
      ))}</nav>
      <div className="sb-foot">
        <div className="sb-badge">AI · Bilingual · Always Saving</div>
        <div className="sb-sub">Lan is always here · Lan luôn ở đây 🌸</div>
      </div>
    </aside>
  );
}

// ─── HOME PAGE ────────────────────────────────────────────────────────────────
function HomePage({ setNav, m, properties, fc, goals }) {
  return (
    <div className="page">
      <div className="hero">
        <div className="hero-tag">Built for you with love 💛 · Được xây dựng với tình yêu</div>
        <h1 className="hero-h">Your path to<br /><span className="ha">financial freedom</span></h1>
        <p className="hero-en">You've spent years caring for others. Now let your money work for you — so you can work less, rest more, and enjoy the life you've built.</p>
        <p className="hero-vi">Bạn đã dành nhiều năm chăm sóc người khác. Bây giờ hãy để tiền làm việc cho bạn.</p>
        <div className="hero-btns">
          <button className="btn-hero" onClick={() => setNav("analyze")}>Analyze a Deal · Phân Tích</button>
          <button className="btn-hero-g" onClick={() => setNav("freedom")}>Freedom Calculator · Máy Tính Tự Do</button>
        </div>
      </div>
      <div className="fc-row">
        {[[fc.pn > 0 ? fc.pn : "?", `propert${fc.pn !== 1 ? "ies" : "y"} to replace ${fc.dtr} clinic day${fc.dtr !== 1 ? "s" : ""}/week`, `bất động sản để thay thế ${fc.dtr} ngày làm việc/tuần`, "#F0FDF4"], [properties.length, "deals saved & analyzed", "giao dịch đã lưu & phân tích", "#FFF7ED"], ["1–2 hrs", "per month with a property manager", "mỗi tháng với quản lý tài sản", "#EFF6FF"]].map(([n, e, v, bg], i) => (
          <div key={i} className="fc" style={{ background: bg }}>
            <div className="fc-n">{typeof n === "number" ? <AnimNum target={n} /> : n}</div>
            <p className="fc-e">{e}</p><p className="fc-v">{v}</p>
          </div>
        ))}
      </div>
      {m && (
        <div className="home-cur ani-slide">
          <div className="hc-lbl">Current Analysis · Phân Tích Hiện Tại</div>
          <div className="hc-score" style={{ color: m.scoreColor, borderColor: m.scoreColor, background: m.scoreBg }}><strong>{m.score}</strong> — {m.scoreLabel}</div>
          <div className="hc-kpis">
            {[[f$s(m.moCF), "Monthly CF", "Dòng Tiền"], [fP(m.irr), "IRR", ""], [fX(m.em), "Equity Multiple", "Hệ Số Nhân"], [fP(m.capRate), "Cap Rate", "Tỷ Lệ VH"]].map(([v, e, vi]) => (
              <div key={e} className="hck"><div className="hck-v">{v}</div><div className="hck-e">{e}</div><div className="hck-vi">{vi}</div></div>
            ))}
          </div>
          <button className="btn-link" onClick={() => setNav("analyze")}>View full analysis →</button>
        </div>
      )}
      <div className="home-steps">
        <div className="sec-t">How This Works · Cách Hoạt Động</div>
        <div className="steps-g">
          {[["01", "Import Any Listing", "Nhập Bất Kỳ Danh Sách", "Paste a LoopNet URL or upload an OM PDF — Claude extracts everything automatically.", "Dán URL LoopNet hoặc tải PDF — Claude tự động trích xuất mọi thứ."], ["02", "Institutional Analysis", "Phân Tích Cấp Tổ Chức", "IRR, Equity Multiple, DSCR, Cap Rate, NPV, sensitivity — every metric the best funds use.", "IRR, Hệ Số Nhân, DSCR, Cap Rate — mọi chỉ số mà các quỹ hàng đầu sử dụng."], ["03", "Log Concerns", "Ghi Lại Mối Lo Ngại", "Found something worrying? Log it and get AI advice on whether the deal still makes sense.", "Phát hiện điều lo ngại? Ghi lại và nhận tư vấn AI về việc giao dịch có còn hợp lý không."], ["04", "AI Analysis in Both Languages", "Phân Tích AI Song Ngữ", "Plain-language institutional analysis in English and Vietnamese — read it together.", "Phân tích tổ chức bằng tiếng Anh và tiếng Việt — đọc cùng nhau."], ["05", "Export & Get Alerts", "Xuất & Nhận Cảnh Báo", "Download full Excel. Set up weekly deal alerts — we search even when you're not logged in.", "Tải Excel đầy đủ. Thiết lập cảnh báo hàng tuần — chúng tôi tìm kiếm kể cả khi bạn không đăng nhập."]].map(([n, e, v, d, dv]) => (
            <div key={n} className="sc ani-fade" style={{ animationDelay: `${+n * 0.1}s` }}>
              <div className="sc-n">{n}</div><div className="sc-e">{e}</div><div className="sc-v">{v}</div>
              <p className="sc-d">{d}</p><p className="sc-dv">{dv}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── ANALYZE PAGE ─────────────────────────────────────────────────────────────
function AnalyzePage({ form, sf, setForm, m, aiText, aiLoading, onAI, onSave, saving, savedMsg, importMode, setImportMode, importUrl, setImportUrl, importing, importStatus, onImportUrl, onImportPdf, fileRef, concerns, concernInput, setConcernInput, concernCategory, setConcernCategory, concernAI, onAnalyzeConcern, onAddConcern, onRemoveConcern, dealStatus, setDealStatus }) {
  const STATUSES = [["prospect", "Prospect", "#8B5CF6"], ["analyzing", "Analyzing", "#F59E0B"], ["loi", "LOI Sent", "#0EA5E9"], ["under_contract", "Under Contract", "#10B981"], ["passed", "Passed", "#EF4444"]];
  const CATEGORIES = ["general", "environmental", "structural", "title", "financial", "market", "tenant", "legal"];
  return (
    <div className="page">
      <div className="ph">
        <div><h2 className="pt">Deal Analysis <span className="pvi">· Phân Tích Giao Dịch</span></h2><p className="ps">Institutional underwriting · IRR · Equity Multiple · Concerns Tracker</p></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {savedMsg && <span className="saved-msg">{savedMsg}</span>}
          <div className="status-row">{STATUSES.map(([id, label, color]) => <button key={id} className={`status-btn ${dealStatus === id ? "status-on" : ""}`} style={dealStatus === id ? { background: color, borderColor: color, color: "white" } : {}} onClick={() => setDealStatus(id)}>{label}</button>)}</div>
          {m && <><button className="btn-sec" onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save · Lưu"}</button></>}
        </div>
      </div>
      <div className="import-bar">
        <span>✨</span><span className="ib-text">Auto-Import · Nhập Tự Động</span>
        <span className="ib-hint">LoopNet · Zillow · CoStar · OM PDF</span>
        <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
          <button className={`ib-btn ${importMode === "url" ? "ib-on" : ""}`} onClick={() => setImportMode(importMode === "url" ? null : "url")}>🔗 URL</button>
          <button className={`ib-btn ${importMode === "pdf" ? "ib-on" : ""}`} onClick={() => setImportMode(importMode === "pdf" ? null : "pdf")}>📄 PDF</button>
        </div>
      </div>
      {importMode === "url" && (<div className="imp-panel ani-slide"><div className="ip-row"><input className="ip-in" placeholder="https://www.loopnet.com/listing/..." value={importUrl} onChange={e => setImportUrl(e.target.value)} onKeyDown={e => e.key === "Enter" && onImportUrl()} /><button className="ip-go" onClick={onImportUrl} disabled={importing}>{importing ? "…" : "→"}</button></div>{importStatus && <p className={importStatus === "success" ? "ip-ok" : "ip-warn"}>{importStatus === "success" ? "✓ Data imported · Đã nhập" : importStatus}</p>}</div>)}
      {importMode === "pdf" && (<div className="imp-panel ani-slide"><div className="pdf-zone" onClick={() => fileRef.current?.click()}>{importing ? <span>{importStatus}</span> : <><span>📄</span><span>Click to upload OM PDF · Nhấn để tải PDF</span></>}</div>{importStatus && importStatus !== "success" && <p className="ip-warn">{importStatus}</p>}{importStatus === "success" && <p className="ip-ok">✓ PDF processed</p>}<input ref={fileRef} type="file" accept=".pdf" style={{ display: "none" }} onChange={e => e.target.files[0] && onImportPdf(e.target.files[0])} /></div>)}
      <div className="al">
        <div className="form-col">
          <FS t="Property · Bất Động Sản"><FF fk="address" en="Address" vi="Địa Chỉ" ph="123 Main St, Austin TX" form={form} sf={sf} ty="text" /><FG><F fk="price" en="Purchase Price" vi="Giá Mua" ph="250000" form={form} sf={sf} pre="$" /><F fk="units" en="Units" vi="Số Căn" ph="1" form={form} sf={sf} /><F fk="monthlyRent" en="Rent/Unit/Mo" vi="Thuê/Căn/Tháng" ph="2200" form={form} sf={sf} pre="$" /><F fk="sqft" en="Sq Footage" vi="Diện Tích" ph="1200" form={form} sf={sf} /></FG></FS>
          <FS t="Financing · Tài Chính"><FG><F fk="downPct" en="Down %" vi="Trả Trước %" ph="20" form={form} sf={sf} suf="%" /><F fk="interestRate" en="Rate" vi="Lãi Suất" ph="7.25" form={form} sf={sf} suf="%" /><div className="field"><div className="fl"><span className="flen">Loan Term</span><span className="flvi">Thời Hạn</span></div><select className="finput" value={form.loanTerm} onChange={e => sf("loanTerm", e.target.value)}>{["15", "20", "30"].map(v => <option key={v}>{v} years</option>)}</select></div><F fk="closingCosts" en="Closing Costs" vi="Phí KT" ph="3" form={form} sf={sf} suf="%" /></FG></FS>
          <FS t="Expenses · Chi Phí"><FG><F fk="taxes" en="Tax/Yr" vi="Thuế/Năm" ph="4800" form={form} sf={sf} pre="$" /><F fk="insurance" en="Insurance/Yr" vi="BH/Năm" ph="1800" form={form} sf={sf} pre="$" /><F fk="hoa" en="HOA/Mo" vi="HOA/Tháng" ph="0" form={form} sf={sf} pre="$" /><F fk="maintenance" en="Maintenance/Yr" vi="BT/Năm" ph="Auto 1%" form={form} sf={sf} pre="$" /><F fk="capex" en="CapEx/Yr" vi="Cải Tạo/Năm" ph="Auto 0.5%" form={form} sf={sf} pre="$" /><F fk="vacancyRate" en="Vacancy" vi="Trống" ph="8" form={form} sf={sf} suf="%" /><F fk="renovation" en="Renovation" vi="Cải Tạo Ban Đầu" ph="0" form={form} sf={sf} pre="$" /></FG></FS>
          <FS t="Assumptions · Giả Định">
            <div className="tog-row"><div><div className="flen">Property Manager</div><div className="flvi">Thuê Quản Lý</div></div><Tog on={form.propertyMgmt} flip={() => sf("propertyMgmt", !form.propertyMgmt)} /></div>
            <FG>{form.propertyMgmt && <F fk="mgmtPct" en="Mgmt Fee" vi="Phí QL" ph="10" form={form} sf={sf} suf="%" />}<F fk="appreciation" en="Appreciation" vi="Tăng Giá" ph="3" form={form} sf={sf} suf="%" /><F fk="taxBracket" en="Tax Bracket" vi="Khung Thuế" ph="24" form={form} sf={sf} suf="%" /><F fk="holdYears" en="Hold (yrs)" vi="Giữ (năm)" ph="5" form={form} sf={sf} /><F fk="exitCapRate" en="Exit Cap Rate" vi="Cap Rate Bán" ph="5.5" form={form} sf={sf} suf="%" /></FG>
            <FF fk="notes" en="Notes / Ghi Chú" vi="" ph="Condition, year built, recent renovations…" form={form} sf={sf} ty="text" />
          </FS>

          {/* CONCERNS TRACKER */}
          <div className="concerns-panel">
            <div className="cp-hdr">📋 Deal Concerns Tracker · Theo Dõi Mối Lo Ngại</div>
            <div className="cp-body">
              <p className="cp-desc">Log any concern as you discover it. I'll analyze each one and tell you if the deal is still worth pursuing. · Ghi lại bất kỳ mối lo ngại nào. Tôi sẽ phân tích và cho bạn biết giao dịch có còn đáng tiếp tục không.</p>
              <div className="cp-input-row">
                <select className="finput" style={{ width: 140, flexShrink: 0 }} value={concernCategory} onChange={e => setConcernCategory(e.target.value)}>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
                </select>
                <input className="finput" style={{ flex: 1 }} placeholder="Describe the concern… e.g. roof looks old, possible mold in basement" value={concernInput} onChange={e => setConcernInput(e.target.value)} onKeyDown={e => e.key === "Enter" && onAddConcern()} />
                <button className="cp-add" onClick={onAddConcern}>+ Add</button>
              </div>
              {concerns.map((c, idx) => (
                <div key={c.id} className="concern-item ani-slide">
                  <div className="ci-top">
                    <span className={`ci-cat ci-cat-${c.category}`}>{c.category}</span>
                    <span className="ci-text">{c.text}</span>
                    <span className="ci-date">{c.date}</span>
                    <button className="ci-del" onClick={() => onRemoveConcern(c.id)}>×</button>
                  </div>
                  {!concernAI[idx] && m && <button className="ci-analyze" onClick={() => onAnalyzeConcern(idx)}>✨ Analyze this concern · Phân tích mối lo ngại này</button>}
                  {concernAI[idx] === "loading" && <div className="ci-ai-loading">Analyzing… · Đang phân tích…</div>}
                  {concernAI[idx] && concernAI[idx] !== "loading" && (
                    <div className="ci-ai-result" dangerouslySetInnerHTML={{ __html: concernAI[idx].replace(/\n/g, "<br/>").replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>") }} />
                  )}
                </div>
              ))}
              {concerns.length === 0 && <div className="cp-empty">No concerns logged yet — you're good! · Chưa có mối lo ngại nào — tốt lắm!</div>}
            </div>
          </div>

          <button className="btn-p w100" onClick={onAI} disabled={!m || aiLoading}>{aiLoading ? "⏳ Generating…" : "✨ AI Analysis · Phân Tích AI"}</button>
          {m && <button className="btn-ghost w100" onClick={onSave} disabled={saving}>{saving ? "Saving…" : "💾 Save Deal · Lưu Giao Dịch"}</button>}
        </div>
        <div className="metrics-col">
          {!m ? (<div className="empty ani-fade"><div className="ei">📊</div><div>Enter price and monthly rent to see your full analysis</div><div className="evi">Nhập giá mua và tiền thuê để xem phân tích đầy đủ</div></div>) : <MetricsPanel m={m} aiText={aiText} aiLoading={aiLoading} />}
        </div>
      </div>
    </div>
  );
}

// ─── METRICS PANEL (condensed version) ───────────────────────────────────────
function MetricsPanel({ m, aiText, aiLoading }) {
  const [proj, setProj] = useState(false), [sens, setSens] = useState(false);
  return (
    <div className="mp">
      <div className="verdict ani-bounce" style={{ borderColor: m.scoreColor, background: m.scoreBg }}>
        <div className="v-s" style={{ color: m.scoreColor }}>{m.score}</div>
        <div><div className="v-l" style={{ color: m.scoreColor }}>{m.scoreLabel}</div><div className="v-vi">{m.scoreVi}</div></div>
      </div>
      <ST en="Institutional Returns" vi="Lợi Nhuận" />
      <div className="krow">{[[fP(m.irr), "IRR", "", m.irr > 12 ? "g" : m.irr > 8 ? "w" : "b"], [fX(m.em), "Equity Multiple", "Hệ Số Nhân", m.em > 1.7 ? "g" : m.em > 1.3 ? "w" : "b"], [f$(m.npv8), "NPV @ 8%", "", m.npv8 > 0 ? "g" : "b"], [fP(m.coc), "Cash-on-Cash", "Lợi Nhuận TM", m.coc > 8 ? "g" : m.coc > 5 ? "w" : "b"]].map(([v, e, vi, s]) => <KC key={e} v={v} e={e} vi={vi} s={s} />)}</div>
      <ST en="Monthly P&L" vi="Thu Chi Tháng" />
      <div className="pl">
        <PR e="Gross Rent" vi="Tiền Thuê Gộp" v={f$(m.grossMoRent)} /><PR e="Vacancy (−)" vi="Dự Phòng Trống" v={`−${f$(m.vacLossMo)}`} neg ind /><PR e="Effective Income" vi="Thu Nhập Thực" v={f$(m.grossMoRent - m.vacLossMo)} bold />
        <div className="pld" />
        <PR e="Mortgage" vi="Trả Vay" v={`−${f$(m.moMtg)}`} neg ind /><PR e="Tax" vi="Thuế" v={`−${f$(m.taxMo)}`} neg ind /><PR e="Insurance" vi="Bảo Hiểm" v={`−${f$(m.insMo)}`} neg ind />
        {m.hoa > 0 && <PR e="HOA" vi="Phí HOA" v={`−${f$(m.hoa)}`} neg ind />}
        <PR e="Maintenance" vi="Bảo Trì" v={`−${f$(m.maintMo)}`} neg ind /><PR e="CapEx" vi="Quỹ Cải Tạo" v={`−${f$(m.capexMo)}`} neg ind />
        {m.mgmtMo > 0 && <PR e="Mgmt" vi="Quản Lý" v={`−${f$(m.mgmtMo)}`} neg ind />}
        <div className="pld" />
        <div className={`plcf ${m.moCF >= 0 ? "plcf-p" : "plcf-n"}`}>
          <div><div className="plcf-tag">NET CASH FLOW · DÒNG TIỀN RÒNG</div><div className="plcf-v">{f$s(m.moCF)}<span>/mo</span></div></div>
          <div className="plcf-ann">{f$s(m.annCF)}<span>/yr</span></div>
        </div>
      </div>
      <ST en="Return Metrics" vi="Chỉ Số Lợi Nhuận" />
      <div className="mcg">{[[fP(m.capRate), "Cap Rate", "Tỷ Lệ VH", m.capRate > 6 ? "g" : m.capRate > 4 ? "w" : "b", true], [fP(m.grossYield), "Gross Yield", "LS Gộp", m.grossYield > 7 ? "g" : m.grossYield > 5 ? "w" : "b"], [fP(m.netYield), "Net Yield", "LS Ròng", m.netYield > 5 ? "g" : m.netYield > 3 ? "w" : "b"], [fP(m.yoc), "Yield on Cost", "LS/Chi Phí", "n"], [fP(m.effCoC), "CoC After Tax", "CoC Sau Thuế", m.effCoC > 8 ? "g" : m.effCoC > 5 ? "w" : "b", true], [f$(m.taxSav), "Tax Savings/yr", "TK Thuế", "n"]].map(([v, e, vi, s, lg]) => <MC key={e} v={v} e={e} vi={vi} s={s} lg={lg} />)}</div>
      <ST en="Risk Ratios" vi="Tỷ Số Rủi Ro" />
      <div className="mcg">{[[fX(m.dscr), "DSCR", "Tỷ Số Nợ", m.dscr > 1.25 ? "g" : m.dscr > 1.0 ? "w" : "b", true], [fX(m.grm), "GRM", "Hệ Số Thuê", m.grm < 10 ? "g" : m.grm < 14 ? "w" : "b", true], [fP(m.debtYield), "Debt Yield", "LS Nợ", m.debtYield > 8 ? "g" : m.debtYield > 6 ? "w" : "b"], [fP(m.breakEven), "Break-even", "Hòa Vốn", m.breakEven < 75 ? "g" : m.breakEven < 90 ? "w" : "b"], [fP(m.expRatio), "Expense Ratio", "Tỷ Lệ CP", m.expRatio < 45 ? "g" : m.expRatio < 60 ? "w" : "b"], [fP(m.ltv), "LTV", "Tỷ Lệ Vay", m.ltv < 75 ? "g" : m.ltv < 85 ? "w" : "b"]].map(([v, e, vi, s, lg]) => <MC key={e} v={v} e={e} vi={vi} s={s} lg={lg} />)}</div>
      <ST en="Acquisition" vi="Mua Lại" />
      <div className="mcg mc3">{[[f$(m.downAmt), "Down Payment", "Tiền Trả Trước"], [f$(m.clAmt), "Closing Costs", "Phí GD"], [f$(m.reno), "Renovation", "Cải Tạo"], [f$(m.totalCost), "Total Equity", "Tổng Vốn"], [f$(m.moMtg), "Mortgage/mo", "Trả Vay/Tháng"], [f$(m.totalInterest), "Lifetime Interest", "Tổng Lãi"]].map(([v, e, vi]) => <MC key={e} v={v} e={e} vi={vi} s="n" />)}</div>
      <button className="coll" onClick={() => setProj(p => !p)}><ST en="10-Year Projection" vi="Dự Báo 10 Năm" inline /><span>{proj ? "▲" : "▼"}</span></button>
      {proj && <div className="tw"><table className="tbl"><thead><tr><th>Yr</th><th>Value</th><th>Equity</th><th>CF/Yr</th><th>Eff CF</th><th>Total Return</th><th>ROI</th></tr></thead><tbody>{m.proj.map(p => <tr key={p.y} className={p.y === m.holdYrs ? "tr-x" : p.y % 5 === 0 ? "tr-hl" : ""}><td className="ty">{p.y}{p.y === m.holdYrs && <span className="xt">EXIT</span>}</td><td>{f$(p.pv)}</td><td>{f$(p.eq)}</td><td className={p.cfY >= 0 ? "tg" : "tr"}>{f$s(p.cfY)}</td><td className={p.effCFY >= 0 ? "tg" : "tr"}>{f$s(p.effCFY)}</td><td className="tb">{f$(p.totalRet)}</td><td className={p.roi >= 0 ? "tg tb" : "tr tb"}>{p.roi.toFixed(0)}%</td></tr>)}</tbody></table></div>}
      <button className="coll" onClick={() => setSens(p => !p)}><ST en="Sensitivity Analysis" vi="Phân Tích Nhạy Cảm" inline /><span>{sens ? "▲" : "▼"}</span></button>
      {sens && <div className="sens"><div className="sh"><div />{m.rentMods.map((r, i) => <div key={i}>Rent {r > 0 ? "+" : ""}{(r * 100).toFixed(0)}%</div>)}</div>{m.sens.map((row, ri) => <div key={ri} className="sr"><div className="sl">Vac {(m.vacMods[ri] * 100).toFixed(0)}%</div>{row.map((v, ci) => <div key={ci} className={`sc ${v > 200 ? "sg" : v > 0 ? "sw" : "sb"}`}>${v.toLocaleString()}</div>)}</div>)}</div>}
      {(aiText || aiLoading) && <div className="aic ani-slide"><div className="aih">AI Institutional Analysis · Phân Tích AI Cấp Tổ Chức</div>{aiLoading && <div className="ail">⏳ Generating analysis in English and Vietnamese…</div>}{aiText && <div className="aib" dangerouslySetInnerHTML={{ __html: aiText.replace(/\n/g, "<br/>").replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/#{1,3} (.*)/g, "<h4>$1</h4>") }} />}</div>}
    </div>
  );
}

// ─── COMPARE PAGE ──────────────────────────────────────────────────────────────
function ComparePage({ properties, onDelete, onLoad }) {
  const [sel, setSel] = useState([]);
  const toggle = id => setSel(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id].slice(0, 3));
  const shown = sel.length > 0 ? properties.filter(p => sel.includes(p.id)) : [];
  const metrics = [["monthly_cf", "Monthly CF", "Dòng Tiền", "cf"], ["cap_rate", "Cap Rate", "Tỷ Lệ VH", "pct"], ["irr", "IRR", "Tỷ Suất HC", "pct"], ["coc_return", "Cash-on-Cash", "Lợi Nhuận TM", "pct"], ["dscr", "DSCR", "Tỷ Số Nợ", "x"], ["equity_multiple", "Equity Multiple", "Hệ Số Nhân", "x"], ["price", "Price", "Giá Mua", "$"]];
  const totalCF = properties.reduce((s, p) => s + (p.monthly_cf || 0), 0);
  const avgCap = properties.length > 0 ? properties.reduce((s, p) => s + (p.cap_rate || 0), 0) / properties.length : 0;
  return (
    <div className="page">
      <div className="ph"><div><h2 className="pt">My Properties <span className="pvi">· BĐS Đã Lưu</span></h2><p className="ps">Select up to 3 to compare · Click any row to load into analyzer</p></div></div>
      {properties.length > 0 && (
        <div className="port-summary">
          <div className="ps-card"><div className="psc-n"><AnimNum target={properties.length} /></div><div className="psc-l">Properties</div></div>
          <div className="ps-card"><div className="psc-n">{f$s(totalCF)}/mo</div><div className="psc-l">Total Monthly CF · Dòng Tiền Tổng</div></div>
          <div className="ps-card"><div className="psc-n">{fP(avgCap)}</div><div className="psc-l">Avg Cap Rate · Cap Rate TB</div></div>
        </div>
      )}
      {properties.length === 0 ? (<div className="empty ani-fade"><div className="ei">🗂️</div><div>No properties saved yet. Analyze a deal and click Save.</div><div className="evi">Chưa có bất động sản nào được lưu.</div></div>) : (
        <>
          <div style={{ overflowX: "auto" }}><table className="cmp-tbl">
            <thead><tr><th>Property</th><th>Status</th><th>Score</th><th>Monthly CF</th><th>Cap Rate</th><th>IRR</th><th>Actions</th></tr></thead>
            <tbody>{properties.map(p => (
              <tr key={p.id} className={sel.includes(p.id) ? "cmp-sel" : ""} onClick={() => onLoad(p)} style={{ cursor: "pointer" }}>
                <td><div className="cmp-addr">{p.address || "Unnamed"}</div><div className="cmp-date">{new Date(p.created_at).toLocaleDateString()}</div></td>
                <td><span className="status-pill" style={{ background: p.deal_status === "under_contract" ? "#10B981" : p.deal_status === "passed" ? "#EF4444" : "#8B5CF6" }}>{p.deal_status || "prospect"}</span></td>
                <td><span style={{ color: p.score_color, fontWeight: 800 }}>{p.score}</span></td>
                <td className={(p.monthly_cf || 0) > 0 ? "td-g" : "td-r"}>{f$s(p.monthly_cf || 0)}/mo</td>
                <td>{(p.cap_rate || 0).toFixed(2)}%</td>
                <td>{(p.irr || 0).toFixed(2)}%</td>
                <td onClick={e => e.stopPropagation()}><div style={{ display: "flex", gap: 5 }}>
                  <button className="cmp-btn" onClick={() => toggle(p.id)}>{sel.includes(p.id) ? "✓" : "Compare"}</button>
                  <button className="cmp-btn cmp-del" onClick={() => onDelete(p.id)}>×</button>
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
          {shown.length > 1 && (
            <div style={{ marginTop: 24 }}>
              <div className="sec-t">Side-by-Side · So Sánh Trực Tiếp</div>
              <div style={{ overflowX: "auto" }}><table className="cmp-tbl">
                <thead><tr><th>Metric</th>{shown.map(p => <th key={p.id}>{p.address?.split(",")[0] || "Property"}</th>)}</tr></thead>
                <tbody>{metrics.map(([k, e, vi, fmt]) => (
                  <tr key={k}><td><div className="flen">{e}</div><div className="flvi">{vi}</div></td>
                    {shown.map(p => {
                      const v = p[k]; let disp = v;
                      if (fmt === "pct") disp = `${(+v || 0).toFixed(2)}%`;
                      else if (fmt === "x") disp = `${(+v || 0).toFixed(2)}x`;
                      else if (fmt === "$") disp = f$(+v || 0);
                      else if (fmt === "cf") disp = `${f$s(+v || 0)}/mo`;
                      const best = shown.reduce((b, x) => (+x[k] || 0) > (+b[k] || 0) ? x : b, shown[0]).id === p.id;
                      return <td key={p.id} className={best ? "td-g td-bold" : ""}>{disp}</td>;
                    })}
                  </tr>
                ))}</tbody>
              </table></div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── DUE DILIGENCE ─────────────────────────────────────────────────────────────
function DDPage() {
  const [checked, setChecked] = useState({}), toggle = k => setChecked(p => ({ ...p, [k]: !p[k] }));
  const total = DD.flatMap(p => p.tasks).length, done = Object.values(checked).filter(Boolean).length;
  return (
    <div className="page">
      <div className="ph"><div><h2 className="pt">Due Diligence <span className="pvi">· Thẩm Định</span></h2><p className="ps">~25–40 hrs active work · 60–90 day timeline · 1–2 hrs/mo ongoing</p></div>
        <div className="ddp"><div className="ddpn">{done}/{total}</div><div className="ddpb"><div style={{ width: `${Math.round(done / total * 100)}%` }} className="ddpf" /></div><div className="ddpp">{Math.round(done / total * 100)}%</div></div>
      </div>
      <div className="time-banner"><div className="tb-t">Time Reality Check</div><div className="tb-g">{[["~25–40 hrs", "Active work to close · Công việc để đóng giao dịch"], ["60–90 days", "Offer to keys · Từ đề nghị đến nhận chìa khóa"], ["1–2 hrs/mo", "With property manager · Với quản lý tài sản"], ["↓ dentistry", "One property closer to rest · Một bước gần hơn đến nghỉ ngơi"]].map(([n, d], i) => <div key={i} className="tb-i"><div className="tb-n">{n}</div><div className="tb-d">{d}</div></div>)}</div></div>
      {DD.map((ph, pi) => {
        const pd = ph.tasks.filter((_, ti) => checked[`${pi}-${ti}`]).length;
        return (<div key={pi} className="ddph ani-fade" style={{ animationDelay: `${pi * 0.08}s` }}>
          <div className="dph-hdr"><div className="dph-badge" style={{ background: ph.color }}>{ph.phase}</div>
            <div><div className="dph-t">{ph.en} <span className="dph-vi">· {ph.vi}</span></div><div className="dph-m">⏱ {ph.time} · 👤 {ph.who}</div></div>
            <div className="dph-p">{pd}/{ph.tasks.length}</div>
          </div>
          <div className="dph-tasks">{ph.tasks.map((t, ti) => { const k = `${pi}-${ti}`; return (
            <label key={ti} className={`task ${checked[k] ? "task-d" : ""}`} onClick={() => toggle(k)}>
              <span className={`tcb ${checked[k] ? "tcb-on" : ""}`}>{checked[k] ? "✓" : ""}</span>
              <div><div className="ten">{t.en}</div><div className="tvi">{t.vi}</div></div>
            </label>
          ); })}</div>
        </div>);
      })}
    </div>
  );
}

// ─── FREEDOM PAGE ──────────────────────────────────────────────────────────────
function FreedomPage({ goals, setGoals, fc, properties }) {
  const sg = (k, v) => setGoals(p => ({ ...p, [k]: v }));
  return (
    <div className="page">
      <div className="ph"><div><h2 className="pt">Freedom Calculator <span className="pvi">· Máy Tính Tự Do</span></h2><p className="ps">How many properties do you need to work less and rest more?</p></div></div>
      <div className="fr-hero"><p className="frh-en">You've dedicated your career to caring for others. Real estate is how you start caring for yourself — one property at a time.</p><p className="frh-vi">Bạn đã cống hiến sự nghiệp của mình để chăm sóc người khác. Bất động sản là cách bạn bắt đầu chăm sóc bản thân.</p></div>
      <div className="fr-layout">
        <div className="fr-form">
          <div className="fsec-hdr">Your Work Situation · Tình Trạng Công Việc</div>
          <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="fg">
              <div className="field"><div className="fl"><span className="flen">Days/Week Now</span><span className="flvi">Ngày/Tuần Hiện Tại</span></div><select className="finput" value={goals.currentDays} onChange={e => sg("currentDays", +e.target.value)}>{[5, 4, 3, 2].map(v => <option key={v}>{v}</option>)}</select></div>
              <div className="field"><div className="fl"><span className="flen">Target Days/Week</span><span className="flvi">Ngày Mục Tiêu</span></div><select className="finput" value={goals.targetDays} onChange={e => sg("targetDays", +e.target.value)}>{[4, 3, 2, 1, 0].map(v => <option key={v}>{v}</option>)}</select></div>
              <div className="field"><div className="fl"><span className="flen">Income Per Day ($)</span><span className="flvi">Thu Nhập / Ngày</span></div><div className="fw"><span className="fpre">$</span><input className="finput fhp" type="number" placeholder="2000" value={goals.incomePerDay} onChange={e => sg("incomePerDay", e.target.value)} /></div></div>
              <div className="field"><div className="fl"><span className="flen">Avg CF/Property</span><span className="flvi">Dòng Tiền TB / Căn</span></div><div className="fw"><span className="fpre">$</span><input className="finput fhp" type="number" placeholder="400" value={goals.avgCFPerProp} onChange={e => sg("avgCFPerProp", e.target.value)} /></div></div>
              <div className="field"><div className="fl"><span className="flen">Properties Owned</span><span className="flvi">Đang Sở Hữu</span></div><input className="finput" type="number" placeholder="0" value={goals.propsOwned} onChange={e => sg("propsOwned", +e.target.value)} /></div>
            </div>
          </div>
        </div>
        <div className="fr-results">
          <div className="frr-card">
            <div className="frr-top">YOUR FREEDOM NUMBER · CON SỐ TỰ DO</div>
            <div className="frr-num"><AnimNum target={fc.pn || 0} /></div>
            <div className="frr-unit">properties needed · bất động sản cần</div>
            <div className="frr-desc">To replace <strong>{fc.dtr} day{fc.dtr !== 1 ? "s" : ""}/week</strong> of clinical income (~{f$(fc.itr)}/mo)</div>
            <div className="frr-descvi">Để thay thế <strong>{fc.dtr} ngày/tuần</strong> thu nhập nha khoa (~{f$(fc.itr)}/tháng)</div>
          </div>
          <div className="frr-prog-card">
            <div className="frp-title">Progress · Tiến Độ</div>
            <div className="frp-bar-wrap"><div className="frp-bar" style={{ width: `${fc.prog}%` }} /></div>
            <div className="frp-labels"><span>{goals.propsOwned} owned</span><span>{fc.pn} goal</span></div>
          </div>
          {properties.length > 0 && (
            <div className="frr-saved">
              <div className="frp-title">Saved Properties</div>
              {properties.slice(0, 4).map(p => (
                <div key={p.id} className="frp-prop">
                  <div className="frp-addr">{p.address?.split(",")[0] || "Unnamed"}</div>
                  <div className={`frp-cf ${(p.monthly_cf || 0) > 0 ? "td-g" : "td-r"}`}>{f$s(p.monthly_cf || 0)}/mo</div>
                  <div className="frp-score" style={{ color: p.score_color }}>{p.score}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── FIND PAGE (COMPLETE OVERHAUL) ────────────────────────────────────────────
function FindPage({ q, setQ, result, loading, onFind, alertForm, setAlertForm, onSaveAlert, alertSaved }) {
  const [tab, setTab] = useState("find");
  const sf = (k, v) => setQ(p => ({ ...p, [k]: v }));
  const sa = (k, v) => setAlertForm(p => ({ ...p, [k]: v }));

  // Parse deal cards from result text
  const deals = useMemo(() => {
    if (!result) return [];
    const blocks = result.split("---DEAL---").slice(1);
    return blocks.map(block => {
      const end = block.indexOf("---END DEAL---");
      const content = end > -1 ? block.slice(0, end) : block;
      const lines = content.split("\n").filter(l => l.trim());
      const get = (key) => { const line = lines.find(l => l.startsWith(key + ":")); return line ? line.replace(key + ":", "").trim() : null; };
      return { address: get("ADDRESS"), price: get("PRICE"), units: get("UNITS"), capRate: get("ASKING CAP RATE"), cashFlow: get("ESTIMATED MONTHLY CASH FLOW"), platform: get("LISTING PLATFORM"), url: get("LISTING URL"), contact: get("HOW TO CONTACT"), why: get("WHY THIS DEAL"), green: get("GREEN FLAGS"), watch: get("WATCH OUT FOR"), score: get("HOMEBASE SCORE") };
    }).filter(d => d.address);
  }, [result]);

  const narrative = useMemo(() => {
    if (!result) return "";
    const dealsEnd = result.lastIndexOf("---END DEAL---");
    return dealsEnd > -1 ? result.slice(dealsEnd + "---END DEAL---".length).trim() : "";
  }, [result]);

  const scoreColor = (s) => s?.includes("STRONG") ? "#059669" : s?.includes("BUY") ? "#2563EB" : s?.includes("NEGOTIATE") ? "#D97706" : "#DC2626";

  return (
    <div className="page">
      <div className="ph"><div><h2 className="pt">Find + Alerts <span className="pvi">· Tìm Kiếm + Cảnh Báo</span></h2><p className="ps">AI-powered deal sourcing with live web search + background weekly alerts</p></div></div>
      <div className="tab-row"><button className={`tab-btn ${tab === "find" ? "tab-on" : ""}`} onClick={() => setTab("find")}>🔍 Find Now · Tìm Ngay</button><button className={`tab-btn ${tab === "alerts" ? "tab-on" : ""}`} onClick={() => setTab("alerts")}>🔔 Deal Alerts · Cảnh Báo</button></div>

      {tab === "find" && (<>
        <div className="find-filters">
          <div className="ff-section-title">Location & Budget · Vị Trí & Ngân Sách</div>
          <div className="ff-grid3">
            <div className="field"><div className="fl"><span className="flen">Target Market</span><span className="flvi">Khu Vực Mục Tiêu</span></div><input className="finput" placeholder="Phoenix AZ, Dallas TX..." value={q.location} onChange={e => sf("location", e.target.value)} /></div>
            <div className="field"><div className="fl"><span className="flen">State</span><span className="flvi">Tiểu Bang</span></div><input className="finput" placeholder="TX, FL, AZ..." value={q.state} onChange={e => sf("state", e.target.value)} /></div>
            <div className="field"><div className="fl"><span className="flen">Min Price</span><span className="flvi">Giá Tối Thiểu</span></div><div className="fw"><span className="fpre">$</span><input className="finput fhp" type="number" placeholder="100000" value={q.minBudget} onChange={e => sf("minBudget", e.target.value)} /></div></div>
            <div className="field"><div className="fl"><span className="flen">Max Price</span><span className="flvi">Giá Tối Đa</span></div><div className="fw"><span className="fpre">$</span><input className="finput fhp" type="number" placeholder="500000" value={q.budget} onChange={e => sf("budget", e.target.value)} /></div></div>
          </div>
          <div className="ff-section-title">Asset & Strategy · Loại Tài Sản & Chiến Lược</div>
          <div className="ff-grid3">
            <div className="field"><div className="fl"><span className="flen">Asset Class</span><span className="flvi">Loại Tài Sản</span></div><select className="finput" value={q.type} onChange={e => sf("type", e.target.value)}>{["Single Family", "Duplex (2-unit)", "Triplex (3-unit)", "Fourplex (4-unit)", "Small Multifamily (5–20 units)", "Condo", "Townhome", "Mixed-Use", "Short-Term Rental"].map(o => <option key={o}>{o}</option>)}</select></div>
            <div className="field"><div className="fl"><span className="flen">Strategy</span><span className="flvi">Chiến Lược</span></div><select className="finput" value={q.strategy} onChange={e => sf("strategy", e.target.value)}>{["Buy & Hold", "House Hacking", "BRRRR", "Short-Term Rental (Airbnb)", "Fix & Flip", "Value-Add"].map(o => <option key={o}>{o}</option>)}</select></div>
            <div className="field"><div className="fl"><span className="flen">Min Units</span><span className="flvi">Đơn Vị Tối Thiểu</span></div><input className="finput" type="number" placeholder="1" value={q.minUnits} onChange={e => sf("minUnits", e.target.value)} /></div>
            <div className="field"><div className="fl"><span className="flen">Max Units</span><span className="flvi">Đơn Vị Tối Đa</span></div><input className="finput" type="number" placeholder="10" value={q.maxUnits} onChange={e => sf("maxUnits", e.target.value)} /></div>
          </div>
          <div className="ff-section-title">Financial Criteria · Tiêu Chí Tài Chính</div>
          <div className="ff-grid3">
            <div className="field"><div className="fl"><span className="flen">Min Cap Rate</span><span className="flvi">Cap Rate Tối Thiểu</span></div><div className="fw"><input className="finput fhs" type="number" placeholder="5.0" value={q.minCapRate} onChange={e => sf("minCapRate", e.target.value)} /><span className="fsuf">%</span></div></div>
            <div className="field"><div className="fl"><span className="flen">Max GRM</span><span className="flvi">GRM Tối Đa</span></div><div className="fw"><input className="finput fhs" type="number" placeholder="14" value={q.maxGRM} onChange={e => sf("maxGRM", e.target.value)} /><span className="fsuf">x</span></div></div>
            <div className="field"><div className="fl"><span className="flen">Min Cash Flow</span><span className="flvi">Dòng Tiền Tối Thiểu</span></div><div className="fw"><span className="fpre">$</span><input className="finput fhp" type="number" placeholder="200" value={q.minCashFlow} onChange={e => sf("minCashFlow", e.target.value)} /></div></div>
          </div>
          <div className="ff-section-title">Property Condition · Tình Trạng Tài Sản</div>
          <div className="ff-grid3">
            <div className="field"><div className="fl"><span className="flen">Year Built After</span><span className="flvi">Xây Dựng Sau Năm</span></div><input className="finput" type="number" placeholder="1980" value={q.yearBuiltMin} onChange={e => sf("yearBuiltMin", e.target.value)} /></div>
            <div className="field"><div className="fl"><span className="flen">Listing Age</span><span className="flvi">Tuổi Niêm Yết</span></div><select className="finput" value={q.listingAge} onChange={e => sf("listingAge", e.target.value)}>{[["any", "Any age"], ["7", "< 7 days (fresh)"], ["30", "< 30 days"], ["90", "< 90 days"], ["90+", "90+ days (motivated?)"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div className="field"><div className="fl"><span className="flen">Seller Motivation</span><span className="flvi">Động Lực Người Bán</span></div><select className="finput" value={q.sellerMotivation} onChange={e => sf("sellerMotivation", e.target.value)}>{[["any", "Any"], ["motivated", "Motivated / Price reduced"], ["estate", "Estate sale / Probate"], ["offmarket", "Off-market preferred"], ["foreclosure", "Foreclosure / REO"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          </div>
          <button className="btn-p w100" onClick={onFind} disabled={loading} style={{ marginTop: 16 }}>{loading ? "⏳ Searching live listings…" : "🔍 Find Best Deals · Tìm Giao Dịch Tốt Nhất"}</button>
        </div>

        {loading && <div className="find-loading"><div className="find-load-dots"><span /><span /><span /></div><div>Searching LoopNet, Zillow, CoStar, Realtor.com with live web access…<br /><span style={{ fontSize: 11, color: "var(--muted)" }}>Đang tìm kiếm trên các nền tảng với quyền truy cập web trực tiếp…</span></div></div>}

        {deals.length > 0 && !loading && (
          <div className="deal-results">
            <div className="dr-header"><div className="dr-title">Found {deals.length} Matching Properties · Tìm Thấy {deals.length} Bất Động Sản</div><div className="dr-sub">Sorted by HomeBase score · AI-analyzed with live data</div></div>
            <div className="deal-cards">
              {deals.map((d, i) => (
                <div key={i} className="deal-card ani-fade" style={{ animationDelay: `${i * 0.1}s` }}>
                  <div className="dc-header">
                    <div className="dc-score" style={{ background: scoreColor(d.score) + "18", border: `1.5px solid ${scoreColor(d.score)}40`, color: scoreColor(d.score) }}>{d.score || "—"}</div>
                    <div className="dc-addr">{d.address || "Address not available"}</div>
                  </div>
                  <div className="dc-metrics">
                    {d.price && <div className="dcm"><span className="dcm-l">Price</span><span className="dcm-v">{d.price}</span></div>}
                    {d.units && <div className="dcm"><span className="dcm-l">Units</span><span className="dcm-v">{d.units}</span></div>}
                    {d.capRate && <div className="dcm"><span className="dcm-l">Cap Rate</span><span className="dcm-v">{d.capRate}</span></div>}
                    {d.cashFlow && <div className="dcm"><span className="dcm-l">Est. CF/mo</span><span className="dcm-v">{d.cashFlow}</span></div>}
                    {d.platform && <div className="dcm"><span className="dcm-l">Platform</span><span className="dcm-v">{d.platform}</span></div>}
                  </div>
                  {d.why && <div className="dc-why">{d.why}</div>}
                  <div className="dc-flags">
                    {d.green && <div className="dc-green">✓ {d.green}</div>}
                    {d.watch && <div className="dc-watch">⚠ {d.watch}</div>}
                  </div>
                  <div className="dc-actions">
                    {d.url && d.url !== "N/A" && d.url.startsWith("http") && <a className="dc-link" href={d.url} target="_blank" rel="noopener noreferrer">View Listing →</a>}
                    {d.contact && <div className="dc-contact"><span className="dc-contact-label">Contact: </span>{d.contact}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {narrative && !loading && (
          <div className="result-card">
            <div className="rc-hdr">Market Intelligence · Thông Tin Thị Trường</div>
            <div className="rc-body" dangerouslySetInnerHTML={{ __html: narrative.replace(/\n/g, "<br/>").replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/#{1,3} (.*)/g, "<h4>$1</h4>") }} />
          </div>
        )}
      </>)}

      {tab === "alerts" && (
        <div className="alert-panel">
          <div className="ap-info">
            <div className="api-t">🔔 Background Deal Monitoring · Theo Dõi Tự Động</div>
            <p className="api-en">Set your criteria once. Every week, our system searches for matching properties using Claude AI with live web access — even when you're not logged in — and emails you a report.</p>
            <p className="api-vi">Thiết lập tiêu chí một lần. Mỗi tuần, hệ thống tìm kiếm bất động sản phù hợp và gửi email cho bạn — kể cả khi bạn không đăng nhập.</p>
          </div>
          {alertSaved ? (<div className="alert-success">✓ Alert activated! You'll receive weekly emails · Cảnh báo đã kích hoạt! Bạn sẽ nhận email hàng tuần</div>) : (
            <div className="fsec" style={{ maxWidth: 600 }}>
              <div className="fsec-hdr">Alert Criteria · Tiêu Chí Cảnh Báo</div>
              <div style={{ padding: "16px" }}>
                <div className="fg" style={{ marginBottom: 10 }}>
                  <div className="field"><div className="fl"><span className="flen">Target Market</span><span className="flvi">Thị Trường</span></div><input className="finput" placeholder="Phoenix AZ" value={alertForm.location} onChange={e => sa("location", e.target.value)} /></div>
                  <div className="field"><div className="fl"><span className="flen">Max Budget</span><span className="flvi">Ngân Sách</span></div><div className="fw"><span className="fpre">$</span><input className="finput fhp" type="number" placeholder="400000" value={alertForm.budget} onChange={e => sa("budget", e.target.value)} /></div></div>
                  <div className="field"><div className="fl"><span className="flen">Min Cap Rate</span></div><div className="fw"><input className="finput fhs" type="number" placeholder="5" value={alertForm.minCapRate} onChange={e => sa("minCapRate", e.target.value)} /><span className="fsuf">%</span></div></div>
                  <div className="field"><div className="fl"><span className="flen">Min Cash Flow</span></div><div className="fw"><span className="fpre">$</span><input className="finput fhp" type="number" placeholder="200" value={alertForm.minCF} onChange={e => sa("minCF", e.target.value)} /></div></div>
                </div>
                <div className="field" style={{ marginBottom: 10 }}><div className="fl"><span className="flen">Your Email · Email Của Bạn</span></div><input className="finput" type="email" placeholder="yourname@email.com" value={alertForm.email} onChange={e => sa("email", e.target.value)} /></div>
                <div className="field" style={{ marginBottom: 16 }}><div className="fl"><span className="flen">Frequency · Tần Suất</span></div><select className="finput" value={alertForm.frequency} onChange={e => sa("frequency", e.target.value)}><option value="weekly">Weekly · Hàng Tuần</option><option value="daily">Daily · Hàng Ngày</option></select></div>
                <button className="btn-p w100" onClick={onSaveAlert} disabled={!alertForm.email || !alertForm.location}>🔔 Activate Alert · Kích Hoạt Cảnh Báo</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── LEGAL PAGE ────────────────────────────────────────────────────────────────
function LegalPage({ selectedScenario, setSelectedScenario, legalContext, setLegalContext, legalResult, legalLoading, onAnalyze, legalNotes, onDeleteNote }) {
  const [tab, setTab] = useState("scenarios");
  const sel = LEGAL_SCENARIOS.find(s => s.id === selectedScenario);
  const urgencyColor = u => u === "high" ? "#DC2626" : u === "medium" ? "#D97706" : "#10B981";
  return (
    <div className="page">
      <div className="ph"><div><h2 className="pt">Legal Advisor <span className="pvi">· Tư Vấn Pháp Lý</span></h2><p className="ps">Know your rights before you need them · Biết quyền lợi của bạn trước khi cần đến · All advice saved to notes automatically</p></div></div>
      <div className="legal-disclaimer">⚖️ This provides general information only, not legal advice. Always consult a licensed attorney in your state for specific situations. · Đây chỉ là thông tin chung, không phải tư vấn pháp lý. Luôn tham khảo luật sư có giấy phép tại tiểu bang của bạn.</div>
      <div className="tab-row"><button className={`tab-btn ${tab === "scenarios" ? "tab-on" : ""}`} onClick={() => setTab("scenarios")}>Get Legal Advice · Nhận Tư Vấn</button><button className={`tab-btn ${tab === "notes" ? "tab-on" : ""}`} onClick={() => setTab("notes")}>Saved Notes · Ghi Chú Đã Lưu {legalNotes.length > 0 && <span className="badge">{legalNotes.length}</span>}</button></div>

      {tab === "scenarios" && (<>
        <div className="legal-scenarios">
          <div className="sec-t" style={{ marginBottom: 12 }}>What's happening? · Chuyện gì đang xảy ra?</div>
          <div className="ls-grid">{LEGAL_SCENARIOS.map(s => (
            <button key={s.id} className={`ls-card ${selectedScenario === s.id ? "ls-on" : ""}`} onClick={() => setSelectedScenario(s.id)}>
              <span className="ls-icon">{s.icon}</span>
              <div className="ls-en">{s.en}</div>
              <div className="ls-vi">{s.vi}</div>
              <div className="ls-urgency" style={{ color: urgencyColor(s.urgency) }}>● {s.urgency}</div>
            </button>
          ))}</div>
        </div>
        {selectedScenario && (
          <div className="legal-context ani-slide">
            <div className="lc-title">Tell me more about your situation · Kể cho tôi nghe thêm về tình huống của bạn</div>
            <div className="lc-subtitle">The more detail you give, the more specific and useful my advice will be. Include: how long it's been happening, what you've already tried, and your state. · Càng nhiều chi tiết, lời khuyên càng hữu ích.</div>
            <textarea className="lc-textarea" placeholder={`Describe the situation in detail…\n\nExample: "My tenant in Phoenix AZ hasn't paid rent for 2 months. I've texted them 3 times. They say they lost their job. The lease ends in 4 months. What should I do?"`} value={legalContext} onChange={e => setLegalContext(e.target.value)} rows={6} />
            <button className="btn-p" onClick={onAnalyze} disabled={!legalContext.trim() || legalLoading}>{legalLoading ? "⏳ Analyzing your situation…" : `⚖️ Get Legal Advice for: ${sel?.en}`}</button>
          </div>
        )}
        {legalLoading && <div className="find-loading"><div className="find-load-dots"><span /><span /><span /></div><div>Analyzing your situation in English and Vietnamese…</div></div>}
        {legalResult && !legalLoading && (
          <div className="aic ani-slide">
            <div className="aih">⚖️ Legal Analysis: {sel?.en} · Phân Tích Pháp Lý</div>
            <div className="aib" dangerouslySetInnerHTML={{ __html: legalResult.replace(/\n/g, "<br/>").replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/#{1,3} (.*)/g, "<h4>$1</h4>") }} />
            <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--muted)" }}>✓ This analysis has been saved to your notes automatically · Phân tích này đã được lưu tự động vào ghi chú của bạn</div>
          </div>
        )}
      </>)}

      {tab === "notes" && (
        <div>
          {legalNotes.length === 0 ? (<div className="empty ani-fade"><div className="ei">⚖️</div><div>No legal notes saved yet. Get advice on a scenario and it saves automatically.</div><div className="evi">Chưa có ghi chú pháp lý nào. Nhận tư vấn về một tình huống và nó sẽ tự động lưu.</div></div>) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {legalNotes.map(n => (
                <div key={n.id} className="legal-note ani-fade">
                  <div className="ln-header">
                    <span className="ln-scenario">⚖️ {n.scenario}</span>
                    <span className="ln-date">{n.date}</span>
                    <button className="ci-del" onClick={() => onDeleteNote(n.id)}>×</button>
                  </div>
                  <div className="ln-context">Situation: {n.context}</div>
                  <details className="ln-details"><summary>View full legal analysis · Xem phân tích đầy đủ</summary><div className="aib" dangerouslySetInnerHTML={{ __html: n.result?.replace(/\n/g, "<br/>").replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/#{1,3} (.*)/g, "<h4>$1</h4>") || "" }} /></details>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── LEARN PAGE ────────────────────────────────────────────────────────────────
function LearnPage() {
  const [msgs, setMsgs] = useState(() => { try { return JSON.parse(localStorage.getItem("hb_chat") || "[]"); } catch { return []; } });
  const [input, setInput] = useState(""), [load, setLoad] = useState(false);
  const ref = useRef();
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight); }, [msgs]);
  useEffect(() => { localStorage.setItem("hb_chat", JSON.stringify(msgs.slice(-20))); }, [msgs]);
  const initMsg = { role: "assistant", en: "Hi! I'm your real estate tutor 🌸 Ask me anything about investing — in English or Vietnamese. I'll always answer in both languages.", vi: "Xin chào! Tôi là gia sư bất động sản của bạn 🌸 Hỏi tôi bất cứ điều gì về đầu tư." };
  async function send() {
    if (!input.trim() || load) return; const q = input; setInput(""); setLoad(true);
    const newMsgs = [...msgs, { role: "user", en: q, vi: "" }]; setMsgs(newMsgs);
    try {
      const text = await callClaude([...newMsgs.map(m => ({ role: m.role, content: m.en || q })), { role: "user", content: q }], "You are a warm, encouraging real estate tutor for a Vietnamese-American dentist. Answer EVERY question in BOTH English AND Vietnamese. Format: [EN]\n(answer)\n\n[VI]\n(translation). Simple language, encouraging tone.");
      const en = (text.match(/\[EN\]([\s\S]*?)(?=\[VI\]|$)/)?.[1] || text).trim();
      const vi = (text.match(/\[VI\]([\s\S]*?)$/)?.[1] || "").trim();
      setMsgs(p => [...p, { role: "assistant", en, vi }]);
    } catch { setMsgs(p => [...p, { role: "assistant", en: "Connection error. Please try again.", vi: "Lỗi kết nối. Vui lòng thử lại." }]); }
    setLoad(false);
  }
  return (
    <div className="page">
      <div className="ph"><div><h2 className="pt">Learn + Ask <span className="pvi">· Học & Hỏi</span></h2><p className="ps">Bilingual glossary + AI tutor · Chat history saved automatically</p></div></div>
      <div className="learn-layout">
        <div>{GLOSS.map((g, i) => <div key={g.en} className="gc ani-fade" style={{ animationDelay: `${i * 0.05}s` }}><div className="gc-terms"><span className="gc-en">{g.en}</span><span className="gc-vi">{g.vi}</span></div><div className="gc-def">{g.d}</div><div className="gc-defvi">{g.dvi}</div></div>)}</div>
        <div className="chat-col">
          <div className="chat-title">Ask Anything · Hỏi Bất Kỳ Điều Gì 💬</div>
          <div className="chat-box" ref={ref}>
            {msgs.length === 0 && <div className="mb"><div className="men">{initMsg.en}</div><div className="mvi">{initMsg.vi}</div></div>}
            {msgs.map((m, i) => <div key={i} className={`msg ${m.role === "user" ? "mu" : "mb"}`}>{m.en && <div className="men">{m.en}</div>}{m.vi && m.role !== "user" && <div className="mvi">{m.vi}</div>}</div>)}
            {load && <div className="mb"><div className="ml"><span className="load-d"><span /><span /><span /></span></div></div>}
          </div>
          <div className="ci-row"><input className="ci" placeholder="Ask anything… / Hỏi bất cứ điều gì…" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} /><button className="cs" onClick={send} disabled={load}>→</button></div>
          <div className="chips">{["What is IRR?", "How do I screen tenants?", "What is a 1031 exchange?", "Làm sao tìm property manager?", "What's a good cap rate?"].map(s => <button key={s} className="chip" onClick={() => setInput(s)}>{s}</button>)}</div>
        </div>
      </div>
    </div>
  );
}

// ─── SHARED MICRO COMPONENTS ──────────────────────────────────────────────────
function FS({ t, children }) { return <div className="fsec"><div className="fsec-hdr">{t}</div>{children}</div>; }
function FG({ children }) { return <div className="fg">{children}</div>; }
function FF({ fk, en, vi, ph, form, sf, ty = "text" }) { return <div className="field field-full" style={{ padding: "0 16px", marginTop: 12 }}><div className="fl"><span className="flen">{en}</span>{vi && <span className="flvi">{vi}</span>}</div><input className="finput" type={ty} placeholder={ph} value={form[fk] ?? ""} onChange={e => sf(fk, e.target.value)} /></div>; }
function F({ fk, en, vi, ph, form, sf, ty = "number", pre, suf }) { return <div className="field"><div className="fl"><span className="flen">{en}</span>{vi && <span className="flvi">{vi}</span>}</div><div className="fw">{pre && <span className="fpre">{pre}</span>}<input className={`finput ${pre ? "fhp" : ""} ${suf ? "fhs" : ""}`} type={ty} placeholder={ph} value={form[fk] ?? ""} onChange={e => sf(fk, e.target.value)} />{suf && <span className="fsuf">{suf}</span>}</div></div>; }
function Tog({ on, flip }) { return <button className={`tog ${on ? "tog-on" : ""}`} onClick={flip}><span className="tok" /></button>; }
function ST({ en, vi, inline }) { const el = <span className="st">{en}<span className="stvi"> · {vi}</span></span>; return inline ? el : <div className="st-w">{el}</div>; }
function KC({ v, e, vi, s }) { return <div className={`kc kc-${s} ani-bounce`}><div className="kcv">{v}</div><div className="kce">{e}</div><div className="kcvi">{vi}</div></div>; }
function MC({ v, e, vi, s, lg }) { return <div className={`mc mc-${s} ${lg ? "mc-lg" : ""}`}><div><div className="mce">{e}</div><div className="mcvi">{vi}</div></div><div className="mcv">{v}</div></div>; }
function PR({ e, vi, v, neg, bold, ind }) { return <div className={`pr ${bold ? "prb" : ""} ${ind ? "pri" : ""}`}><div><div className={`pre ${ind ? "prd" : ""}`}>{e}</div><div className="prvi">{vi}</div></div><span className={`prv ${neg ? "prn" : ""}`}>{v}</span></div>; }

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,600;0,700;1,400&family=Nunito:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#FEFCF7;--card:#FFFFFF;--surface:#FFF9F0;--border:#EDE8DF;--border2:#DDD5C8;
  --forest:#1A3D2B;--forest2:#2D6A4F;--forest3:#3A7D5F;--fp:#D1FAE5;--ff:#E8F5EE;
  --amber:#D97706;--amber2:#F59E0B;--ap:#FEF3C7;--af:#FFFBEB;
  --text:#1C1710;--muted:#78716C;--faint:#A8A29E;--light:#C8C0B8;
  --good:#059669;--gbg:#ECFDF5;--gb:#6EE7B7;
  --warn:#D97706;--wbg:#FFFBEB;--wb:#FCD34D;
  --bad:#DC2626;--bbg:#FEF2F2;--bb:#FCA5A5;
  --nbg:#F9F6F2;--nb:#E2DBD0;
  --sh:0 1px 4px rgba(26,61,43,.06),0 4px 16px rgba(26,61,43,.05);
  --shl:0 4px 24px rgba(26,61,43,.1),0 12px 48px rgba(26,61,43,.08);
}
body{background:var(--bg);font-family:'Nunito',sans-serif;color:var(--text);font-size:13px;line-height:1.6;}
input,select,button,textarea{font-family:inherit;}
button{cursor:pointer;}

/* ANIMATIONS */
@keyframes fi{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes slide-in{from{opacity:0;transform:translateX(-12px)}to{opacity:1;transform:translateX(0)}}
@keyframes bounce-in{0%{transform:scale(.8);opacity:0}60%{transform:scale(1.05)}100%{transform:scale(1);opacity:1}}
@keyframes pulse-ring{0%{transform:scale(.95);box-shadow:0 0 0 0 rgba(245,158,11,.5)}70%{transform:scale(1);box-shadow:0 0 0 12px rgba(245,158,11,0)}100%{transform:scale(.95);box-shadow:0 0 0 0 rgba(245,158,11,0)}}
@keyframes ping{0%{transform:scale(1);opacity:1}75%,100%{transform:scale(2);opacity:0}}
@keyframes dots{0%,80%,100%{transform:scale(0);opacity:0}40%{transform:scale(1);opacity:1}}
@keyframes fa-slide{from{opacity:0;transform:translateY(20px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes bub-in{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
.ani-fade{animation:fi .3s ease both;}
.ani-slide{animation:slide-in .25s ease both;}
.ani-bounce{animation:bounce-in .4s cubic-bezier(.34,1.56,.64,1) both;}

/* ROOT */
.root{display:flex;min-height:100vh;}
.main{flex:1;overflow-y:auto;}
.page{padding:28px 32px;max-width:1160px;animation:fi .25s ease;}
.sec-t{font-family:'Fraunces',serif;font-size:17px;font-weight:700;color:var(--text);margin-bottom:14px;}

/* SIDEBAR */
.sidebar{width:210px;background:var(--forest);display:flex;flex-direction:column;position:sticky;top:0;height:100vh;flex-shrink:0;overflow-y:auto;}
.sb-brand{display:flex;align-items:center;gap:10px;padding:20px 16px 14px;border-bottom:1px solid rgba(255,255,255,.1);}
.sb-mark{width:32px;height:32px;background:var(--amber2);border-radius:8px;display:flex;align-items:center;justify-content:center;font-family:'Fraunces',serif;font-size:18px;font-weight:700;color:var(--forest);flex-shrink:0;}
.sb-name{font-family:'Fraunces',serif;font-size:16px;color:white;font-weight:600;}
.sb-vi{font-size:10px;color:rgba(255,255,255,.45);}
.sb-nav{padding:10px 8px;flex:1;display:flex;flex-direction:column;gap:2px;}
.sbi{display:flex;align-items:center;gap:9px;padding:9px 10px;border-radius:9px;background:none;border:none;color:rgba(255,255,255,.5);font-size:12px;text-align:left;transition:all .15s;width:100%;position:relative;}
.sbi:hover{background:rgba(255,255,255,.08);color:rgba(255,255,255,.85);}
.sbi-on{background:rgba(255,255,255,.12)!important;color:white!important;}
.sbi-icon{font-size:14px;width:18px;text-align:center;}
.sbi-en{font-size:12px;font-weight:700;}
.sbi-vi{font-size:9px;opacity:.6;margin-top:1px;}
.sbi-pip{position:absolute;right:0;top:50%;transform:translateY(-50%);width:3px;height:18px;background:var(--amber2);border-radius:2px;}
.sb-foot{padding:12px 14px;border-top:1px solid rgba(255,255,255,.1);}
.sb-badge{font-size:9px;font-weight:800;color:var(--amber2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:2px;}
.sb-sub{font-size:9px;color:rgba(255,255,255,.35);}

/* PAGE HEADER */
.ph{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:22px;gap:16px;flex-wrap:wrap;}
.pt{font-family:'Fraunces',serif;font-size:23px;font-weight:700;color:var(--text);}
.pvi{color:var(--muted);font-weight:400;font-size:19px;}
.ps{font-size:11px;color:var(--muted);margin-top:3px;}

/* BUTTONS */
.btn-p{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:var(--forest);color:white;border:none;border-radius:10px;padding:11px 18px;font-size:13px;font-weight:800;transition:all .2s;}
.btn-p:hover{background:var(--forest2);transform:translateY(-1px);box-shadow:0 4px 14px rgba(26,61,43,.25);}
.btn-p:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none;}
.btn-sec{display:inline-flex;align-items:center;gap:6px;background:var(--card);color:var(--text);border:1.5px solid var(--border2);border-radius:8px;padding:8px 14px;font-size:12px;font-weight:700;transition:all .15s;}
.btn-sec:hover{border-color:var(--forest2);}
.btn-ghost{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:none;color:var(--muted);border:1.5px solid var(--border2);border-radius:10px;padding:10px 18px;font-size:12px;font-weight:700;transition:all .15s;}
.btn-ghost:hover{color:var(--forest);border-color:var(--forest2);}
.btn-link{background:none;border:none;color:var(--forest2);font-size:12px;font-weight:700;text-decoration:underline;text-underline-offset:3px;padding:0;}
.w100{width:100%;}
.saved-msg{font-size:12px;font-weight:700;color:var(--good);padding:8px 12px;background:var(--gbg);border-radius:8px;animation:bounce-in .3s ease;}

/* STATUS */
.status-row{display:flex;gap:5px;flex-wrap:wrap;}
.status-btn{background:var(--surface);border:1.5px solid var(--border2);border-radius:7px;padding:5px 10px;font-size:10px;font-weight:800;color:var(--muted);transition:all .15s;}
.status-btn:hover{color:var(--text);}
.status-on{font-weight:800!important;}
.status-pill{display:inline-block;padding:3px 9px;border-radius:20px;font-size:10px;font-weight:800;color:white;}
.badge{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;background:var(--amber2);color:white;border-radius:50%;font-size:9px;font-weight:800;margin-left:5px;}

/* HOME */
.hero{background:linear-gradient(135deg,var(--forest) 0%,var(--forest2) 55%,var(--forest3) 100%);border-radius:20px;padding:44px 48px;margin-bottom:22px;position:relative;overflow:hidden;}
.hero::before{content:'';position:absolute;top:-60px;right:-60px;width:280px;height:280px;background:radial-gradient(circle,rgba(255,255,255,.05),transparent 70%);pointer-events:none;}
.hero-tag{display:inline-block;background:rgba(255,255,255,.12);color:rgba(255,255,255,.85);font-size:11px;font-weight:700;padding:4px 14px;border-radius:20px;letter-spacing:.04em;margin-bottom:14px;}
.hero-h{font-family:'Fraunces',serif;font-size:38px;font-weight:700;color:white;line-height:1.2;margin-bottom:14px;}
.ha{color:var(--amber2);}
.hero-en{font-size:14px;color:rgba(255,255,255,.8);line-height:1.7;max-width:580px;margin-bottom:6px;}
.hero-vi{font-size:12px;color:rgba(255,255,255,.5);font-style:italic;line-height:1.6;max-width:540px;margin-bottom:22px;}
.hero-btns{display:flex;gap:10px;flex-wrap:wrap;}
.btn-hero{background:var(--amber2);color:var(--forest);border:none;border-radius:10px;padding:11px 20px;font-size:13px;font-weight:800;transition:all .2s;}
.btn-hero:hover{background:#E8B000;transform:translateY(-1px);box-shadow:0 4px 16px rgba(245,158,11,.4);}
.btn-hero-g{background:rgba(255,255,255,.1);color:white;border:1.5px solid rgba(255,255,255,.3);border-radius:10px;padding:11px 20px;font-size:13px;font-weight:700;transition:all .2s;}
.btn-hero-g:hover{background:rgba(255,255,255,.18);}
.fc-row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px;}
.fc{border-radius:14px;padding:18px 20px;border:1px solid var(--border);transition:transform .2s;cursor:default;}
.fc:hover{transform:translateY(-2px);box-shadow:var(--shl);}
.fc-n{font-family:'Fraunces',serif;font-size:26px;font-weight:700;color:var(--forest);margin-bottom:6px;}
.fc-e{font-size:12px;color:var(--text);line-height:1.5;margin-bottom:3px;}
.fc-v{font-size:10px;color:var(--muted);font-style:italic;}
.home-cur{background:var(--ff);border:1.5px solid var(--fp);border-radius:14px;padding:18px 22px;margin-bottom:20px;}
.hc-lbl{font-size:10px;font-weight:800;color:var(--forest);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;}
.hc-score{display:inline-flex;gap:8px;padding:5px 14px;border-radius:8px;border:1.5px solid;font-size:13px;font-weight:700;margin-bottom:12px;}
.hc-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px;}
.hck{background:white;border-radius:10px;padding:10px;text-align:center;border:1px solid var(--border);transition:transform .15s;}
.hck:hover{transform:translateY(-1px);}
.hck-v{font-family:'Fraunces',serif;font-size:17px;color:var(--forest);}
.hck-e{font-size:9px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-top:3px;}
.hck-vi{font-size:8px;color:var(--faint);}
.home-steps{margin-top:8px;}
.steps-g{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;}
.sc{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px;box-shadow:var(--sh);transition:transform .2s;}
.sc:hover{transform:translateY(-2px);box-shadow:var(--shl);}
.sc-n{font-size:10px;font-weight:800;color:var(--faint);letter-spacing:.06em;margin-bottom:8px;}
.sc-e{font-size:13px;font-weight:800;color:var(--text);margin-bottom:2px;}
.sc-v{font-size:10px;color:var(--muted);margin-bottom:8px;}
.sc-d{font-size:11px;color:var(--muted);line-height:1.6;margin-bottom:3px;}
.sc-dv{font-size:10px;color:var(--faint);font-style:italic;line-height:1.5;}

/* IMPORT */
.import-bar{background:linear-gradient(135deg,var(--af),var(--ff));border:1.5px solid var(--ap);border-radius:11px;padding:11px 16px;display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;}
.ib-text{font-size:13px;font-weight:800;}
.ib-hint{font-size:10px;color:var(--muted);}
.ib-btn{display:flex;align-items:center;gap:5px;background:white;border:1.5px solid var(--border2);border-radius:7px;padding:6px 12px;font-size:12px;font-weight:700;color:var(--muted);transition:all .15s;}
.ib-btn:hover,.ib-on{border-color:var(--forest2);color:var(--forest);background:var(--ff);}
.imp-panel{background:var(--card);border:1.5px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px;}
.ip-row{display:flex;gap:8px;}
.ip-in{flex:1;background:var(--bg);border:1.5px solid var(--border2);border-radius:7px;padding:8px 12px;color:var(--text);font-size:12px;outline:none;}
.ip-in:focus{border-color:var(--forest2);}
.ip-go{background:var(--forest);color:white;border:none;border-radius:7px;padding:8px 14px;font-size:16px;font-weight:800;transition:background .15s;}
.ip-go:hover{background:var(--forest2);}
.ip-warn{font-size:11px;color:var(--warn);margin-top:7px;}
.ip-ok{font-size:11px;color:var(--good);margin-top:7px;font-weight:700;}
.pdf-zone{border:1.5px dashed var(--border2);border-radius:8px;padding:20px;text-align:center;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:6px;color:var(--muted);font-size:12px;font-weight:600;transition:all .2s;}
.pdf-zone:hover{border-color:var(--forest2);color:var(--forest);background:var(--ff);}

/* ANALYZE LAYOUT */
.al{display:grid;grid-template-columns:330px 1fr;gap:18px;align-items:start;}
@media(max-width:820px){.al{grid-template-columns:1fr;}}

/* FORM */
.form-col{display:flex;flex-direction:column;gap:12px;}
.fsec{background:var(--card);border:1.5px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:var(--sh);transition:box-shadow .2s;}
.fsec:hover{box-shadow:var(--shl);}
.fsec-hdr{background:var(--surface);padding:10px 16px;font-size:10px;font-weight:800;color:var(--forest);text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border);}
.fsec>.fg{padding:0 16px;margin-top:12px;}
.fsec>.field{padding:0 16px;margin-top:12px;}
.fsec>.tog-row{padding:10px 16px;margin-top:8px;background:var(--surface);}
.fsec>*:last-child{padding-bottom:16px!important;}
.fg{display:grid;grid-template-columns:1fr 1fr;gap:9px;}
.field{display:flex;flex-direction:column;gap:4px;min-width:0;}
.field-full{grid-column:1/-1;}
.fl{display:flex;gap:5px;align-items:baseline;}
.flen{font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;}
.flvi{font-size:9px;color:var(--faint);}
.fw{position:relative;display:flex;align-items:center;}
.fpre,.fsuf{position:absolute;font-size:12px;color:var(--faint);pointer-events:none;z-index:1;font-weight:700;}
.fpre{left:9px;} .fsuf{right:9px;}
.finput{width:100%;background:var(--bg);border:1.5px solid var(--border2);border-radius:7px;padding:7px 9px;color:var(--text);font-size:12px;outline:none;transition:border-color .15s,box-shadow .15s;font-weight:600;}
.finput:focus{border-color:var(--forest2);background:white;box-shadow:0 0 0 3px rgba(45,106,79,.08);}
.fhp{padding-left:21px;} .fhs{padding-right:24px;}
select.finput{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23A8A29E'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 9px center;padding-right:26px;cursor:pointer;}
.tog-row{display:flex;align-items:center;justify-content:space-between;}
.tog{width:38px;height:21px;background:var(--light);border-radius:11px;border:none;position:relative;transition:background .2s;}
.tog-on{background:var(--forest2)!important;}
.tok{position:absolute;width:15px;height:15px;background:white;border-radius:50%;top:3px;left:3px;transition:left .2s;display:block;box-shadow:0 1px 3px rgba(0,0,0,.2);}
.tog-on .tok{left:20px;}

/* CONCERNS TRACKER */
.concerns-panel{background:var(--card);border:1.5px solid var(--ap);border-radius:12px;overflow:hidden;box-shadow:var(--sh);}
.cp-hdr{background:linear-gradient(135deg,var(--af),var(--card));padding:11px 16px;font-size:11px;font-weight:800;color:var(--amber);border-bottom:1px solid var(--ap);}
.cp-body{padding:14px 16px;display:flex;flex-direction:column;gap:10px;}
.cp-desc{font-size:11px;color:var(--muted);line-height:1.6;}
.cp-input-row{display:flex;gap:8px;}
.cp-add{background:var(--forest);color:white;border:none;border-radius:7px;padding:7px 14px;font-size:12px;font-weight:800;white-space:nowrap;transition:all .15s;}
.cp-add:hover{background:var(--forest2);}
.cp-empty{font-size:11px;color:var(--faint);font-style:italic;text-align:center;padding:8px 0;}
.concern-item{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:7px;}
.ci-top{display:flex;align-items:flex-start;gap:8px;}
.ci-cat{font-size:9px;font-weight:800;padding:2px 8px;border-radius:20px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;flex-shrink:0;}
.ci-cat-environmental{background:#FEF3C7;color:#92400E;}
.ci-cat-structural{background:#FEE2E2;color:#991B1B;}
.ci-cat-title{background:#EDE9FE;color:#5B21B6;}
.ci-cat-financial{background:#DBEAFE;color:#1E40AF;}
.ci-cat-market{background:#D1FAE5;color:#065F46;}
.ci-cat-general,.ci-cat-tenant,.ci-cat-legal{background:var(--nbg);color:var(--muted);}
.ci-text{flex:1;font-size:12px;font-weight:600;color:var(--text);}
.ci-date{font-size:10px;color:var(--faint);white-space:nowrap;flex-shrink:0;}
.ci-del{background:none;border:none;color:var(--faint);font-size:16px;padding:0 2px;line-height:1;transition:color .15s;flex-shrink:0;}
.ci-del:hover{color:var(--bad);}
.ci-analyze{background:linear-gradient(135deg,var(--forest),var(--forest2));color:white;border:none;border-radius:7px;padding:6px 12px;font-size:11px;font-weight:800;transition:all .15s;align-self:flex-start;}
.ci-analyze:hover{transform:translateY(-1px);}
.ci-ai-loading{font-size:11px;color:var(--muted);font-style:italic;}
.ci-ai-result{background:white;border:1px solid var(--fp);border-radius:8px;padding:10px 12px;font-size:11px;color:var(--text);line-height:1.7;}
.ci-ai-result strong{color:var(--forest);font-weight:800;}

/* METRICS */
.metrics-col{display:flex;flex-direction:column;gap:14px;}
.mp{display:flex;flex-direction:column;gap:16px;}
.empty{background:var(--card);border:1.5px dashed var(--border2);border-radius:14px;padding:48px 24px;text-align:center;color:var(--muted);display:flex;flex-direction:column;align-items:center;gap:10px;}
.ei{font-size:32px;}
.evi{font-size:11px;color:var(--faint);font-style:italic;}
.verdict{display:flex;align-items:center;gap:14px;padding:14px 18px;border-radius:12px;border:2px solid;}
.v-s{font-family:'Fraunces',serif;font-size:20px;font-weight:700;white-space:nowrap;}
.v-l{font-size:13px;font-weight:800;}
.v-vi{font-size:10px;color:var(--muted);margin-top:2px;}
.st-w{margin-bottom:2px;}
.st{font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;}
.stvi{font-weight:600;text-transform:none;letter-spacing:0;color:var(--faint);}
.krow{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;}
.kc{background:var(--card);border:1.5px solid var(--border);border-radius:10px;padding:12px;text-align:center;box-shadow:var(--sh);transition:transform .15s;}
.kc:hover{transform:translateY(-2px);box-shadow:var(--shl);}
.kc-g{border-color:var(--gb)!important;background:var(--gbg);}
.kc-w{border-color:var(--wb)!important;background:var(--wbg);}
.kc-b{border-color:var(--bb)!important;background:var(--bbg);}
.kc-n{background:var(--nbg);border-color:var(--nb)!important;}
.kcv{font-family:'Fraunces',serif;font-size:20px;font-weight:700;color:var(--forest);}
.kce{font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-top:3px;}
.kcvi{font-size:8px;color:var(--faint);margin-top:1px;}
.pl{background:var(--card);border:1.5px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:var(--sh);}
.pr{display:flex;align-items:center;justify-content:space-between;padding:7px 14px;border-bottom:1px solid var(--border);}
.pr:last-child{border-bottom:none;}
.prb .pre{font-weight:800!important;color:var(--text)!important;}
.prb .prv{font-weight:800!important;}
.pre{font-size:12px;color:var(--text);font-weight:600;}
.prd{color:var(--muted)!important;font-weight:500!important;}
.prvi{font-size:9px;color:var(--faint);}
.prv{font-size:12px;font-weight:700;white-space:nowrap;}
.prn{color:var(--bad)!important;}
.pld{height:1px;background:var(--border2);}
.plcf{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;}
.plcf-p{background:linear-gradient(135deg,var(--gbg),#F0FFF8);}
.plcf-n{background:var(--bbg);}
.plcf-tag{font-size:8px;font-weight:800;letter-spacing:.06em;color:var(--muted);margin-bottom:3px;text-transform:uppercase;}
.plcf-v{font-family:'Fraunces',serif;font-size:26px;font-weight:700;color:var(--text);}
.plcf-v span{font-size:12px;color:var(--muted);margin-left:2px;}
.plcf-ann{font-family:'Fraunces',serif;font-size:16px;color:var(--muted);}
.plcf-ann span{font-size:11px;}
.mcg{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
.mc3{grid-template-columns:repeat(3,1fr);}
.mc{background:var(--card);border:1.5px solid var(--border);border-radius:10px;padding:10px 12px;box-shadow:var(--sh);transition:transform .15s;cursor:default;}
.mc:hover{transform:translateY(-1px);box-shadow:var(--shl);}
.mc-lg{padding:13px 14px;}
.mc-g{border-color:var(--gb)!important;background:var(--gbg);}
.mc-w{border-color:var(--wb)!important;background:var(--wbg);}
.mc-b{border-color:var(--bb)!important;background:var(--bbg);}
.mc-n{background:var(--nbg);border-color:var(--nb)!important;}
.mce{font-size:9px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;}
.mcvi{font-size:8px;color:var(--faint);margin-bottom:4px;}
.mcv{font-family:'Fraunces',serif;font-size:16px;font-weight:700;color:var(--text);}
.mc-lg .mcv{font-size:20px;}
.coll{display:flex;align-items:center;justify-content:space-between;width:100%;background:var(--card);border:1.5px solid var(--border);border-radius:10px;padding:11px 14px;color:var(--muted);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;transition:all .15s;}
.coll:hover{background:var(--surface);color:var(--text);}
.tw{overflow-x:auto;border-radius:10px;border:1.5px solid var(--border);box-shadow:var(--sh);}
.tbl{width:100%;border-collapse:collapse;background:var(--card);}
.tbl th{background:var(--forest);color:rgba(255,255,255,.85);font-size:9px;font-weight:800;padding:9px 11px;text-align:right;letter-spacing:.04em;text-transform:uppercase;}
.tbl th:first-child{text-align:center;}
.tbl td{padding:7px 11px;text-align:right;font-size:11px;font-weight:600;border-bottom:1px solid var(--border);color:var(--text);}
.tbl td:first-child{text-align:center;}
.tbl tr:last-child td{border-bottom:none;}
.ty{font-weight:800;color:var(--forest);font-size:12px;}
.xt{font-size:8px;background:var(--amber2);color:white;border-radius:4px;padding:1px 5px;margin-left:3px;font-weight:800;vertical-align:middle;}
.tr-x{background:var(--af)!important;} .tr-hl{background:var(--ff)!important;}
.tg{color:var(--good)!important;} .tr{color:var(--bad)!important;} .tb{font-weight:800!important;}
.td-g{color:var(--good)!important;} .td-r{color:var(--bad)!important;} .td-bold{font-weight:800!important;}
.sens{background:var(--card);border:1.5px solid var(--border);border-radius:10px;overflow:hidden;}
.sh{display:grid;grid-template-columns:110px 1fr 1fr 1fr;background:var(--forest);}
.sh>div{color:rgba(255,255,255,.8);font-size:10px;font-weight:800;padding:9px 10px;text-align:center;border-left:1px solid rgba(255,255,255,.1);text-transform:uppercase;}
.sh>div:first-child{border-left:none;}
.sr{display:grid;grid-template-columns:110px 1fr 1fr 1fr;border-bottom:1px solid var(--border);}
.sr:last-child{border-bottom:none;}
.sl{background:var(--surface);font-size:10px;font-weight:800;color:var(--forest);padding:10px;border-right:1px solid var(--border);}
.sc{padding:10px;text-align:center;font-size:11px;font-weight:800;border-left:1px solid var(--border);}
.sg{color:var(--good);background:var(--gbg);} .sw{color:var(--warn);background:var(--wbg);} .sb{color:var(--bad);background:var(--bbg);}
.aic{background:var(--card);border:1.5px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:var(--sh);}
.aih{background:var(--forest);padding:12px 16px;font-size:11px;font-weight:800;color:rgba(255,255,255,.85);text-transform:uppercase;letter-spacing:.05em;}
.ail{padding:18px;font-size:12px;color:var(--muted);font-style:italic;}
.aib{padding:18px;font-size:13px;line-height:1.85;color:var(--text);}
.aib h4{font-family:'Fraunces',serif;font-size:16px;color:var(--forest);margin:14px 0 5px;font-weight:700;}
.aib h4:first-child{margin-top:0;}
.aib strong{font-weight:800;}

/* COMPARE */
.port-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:18px;}
.ps-card{background:var(--ff);border:1.5px solid var(--fp);border-radius:12px;padding:16px 18px;}
.psc-n{font-family:'Fraunces',serif;font-size:22px;font-weight:700;color:var(--forest);margin-bottom:3px;}
.psc-l{font-size:11px;color:var(--muted);font-weight:600;}
.cmp-tbl{width:100%;border-collapse:collapse;background:var(--card);border-radius:12px;overflow:hidden;border:1.5px solid var(--border);box-shadow:var(--sh);}
.cmp-tbl th{background:var(--forest);color:rgba(255,255,255,.85);font-size:10px;font-weight:800;padding:10px 14px;text-align:left;text-transform:uppercase;letter-spacing:.04em;}
.cmp-tbl td{padding:10px 14px;font-size:12px;border-bottom:1px solid var(--border);color:var(--text);font-weight:600;transition:background .15s;}
.cmp-tbl tr:last-child td{border-bottom:none;}
.cmp-tbl tr:hover td{background:var(--surface)!important;}
.cmp-sel td{background:var(--ff)!important;}
.cmp-addr{font-weight:700;} .cmp-date{font-size:10px;color:var(--faint);}
.cmp-btn{background:var(--surface);border:1px solid var(--border2);border-radius:6px;padding:4px 10px;font-size:11px;font-weight:700;color:var(--muted);transition:all .15s;}
.cmp-btn:hover{color:var(--forest);border-color:var(--forest2);}
.cmp-del{color:var(--bad)!important;}
.cmp-del:hover{border-color:var(--bad)!important;background:var(--bbg)!important;}

/* DUE DILIGENCE */
.ddp{display:flex;flex-direction:column;align-items:flex-end;gap:3px;}
.ddpn{font-family:'Fraunces',serif;font-size:17px;font-weight:700;color:var(--forest);}
.ddpb{width:110px;height:5px;background:var(--border2);border-radius:3px;overflow:hidden;}
.ddpf{height:100%;background:linear-gradient(90deg,var(--forest),var(--amber2));border-radius:3px;transition:width .4s;}
.ddpp{font-size:10px;font-weight:800;color:var(--muted);}
.time-banner{background:linear-gradient(135deg,var(--forest),var(--forest2));border-radius:14px;padding:20px 24px;margin-bottom:18px;}
.tb-t{font-family:'Fraunces',serif;font-size:15px;font-weight:700;color:white;margin-bottom:12px;}
.tb-g{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;}
.tb-i{display:flex;flex-direction:column;gap:3px;}
.tb-n{font-family:'Fraunces',serif;font-size:18px;font-weight:700;color:var(--amber2);}
.tb-d{font-size:11px;color:rgba(255,255,255,.6);line-height:1.5;}
.ddph{background:var(--card);border:1.5px solid var(--border);border-radius:14px;overflow:hidden;box-shadow:var(--sh);transition:box-shadow .2s;}
.ddph:hover{box-shadow:var(--shl);}
.dph-hdr{display:flex;align-items:flex-start;gap:12px;padding:14px 18px;border-bottom:1px solid var(--border);background:var(--surface);}
.dph-badge{font-size:9px;font-weight:800;color:white;padding:4px 10px;border-radius:5px;letter-spacing:.05em;text-transform:uppercase;flex-shrink:0;margin-top:2px;}
.dph-t{font-size:13px;font-weight:800;color:var(--text);}
.dph-vi{font-weight:600;color:var(--muted);}
.dph-m{font-size:11px;color:var(--muted);margin-top:3px;}
.dph-p{margin-left:auto;font-family:'Fraunces',serif;font-size:15px;font-weight:700;color:var(--forest);flex-shrink:0;}
.dph-tasks{padding:10px 18px 14px;display:flex;flex-direction:column;gap:5px;}
.task{display:flex;align-items:flex-start;gap:10px;padding:7px 9px;border-radius:8px;cursor:pointer;transition:background .12s;user-select:none;}
.task:hover{background:var(--surface);}
.task-d{opacity:.5;}
.tcb{width:17px;height:17px;border:2px solid var(--border2);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;flex-shrink:0;margin-top:1px;transition:all .2s;background:white;}
.tcb-on{background:var(--forest)!important;border-color:var(--forest)!important;color:white!important;transform:scale(1.1);}
.ten{font-size:12px;font-weight:700;color:var(--text);}
.tvi{font-size:10px;color:var(--muted);}

/* FREEDOM */
.fr-hero{background:linear-gradient(135deg,var(--forest),var(--forest2));border-radius:14px;padding:22px 28px;margin-bottom:20px;}
.frh-en{font-size:14px;color:rgba(255,255,255,.85);line-height:1.7;margin-bottom:6px;}
.frh-vi{font-size:12px;color:rgba(255,255,255,.5);font-style:italic;line-height:1.6;}
.fr-layout{display:grid;grid-template-columns:1fr 1fr;gap:18px;}
@media(max-width:700px){.fr-layout{grid-template-columns:1fr;}}
.fr-form{background:var(--card);border:1.5px solid var(--border);border-radius:14px;overflow:hidden;box-shadow:var(--sh);}
.fr-results{display:flex;flex-direction:column;gap:14px;}
.frr-card{background:var(--forest);border-radius:14px;padding:24px 28px;text-align:center;}
.frr-top{font-size:9px;font-weight:800;color:rgba(255,255,255,.5);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;}
.frr-num{font-family:'Fraunces',serif;font-size:64px;font-weight:700;color:var(--amber2);line-height:1;}
.frr-unit{font-size:13px;color:rgba(255,255,255,.6);margin-top:6px;margin-bottom:14px;}
.frr-desc{font-size:13px;color:rgba(255,255,255,.8);line-height:1.6;}
.frr-descvi{font-size:11px;color:rgba(255,255,255,.5);font-style:italic;margin-top:5px;line-height:1.5;}
.frr-prog-card{background:var(--card);border:1.5px solid var(--border);border-radius:12px;padding:18px 20px;box-shadow:var(--sh);}
.frp-title{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;}
.frp-bar-wrap{height:10px;background:var(--border2);border-radius:5px;overflow:hidden;margin-bottom:6px;}
.frp-bar{height:100%;background:linear-gradient(90deg,var(--forest),var(--amber2));border-radius:5px;transition:width .8s cubic-bezier(.34,1.56,.64,1);}
.frp-labels{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);font-weight:700;}
.frr-saved{background:var(--card);border:1.5px solid var(--border);border-radius:12px;padding:16px 18px;box-shadow:var(--sh);}
.frp-prop{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);}
.frp-prop:last-child{border-bottom:none;}
.frp-addr{flex:1;font-size:12px;font-weight:700;}
.frp-cf{font-size:12px;font-weight:800;}
.frp-score{font-size:10px;font-weight:800;margin-left:auto;}

/* FIND PAGE */
.find-filters{background:var(--card);border:1.5px solid var(--border);border-radius:14px;padding:20px;margin-bottom:18px;box-shadow:var(--sh);}
.ff-section-title{font-size:10px;font-weight:800;color:var(--forest);text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px;margin-top:16px;padding-bottom:6px;border-bottom:1px solid var(--border);}
.ff-section-title:first-child{margin-top:0;}
.ff-grid3{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;}
@media(max-width:700px){.ff-grid3{grid-template-columns:repeat(2,1fr);}}
.find-loading{background:var(--ff);border:1.5px solid var(--fp);border-radius:12px;padding:20px 24px;display:flex;align-items:center;gap:16px;margin-bottom:16px;animation:fi .3s ease;}
.find-load-dots{display:flex;gap:6px;flex-shrink:0;}
.find-load-dots span{width:10px;height:10px;background:var(--forest2);border-radius:50%;animation:dots 1.4s ease-in-out infinite both;}
.find-load-dots span:nth-child(2){animation-delay:.2s;}
.find-load-dots span:nth-child(3){animation-delay:.4s;}
.deal-results{display:flex;flex-direction:column;gap:16px;}
.dr-header{margin-bottom:4px;}
.dr-title{font-family:'Fraunces',serif;font-size:18px;font-weight:700;color:var(--text);}
.dr-sub{font-size:11px;color:var(--muted);margin-top:2px;}
.deal-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;}
.deal-card{background:var(--card);border:1.5px solid var(--border);border-radius:14px;padding:16px;box-shadow:var(--sh);display:flex;flex-direction:column;gap:10px;transition:transform .2s,box-shadow .2s;}
.deal-card:hover{transform:translateY(-3px);box-shadow:var(--shl);}
.dc-header{display:flex;align-items:flex-start;gap:10px;}
.dc-score{font-size:9px;font-weight:800;padding:4px 10px;border-radius:20px;white-space:nowrap;flex-shrink:0;text-transform:uppercase;letter-spacing:.05em;}
.dc-addr{font-size:13px;font-weight:800;color:var(--text);line-height:1.4;}
.dc-metrics{display:grid;grid-template-columns:1fr 1fr;gap:4px;}
.dcm{display:flex;flex-direction:column;gap:1px;padding:6px 8px;background:var(--surface);border-radius:6px;}
.dcm-l{font-size:9px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;}
.dcm-v{font-size:12px;font-weight:800;color:var(--text);}
.dc-why{font-size:11px;color:var(--muted);line-height:1.6;font-style:italic;}
.dc-flags{display:flex;flex-direction:column;gap:4px;}
.dc-green{font-size:11px;color:var(--good);font-weight:600;}
.dc-watch{font-size:11px;color:var(--warn);font-weight:600;}
.dc-actions{display:flex;flex-direction:column;gap:6px;margin-top:2px;padding-top:10px;border-top:1px solid var(--border);}
.dc-link{display:inline-flex;align-items:center;gap:4px;background:var(--forest);color:white;border-radius:7px;padding:7px 12px;font-size:11px;font-weight:800;text-decoration:none;transition:all .15s;align-self:flex-start;}
.dc-link:hover{background:var(--forest2);}
.dc-contact{font-size:11px;color:var(--muted);line-height:1.5;}
.dc-contact-label{font-weight:800;color:var(--text);}
.result-card{background:var(--card);border:1.5px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:var(--sh);}
.rc-hdr{background:var(--forest);padding:12px 18px;font-size:11px;font-weight:800;color:rgba(255,255,255,.85);text-transform:uppercase;letter-spacing:.05em;}
.rc-body{padding:18px;font-size:13px;line-height:1.85;}
.rc-body h4{font-family:'Fraunces',serif;font-size:16px;color:var(--forest);margin:14px 0 5px;font-weight:700;}
.rc-body strong{font-weight:800;}

/* TABS */
.tab-row{display:flex;gap:6px;margin-bottom:18px;}
.tab-btn{background:var(--surface);border:1.5px solid var(--border2);border-radius:8px;padding:8px 16px;font-size:12px;font-weight:700;color:var(--muted);transition:all .15s;display:flex;align-items:center;}
.tab-btn:hover{color:var(--text);}
.tab-on{background:var(--forest);color:white!important;border-color:var(--forest)!important;}
.alert-panel{max-width:660px;}
.ap-info{background:linear-gradient(135deg,var(--af),var(--ff));border:1.5px solid var(--ap);border-radius:12px;padding:18px 20px;margin-bottom:18px;}
.api-t{font-size:13px;font-weight:800;color:var(--forest);margin-bottom:8px;}
.api-en{font-size:12px;color:var(--text);line-height:1.7;margin-bottom:5px;}
.api-vi{font-size:11px;color:var(--muted);font-style:italic;line-height:1.6;}
.alert-success{background:var(--gbg);border:1.5px solid var(--gb);border-radius:10px;padding:16px 20px;font-size:13px;font-weight:700;color:var(--good);}

/* LEGAL */
.legal-disclaimer{background:var(--af);border:1.5px solid var(--ap);border-radius:10px;padding:12px 16px;font-size:11px;color:var(--amber);font-weight:600;margin-bottom:18px;line-height:1.6;}
.ls-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:20px;}
.ls-card{background:var(--card);border:1.5px solid var(--border);border-radius:12px;padding:14px;text-align:left;transition:all .2s;display:flex;flex-direction:column;gap:4px;}
.ls-card:hover{border-color:var(--forest2);background:var(--ff);transform:translateY(-2px);box-shadow:var(--shl);}
.ls-on{border-color:var(--forest)!important;background:var(--ff)!important;box-shadow:0 0 0 3px rgba(26,61,43,.12)!important;}
.ls-icon{font-size:20px;margin-bottom:4px;}
.ls-en{font-size:12px;font-weight:800;color:var(--text);}
.ls-vi{font-size:10px;color:var(--muted);}
.ls-urgency{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;margin-top:4px;}
.legal-context{background:var(--card);border:1.5px solid var(--border);border-radius:12px;padding:18px;margin-bottom:16px;box-shadow:var(--sh);}
.lc-title{font-family:'Fraunces',serif;font-size:16px;font-weight:700;color:var(--text);margin-bottom:4px;}
.lc-subtitle{font-size:11px;color:var(--muted);line-height:1.6;margin-bottom:12px;}
.lc-textarea{width:100%;background:var(--bg);border:1.5px solid var(--border2);border-radius:8px;padding:12px 14px;font-family:'Nunito',sans-serif;font-size:13px;color:var(--text);outline:none;resize:vertical;line-height:1.6;margin-bottom:12px;transition:border-color .15s;}
.lc-textarea:focus{border-color:var(--forest2);background:white;}
.legal-note{background:var(--card);border:1.5px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:var(--sh);}
.ln-header{display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--surface);border-bottom:1px solid var(--border);}
.ln-scenario{font-size:13px;font-weight:800;color:var(--text);flex:1;}
.ln-date{font-size:10px;color:var(--faint);}
.ln-context{padding:12px 16px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--border);background:var(--nbg);}
.ln-details{padding:0;}
.ln-details summary{padding:10px 16px;font-size:12px;font-weight:700;color:var(--forest);cursor:pointer;transition:background .15s;}
.ln-details summary:hover{background:var(--surface);}
.ln-details .aib{padding:16px;}

/* LEARN */
.learn-layout{display:grid;grid-template-columns:1fr 380px;gap:18px;align-items:start;}
@media(max-width:880px){.learn-layout{grid-template-columns:1fr;}}
.gc{background:var(--card);border:1.5px solid var(--border);border-radius:10px;padding:13px 16px;box-shadow:var(--sh);margin-bottom:8px;transition:box-shadow .15s,transform .15s;}
.gc:hover{box-shadow:var(--shl);transform:translateY(-1px);}
.gc-terms{display:flex;align-items:baseline;gap:10px;margin-bottom:5px;}
.gc-en{font-size:13px;font-weight:800;color:var(--forest);}
.gc-vi{font-size:11px;color:var(--muted);font-weight:600;}
.gc-def{font-size:12px;color:var(--text);line-height:1.65;}
.gc-defvi{font-size:10px;color:var(--muted);font-style:italic;margin-top:2px;line-height:1.5;}
.chat-col{background:var(--card);border:1.5px solid var(--border);border-radius:14px;overflow:hidden;position:sticky;top:16px;box-shadow:var(--shl);}
.chat-title{background:linear-gradient(135deg,var(--forest),var(--forest2));padding:13px 16px;font-size:13px;font-weight:800;color:white;}
.chat-box{height:400px;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--surface);}
.chat-box::-webkit-scrollbar{width:3px;} .chat-box::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px;}
.msg{max-width:92%;display:flex;flex-direction:column;gap:4px;}
.mb{align-self:flex-start;} .mu{align-self:flex-end;}
.men{background:white;border:1px solid var(--border);border-radius:10px 10px 10px 3px;padding:9px 12px;font-size:12px;line-height:1.65;font-weight:600;}
.mvi{background:var(--ff);border:1px solid var(--fp);border-radius:3px 10px 10px 10px;padding:7px 11px;font-size:11px;line-height:1.6;color:var(--forest);font-style:italic;}
.mu .men{background:var(--forest);border-color:var(--forest);color:white;border-radius:10px 10px 3px 10px;}
.ml{background:white;border:1px solid var(--border);border-radius:10px;padding:9px 14px;}
.load-d{display:flex;gap:4px;align-items:center;}
.load-d span{width:7px;height:7px;background:var(--muted);border-radius:50%;animation:dots 1.4s ease-in-out infinite both;}
.load-d span:nth-child(2){animation-delay:.2s;} .load-d span:nth-child(3){animation-delay:.4s;}
.ci-row{display:flex;gap:7px;padding:10px;border-top:1px solid var(--border);}
.ci{flex:1;background:var(--bg);border:1.5px solid var(--border2);border-radius:8px;padding:8px 12px;font-size:12px;font-weight:600;color:var(--text);outline:none;}
.ci:focus{border-color:var(--forest2);}
.cs{background:var(--forest);color:white;border:none;border-radius:8px;padding:8px 14px;font-size:15px;font-weight:800;transition:background .15s;}
.cs:hover{background:var(--forest2);}
.chips{display:flex;flex-wrap:wrap;gap:5px;padding:0 10px 10px;}
.chip{background:var(--af);border:1px solid var(--ap);border-radius:18px;padding:4px 11px;font-size:10px;color:var(--amber);font-weight:700;transition:all .15s;}
.chip:hover{background:var(--ap);border-color:var(--amber);}

/* ONBOARDING */
.ob-overlay{position:fixed;inset:0;background:rgba(26,61,43,.7);z-index:1000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);}
.ob-modal{background:white;border-radius:20px;padding:36px 40px;max-width:480px;width:90%;box-shadow:var(--shl);animation:fa-slide .4s cubic-bezier(.34,1.56,.64,1);}
.ob-dots{display:flex;gap:6px;margin-bottom:20px;}
.ob-dot{height:8px;border-radius:4px;background:var(--border2);transition:all .3s;}
.ob-dot-on{background:var(--forest);width:24px;}
.ob-dot:not(.ob-dot-on){width:8px;}
.ob-t{font-family:'Fraunces',serif;font-size:22px;font-weight:700;color:var(--text);margin-bottom:4px;}
.ob-tv{font-size:13px;color:var(--muted);font-style:italic;margin-bottom:16px;}
.ob-b{font-size:14px;color:var(--text);line-height:1.7;margin-bottom:6px;}
.ob-bv{font-size:12px;color:var(--muted);font-style:italic;line-height:1.6;margin-bottom:24px;}
.ob-btns{display:flex;gap:10px;margin-bottom:12px;}
.ob-next{background:var(--forest);color:white;border:none;border-radius:10px;padding:12px 20px;font-size:13px;font-weight:800;flex:1;transition:all .2s;}
.ob-next:hover{background:var(--forest2);}
.ob-back{background:none;border:1.5px solid var(--border2);border-radius:10px;padding:12px 16px;font-size:13px;font-weight:700;color:var(--muted);}
.ob-skip{background:none;border:none;font-size:11px;color:var(--faint);width:100%;text-align:center;}
.ob-skip:hover{color:var(--muted);}

/* FLOATING ASSISTANT */
.fa-wrap{position:fixed;bottom:24px;right:24px;z-index:500;display:flex;flex-direction:column;align-items:flex-end;gap:10px;}
.fa-btn{width:52px;height:52px;background:var(--forest);color:white;border:none;border-radius:50%;font-family:'Fraunces',serif;font-size:20px;font-weight:700;box-shadow:0 4px 20px rgba(26,61,43,.35);transition:all .2s;position:relative;flex-shrink:0;}
.fa-btn:hover{background:var(--forest2);transform:scale(1.08);}
.fa-pulse{animation:pulse-ring 2s ease-in-out 3;}
.fa-ping{position:absolute;top:-2px;right:-2px;width:14px;height:14px;background:var(--amber2);border-radius:50%;animation:ping 1.5s ease-in-out infinite;}
.fa-bubble{background:white;border:1.5px solid var(--fp);border-radius:14px 14px 4px 14px;padding:12px 16px;max-width:260px;box-shadow:var(--shl);animation:bub-in .3s ease;}
.fa-bub-text{font-size:12px;font-weight:600;color:var(--text);line-height:1.5;margin-bottom:3px;}
.fa-bub-vi{font-size:10px;color:var(--muted);font-style:italic;line-height:1.5;}
.fa-panel{background:white;border:1.5px solid var(--border);border-radius:16px;width:320px;box-shadow:var(--shl);overflow:hidden;animation:fa-slide .3s cubic-bezier(.34,1.56,.64,1);}
.fa-header{display:flex;align-items:center;gap:10px;padding:14px 16px;background:var(--forest);border-bottom:1px solid rgba(255,255,255,.1);}
.fa-avatar{width:32px;height:32px;background:var(--amber2);border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Fraunces',serif;font-size:16px;font-weight:700;color:var(--forest);flex-shrink:0;}
.fa-name{font-size:13px;font-weight:800;color:white;}
.fa-status{font-size:10px;color:rgba(255,255,255,.55);margin-top:1px;}
.fa-close{background:none;border:none;color:rgba(255,255,255,.55);font-size:20px;padding:0;margin-left:auto;line-height:1;transition:color .15s;}
.fa-close:hover{color:white;}
.fa-msgs{height:280px;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:var(--surface);}
.fa-msgs::-webkit-scrollbar{width:3px;} .fa-msgs::-webkit-scrollbar-thumb{background:var(--border2);}
.fa-msg{max-width:90%;display:flex;flex-direction:column;gap:3px;}
.fa-bot{align-self:flex-start;}
.fa-user{align-self:flex-end;}
.fa-msg-en{background:white;border:1px solid var(--border);border-radius:10px 10px 10px 3px;padding:8px 11px;font-size:12px;line-height:1.6;font-weight:600;}
.fa-msg-vi{background:var(--ff);border:1px solid var(--fp);border-radius:3px 10px 10px 10px;padding:6px 10px;font-size:10px;line-height:1.5;color:var(--forest);font-style:italic;}
.fa-user .fa-msg-en{background:var(--forest);border-color:var(--forest);color:white;border-radius:10px 10px 3px 10px;}
.fa-typing{background:white;border:1px solid var(--border);border-radius:10px;padding:10px 14px;display:flex;gap:4px;align-items:center;}
.fa-typing span{width:6px;height:6px;background:var(--muted);border-radius:50%;animation:dots 1.4s ease-in-out infinite both;}
.fa-typing span:nth-child(2){animation-delay:.2s;} .fa-typing span:nth-child(3){animation-delay:.4s;}
.fa-input-row{display:flex;gap:6px;padding:10px;border-top:1px solid var(--border);background:white;}
.fa-input{flex:1;background:var(--bg);border:1.5px solid var(--border2);border-radius:8px;padding:7px 11px;font-size:12px;color:var(--text);outline:none;}
.fa-input:focus{border-color:var(--forest2);}
.fa-send{background:var(--forest);color:white;border:none;border-radius:8px;padding:7px 13px;font-size:14px;font-weight:800;transition:background .15s;}
.fa-send:hover{background:var(--forest2);}
`;
