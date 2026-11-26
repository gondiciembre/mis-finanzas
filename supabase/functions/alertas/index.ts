// Finanzas Gonzo · alertas push (Supabase Edge Function "alertas")
// Sin claves en el código: usa SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY del entorno de Supabase.
// Las claves VAPID se generan solas la primera vez y se guardan en public.push_state (sin acceso público).
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------- utilidades ----------
type Any = any;
const nowART = () => new Date(Date.now() - 3 * 3600e3); // Argentina, UTC-3
const dISO = (d: Date) => d.toISOString().slice(0, 10);
const nf = (n: number, d = 0) => n.toLocaleString("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d });
const pc = (n: number) => (n >= 0 ? "+" : "−") + nf(Math.abs(n), 1) + "%";
const addDays = (s: string, n: number) => dISO(new Date(Date.parse(s + "T12:00:00Z") + n * 864e5));
const addY = (s: string, n: number) => (+s.slice(0, 4) + n) + s.slice(4);
const ymK = (y: number, m: number) => y + "-" + String(m + 1).padStart(2, "0");
const mAdd = (k: string, n: number) => { const y = +k.slice(0, 4), m = +k.slice(5, 7) - 1 + n; return ymK(y + Math.floor(m / 12), ((m % 12) + 12) % 12); };
const mDiff = (a: string, b: string) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));
const fd = (s: string) => s.slice(8, 10) + "/" + s.slice(5, 7);
async function J(u: string) { const r = await fetch(u, { headers: { "user-agent": "mis-finanzas-alertas" } }); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }
const safe = async <T>(p: Promise<T>): Promise<T | null> => { try { return await p; } catch (_) { return null; } };

// ---------- estado y claves ----------
async function getState(id: string): Promise<Any> { const { data } = await SB.from("push_state").select("data").eq("id", id).maybeSingle(); return data ? data.data : null; }
async function setState(id: string, data: Any) { await SB.from("push_state").upsert({ id, data, updated_at: new Date().toISOString() }); }
async function vapid() { let k = await getState("vapid"); if (!k) { k = webpush.generateVAPIDKeys(); await setState("vapid", k); } return k; }

// ---------- mercado (una vez por corrida) ----------
const API = "https://rendimientos.co/api/", AD = "https://api.argentinadatos.com/v1/";
async function market() {
  const [ced, ons, sob, usa, dol, uva, bolsa, blue] = await Promise.all([
    safe(J(API + "cedears")), safe(J(API + "ons")), safe(J(API + "soberanos")), safe(J(API + "usa-stocks")),
    safe(J("https://dolarapi.com/v1/dolares")), safe(J(AD + "finanzas/indices/uva")), safe(J(AD + "cotizaciones/dolares/bolsa")), safe(J(AD + "cotizaciones/dolares/blue"))]);
  const usd: Record<string, [number, number | null]> = {}, ars: Record<string, [number, number | null]> = {}, base: Record<string, 1> = {};
  const C = (ced && ced.data) || [];
  C.forEach((x: Any) => base[x.symbol] = 1);
  const isD = (s: string) => /D$/.test(s) && (base[s.slice(0, -1)] || base[s.slice(0, -1) + "C"]);
  C.forEach((x: Any) => { if (!x.c) return; if (isD(x.symbol)) usd[x.symbol] = [x.c, x.pct_change]; else if (!(/C$/.test(x.symbol) && base[x.symbol.slice(0, -1)])) ars[x.symbol] = [x.c, x.pct_change]; });
  ((ons && ons.data) || []).forEach((x: Any) => { if (x.c && /D$/.test(x.symbol)) usd[x.symbol] = [x.c, x.pct_change]; });
  ((sob && sob.data) || []).forEach((x: Any) => { if (x.price_usd) usd[x.symbol + "D"] = [x.price_usd, x.pct_change]; });
  const us: Record<string, [number, number | null]> = {};
  ((usa && usa.data) || []).forEach((x: Any) => { if (x.c) us[x.symbol] = [x.c, x.pct_change]; });
  const dl: Record<string, Any> = {}; (dol || []).forEach((x: Any) => dl[x.casa] = x);
  return { usd, ars, us, ok: C.length > 0, mep: dl.bolsa, blue: dl.blue, uva: uva || [], bolsa: bolsa || [], blueH: blue || [] };
}

// ---------- cartera (misma lógica que la app) ----------
const DTK: Record<string, string> = { BPOB8: "BPB8D", GOOGL: "GOGLD", PETR: "PETRD" }, NOD: Record<string, 1> = { TMVE8: 1, COCORMA: 1, ALLLF: 1 };
const dtk = (h: Any) => { if (h.k == "est" || h.k == "fci" || NOD[h.t]) return h.t; if (DTK[h.t]) return DTK[h.t]; if (h.k == "on" && /O$/.test(h.t)) return h.t.slice(0, -1) + "D"; return h.t + "D"; };
function portfolio(I: Any, M: Any) {
  const mep = (M.mep && (M.mep.compra || M.mep.venta)) || I.mep || 1700, items: Any[] = [];
  (I.pos || []).forEach((h: Any) => {
    let pu: number | null = null, c: number | null = null;
    const r = h.k == "est" || h.k == "fci" ? null : M.usd[dtk(h)];
    if (r) { pu = r[0]; c = r[1]; } else if (M.ars[h.t]) { pu = M.ars[h.t][0] / mep; c = M.ars[h.t][1]; }
    else if (h.pu != null) pu = h.pu; else if (h.p != null) pu = h.p / mep;
    const v = pu == null ? 0 : h.q * pu / (h.per || 1);
    items.push({ t: dtk(h), raw: h.t, k: h.k, v, c, live: !!r || !!M.ars[h.t], fci: h.k == "fci" || h.t == "COCORMA" });
  });
  const fx: Record<string, number> = { ars: 1, mep, cable: I.cable || mep };
  let cash = 0; (I.cash || []).forEach((c: Any) => cash += c.u * (fx[c.fx] || 1) / mep);
  const T = items.reduce((a, x) => a + x.v, 0) + cash;
  const D = items.reduce((a, x) => a + (x.c != null && x.live ? x.v - x.v / (1 + x.c / 100) : 0), 0);
  const lq = cash + items.filter((x) => x.fci).reduce((a, x) => a + x.v, 0);
  return { items, T, D, mep, lq };
}
function flows(I: Any, today: string, xomPx: number | null) {
  const o: Any[] = [];
  (I.cf || []).forEach((c: Any) => { const h = (I.pos || []).find((x: Any) => x.t == c.t); if (!h || c.d < today) return; const t = h.t; const x = (c.i ? h.q * c.i / 100 : 0) + (c.a ? h.q * c.a / 100 : 0); if (x) o.push({ t, d: c.d, x, ty: c.a ? "Renta + amortización" : "Renta" }); });
  (I.est || []).forEach((e: Any) => { const h = (I.pos || []).find((x: Any) => x.t == e.t); if (!h) return; (e.cp || []).forEach((c: Any) => { if (c[1] >= today) o.push({ t: e.t, d: c[1], x: h.q * e.rate / 100, ty: "Cupón condicional" }); }); if (e.mat >= today) o.push({ t: e.t, d: e.mat, x: h.q, ty: "Vencimiento de la nota" }); });
  const R = I.rsu; if (R && R.g) { const px = xomPx || R.px || 0, nt = 1 - (R.tax || 35) / 100; R.g.forEach((g: Any) => { if (g.vd >= today) o.push({ t: "XOM", d: g.vd, x: g.q * px * nt, ty: "Vesting RSU (neto)" }); }); }
  return o.sort((a, b) => a.d < b.d ? -1 : 1);
}

// ---------- crédito UVA ----------
const LOAN_DEF = { name: "Hipotecario BNA UVA", uva0: 59225.53, tna: 6, n: 360, fee: 4, feeY: 7, f0: "2026-10-21", first: "2026-12-10", rent: "Alquiler Depto PACHECO", costs: ["Credito Hipotecario NACION", "Seguros Banco Nación x Credito"] };
function loanState(L: Any, M: Any, today: string) {
  const past = M.uva.filter((x: Any) => x.fecha <= today), uh = past[past.length - 1]; if (!uh) return null;
  const r = L.tna / 1200, n = L.n, P = L.uva0, c = P * r / (1 - Math.pow(1 + r, -n));
  let k = 0; const d0 = new Date(L.first + "T12:00:00Z"); for (let i = 0; i < n; i++) { const d = new Date(d0); d.setUTCMonth(d0.getUTCMonth() + i); if (dISO(d) <= today) k++; else break; }
  const g = Math.pow(1 + r, k), bal = P * g - c * (g - 1) / r, feeOn = (L.fee || 0) > 0 && today < addY(L.f0, L.feeY || 0), payA = bal * uh.valor * (1 + (feeOn ? L.fee / 100 : 0));
  const um: Record<string, number> = {}; M.uva.forEach((x: Any) => um[x.fecha] = x.valor);
  const from = addY(today, -5), out: Any = { c, bal, uva: uh.valor, payA, feeOn, rates: {} };
  const cur: Record<string, number> = { MEP: M.mep && (M.mep.compra || M.mep.venta), Blue: M.blue && (M.blue.compra || M.blue.venta) };
  ([["MEP", M.bolsa], ["Blue", M.blueH]] as [string, Any[]][]).forEach(([nm, H]) => {
    if (!cur[nm] || !H.length) return; const v = H.filter((x: Any) => x.fecha >= from && um[x.fecha]).map((x: Any) => bal * um[x.fecha] / (x.compra || x.venta)).sort((a: number, b: number) => a - b);
    if (v.length < 50) return; const usdNow = payA / cur[nm], pctl = v.filter((q: number) => q <= usdNow).length / v.length * 100, q33 = v[Math.floor(v.length * .33)];
    out.rates[nm] = { usdNow, pctl, fx: payA / q33, px: cur[nm] };
  });
  return out;
}
const infl = (S: Any) => (S.infl != null ? S.infl : 2) / 100;
function rentAt(S: Any, C: Any, k: string) { if (k < C.start || (C.end && k > C.end)) return 0; const ev = C.every || 3; let b = C.amt, b0 = C.start; if (C.cur && C.curF && C.curF <= k && C.curF >= C.start) { b = C.cur; b0 = C.curF; } return b * Math.pow(1 + infl(S), ev * Math.floor(mDiff(b0, k) / ev)); }

// ---------- reglas ----------
type Alert = { key: string; cat: string; title: string; body: string; tag?: string; url?: string };
const DEF = { on: { mv: true, fx: true, uva: true, cob: true, rot: true, crd: true, res: true, tc: true }, mv: 5, pm: 2, fx: 2, conc: 20, liq: 10, priv: true };
function rules(S: Any, cfg: Any, M: Any, st: Any): Alert[] {
  const A: Alert[] = [], now = nowART(), today = dISO(now), hh = now.getUTCHours() + now.getUTCMinutes() / 60, wd = now.getUTCDay(), mkt = wd >= 1 && wd <= 5 && hh >= 11 && hh <= 17.2;
  const on = { ...DEF.on, ...(cfg.on || {}) }, priv = cfg.priv !== false, money = (n: number) => priv ? "" : " (US$ " + nf(Math.round(n)) + ")", ars = (n: number) => priv ? "" : " · $ " + nf(Math.round(n));
  const I = S.inv;
  // 1) subas / bajas abruptas
  if (I && on.mv && mkt && M.ok) {
    const P = portfolio(I, M), th = +cfg.mv || DEF.mv;
    P.items.forEach((x: Any) => { if (x.c == null || !x.live || x.v < 50) return; const lv = Math.floor(Math.abs(x.c) / th); if (lv < 1) return;
      A.push({ key: `mv:${x.t}:${today}:${x.c > 0 ? "u" : "d"}${lv}`, cat: "mv", title: `${x.c > 0 ? "▲" : "▼"} ${x.raw} ${pc(x.c)} hoy`, body: `${x.c > 0 ? "Suba" : "Baja"} fuerte en tu posición${money(x.v - x.v / (1 + x.c / 100))}. Revisá si querés tomar ganancia o promediar.`, tag: "mv-" + x.raw, url: "#cartera" }); });
    const dp = P.T ? P.D / (P.T - P.D) * 100 : 0, tp = +cfg.pm || DEF.pm, lv = Math.floor(Math.abs(dp) / tp);
    if (lv >= 1) A.push({ key: `pm:${today}:${dp > 0 ? "u" : "d"}${lv}`, cat: "mv", title: `Tu cartera ${pc(dp)} hoy`, body: `Movimiento fuerte del día${money(P.D)}.`, tag: "pm", url: "#cartera" });
    const x = M.us.XOM; if (x && x[1] != null && Math.abs(x[1]) >= th && I.rsu) A.push({ key: `xom:${today}:${x[1] > 0 ? "u" : "d"}`, cat: "mv", title: `XOM ${pc(x[1])} hoy`, body: `Tus RSU de ExxonMobil se movieron fuerte. Precio US$ ${nf(x[0], 2)}.`, tag: "xom", url: "#rsu" });
  }
  // 2) dólar
  if (on.fx && hh >= 10.5 && hh <= 19) {
    ([["MEP", M.mep, M.bolsa], ["Blue", M.blue, M.blueH]] as [string, Any, Any[]][]).forEach(([nm, c, H]) => {
      if (!c || !H.length) return; const prev = H.filter((x: Any) => x.fecha < today).pop(); if (!prev) return; const ch = (c.venta / prev.venta - 1) * 100, th = +cfg.fx || DEF.fx, lv = Math.floor(Math.abs(ch) / th);
      if (lv >= 1) A.push({ key: `fx:${nm}:${today}:${ch > 0 ? "u" : "d"}${lv}`, cat: "fx", title: `Dólar ${nm} ${pc(ch)} hoy`, body: `Cotiza $ ${nf(c.venta)} (ayer $ ${nf(prev.venta)}). ${ch > 0 ? "Puede ser momento de vender dólares si necesitás pesos." : "Dólar más barato: momento para comprar si tenés pesos de sobra."}`, tag: "fx-" + nm, url: "#dolar" });
    });
  }
  // 3) indicador de cancelación del crédito
  const L = { ...LOAN_DEF, ...(S.loan || {}) };
  if (on.uva && M.uva.length) {
    const ls = loanState(L, M, today);
    if (ls) Object.entries(ls.rates).forEach(([nm, r]: [string, Any]) => {
      const lvl = r.pctl <= 33 ? "fav" : r.pctl >= 67 ? "desf" : "neu", prev = st.loan && st.loan[nm]; st.loan = st.loan || {}; st.loan[nm] = lvl;
      if (prev && prev != lvl && (lvl == "fav" || prev == "fav")) A.push({ key: `uva:${nm}:${today}:${lvl}`, cat: "uva", tag: "uva-" + nm, url: "#credito",
        title: lvl == "fav" ? `Conviene cancelar el crédito con ${nm}` : `Dejó de convenir cancelar con ${nm}`,
        body: lvl == "fav" ? `Cancelar hoy cuesta US$ ${nf(Math.round(r.usdNow))}${ls.feeOn ? " con la comisión" : ""}, dentro del tercio más barato de los últimos 5 años.` : `El indicador pasó a ${lvl == "neu" ? "neutro" : "desfavorable"}: cancelar cuesta US$ ${nf(Math.round(r.usdNow))}.` });
      if (!prev && lvl == "fav") A.push({ key: `uva:${nm}:${today}:fav0`, cat: "uva", tag: "uva-" + nm, url: "#credito", title: `Conviene cancelar el crédito con ${nm}`, body: `Cancelar hoy cuesta US$ ${nf(Math.round(r.usdNow))}, dentro del tercio más barato de los últimos 5 años.` });
    });
  }
  // 4) resumen diario de decisiones (una vez por día, desde las 18 h)
  if (hh >= 18 && st.daily != today) {
    st.daily = today;
    const wk = today.slice(0, 4) + "-w" + Math.floor((Date.parse(today) - Date.parse(today.slice(0, 4) + "-01-01")) / 6048e5);
    if (I && on.cob) flows(I, addDays(today, 1), M.us.XOM ? M.us.XOM[0] : null).filter((f) => f.d <= addDays(today, f.t == "XOM" ? 7 : 3)).forEach((f) =>
      A.push({ key: `cob:${f.t}:${f.d}`, cat: "cob", title: `El ${fd(f.d)} cobrás ${f.t}`, body: `${f.ty}${money(f.x)}. Decidí si lo reinvertís o lo dejás en liquidez.`, tag: "cob-" + f.t, url: "#cobros" }));
    if (I && on.rot && M.ok) {
      const P = portfolio(I, M), conc = +cfg.conc || DEF.conc, liq = +cfg.liq || DEF.liq;
      P.items.filter((x: Any) => P.T && x.v / P.T * 100 >= conc).forEach((x: Any) => A.push({ key: `conc:${x.raw}:${wk}`, cat: "rot", title: `${x.raw} pesa ${nf(x.v / P.T * 100, 1)}% de tu cartera`, body: `Supera tu límite de ${conc}%. Considerá rebalancear hacia otros activos.`, tag: "conc-" + x.raw, url: "#analisis" }));
      if (P.T && P.lq / P.T * 100 >= liq) A.push({ key: `liq:${wk}`, cat: "rot", title: `Tenés ${nf(P.lq / P.T * 100, 1)}% en liquidez`, body: `Más que tu límite de ${liq}%${money(P.lq)}. Evaluá invertir una parte.`, tag: "liq", url: "#cartera" });
    }
    if (on.crd) {
      const r = L.tna / 1200, c = L.uva0 * r / (1 - Math.pow(1 + r, -L.n)), past = M.uva.filter((x: Any) => x.fecha <= today).pop();
      const d0 = new Date(L.first + "T12:00:00Z"); for (let i = 0; i < L.n; i++) { const d = new Date(d0); d.setUTCMonth(d0.getUTCMonth() + i); const s = dISO(d); if (s < addDays(today, 1)) continue; if (s <= addDays(today, 3) && past) A.push({ key: `cuota:${s}`, cat: "crd", title: `El ${fd(s)} debitan la cuota del hipotecario`, body: `${nf(c, 2)} UVA${ars(c * past.valor)}. Asegurate de tener saldo en la cuenta.`, tag: "cuota", url: "#credito" }); break; }
      const nk = today.slice(0, 7), nx = mAdd(nk, 1);
      (S.rents || []).forEach((C: Any) => {
        if (C.end && mDiff(nk, C.end) == 2 && today.slice(8) >= "01") A.push({ key: `rfin:${C.name}:${C.end}`, cat: "crd", title: `Vence el contrato de ${C.name}`, body: `Termina en ${C.end.slice(5)}/${C.end.slice(0, 4)}. Es momento de renegociar o buscar inquilino.`, tag: "rent", url: "#alquiler" });
        if (C.start < nx && (!C.end || nx <= C.end) && mDiff(C.start, nx) % (C.every || 3) == 0 && +today.slice(8) >= 25) A.push({ key: `radj:${C.name}:${nx}`, cat: "crd", title: `Ajusta el alquiler de ${C.name}`, body: `Desde ${nx.slice(5)}/${nx.slice(0, 4)} corresponde el ajuste${ars(rentAt(S, C, nx))} estimado. Avisale al inquilino.`, tag: "rent", url: "#alquiler" });
      });
    }
  }

  // 7) resumen del mes: el día 1 (o hasta el 3 si no se pudo antes), desde las 9
  if (on.res && ((+today.slice(8, 10) <= 3 && hh >= 9) || st.forceRes)) {
    const MESL = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
    const cur = today.slice(0, 7), pk = mAdd(cur, -1), ms = S.msum && S.msum[pk], parts: string[] = [];
    const $ = (n: number) => "$ " + nf(Math.round(n));
    if (ms && ms.i) {
      if (!ms.pend) { const r = ms.real / ms.i * 100, d = ms.est ? (ms.real - ms.est) / Math.abs(ms.est) * 100 : 0;
        parts.push(`Ahorraste el ${nf(r, 0)}% de tus ingresos` + (priv ? "" : ` (${$(ms.real)})`) + (Math.abs(d) >= 3 ? `, ${nf(Math.abs(d), 0)}% ${d > 0 ? "más" : "menos"} de lo estimado` : ", lo que habías estimado"));
      } else parts.push(`Te quedaron ${ms.pend} concepto${ms.pend > 1 ? "s" : ""} sin confirmar` + (priv ? "" : `; estimado de ahorro ${$(ms.est)}`));
      if (ms.aD) parts.push(`Invertiste ${priv ? "en " + MESL[+pk.slice(5, 7) - 1] : $(ms.aD)}` + (ms.mep && !priv ? ` (≈ US$ ${nf(Math.round(ms.aD / ms.mep))})` : ""));
    }
    const H = S.nwh || {}, ks = Object.keys(H).sort(), at = (lim: string) => { const k = ks.filter((x) => x <= lim).pop(); return k ? H[k][0] : null; };
    const e1 = at(pk + "-31"), e0 = at(mAdd(pk, -1) + "-31");
    if (e1 != null && e0) { const ch = (e1 - e0) / Math.abs(e0) * 100; parts.push(`Patrimonio ${pc(ch)} en el mes` + (priv ? "" : ` (US$ ${nf(Math.round(e1))})`)); }
    if (I) { const F = flows(I, cur + "-01", M.us.XOM ? M.us.XOM[0] : null).filter((f) => f.d.slice(0, 7) == cur), tot = F.reduce((a, f) => a + f.x, 0);
      if (F.length) parts.push(`En ${MESL[+cur.slice(5, 7) - 1]} cobrás ${F.length} pago${F.length > 1 ? "s" : ""}` + (priv ? "" : ` por US$ ${nf(Math.round(tot))}`)); }
    if (parts.length) A.push({ key: `res:${pk}`, cat: "res", title: `Cómo cerró ${MESL[+pk.slice(5, 7) - 1]}`, body: parts.join(" · ") + ".", tag: "res-" + pk, url: "#gastos" });
  }
  // 8) vencimiento de tarjetas: 3 días antes, el día anterior y el mismo día, desde las 9
  if (on.tc && S.tc && hh >= 9) {
    (S.tc.cards || []).forEach((C: Any) => {
      const L = (S.tc.res && S.tc.res[C.id]) || [], R = L[L.length - 1]; if (!R || !R.vto || R.vto < today) return;
      const dd = Math.round((Date.parse(R.vto) - Date.parse(today)) / 864e5); if (dd > 3) return;
      const yr = S.y && S.y[R.vto.slice(0, 4)], row = yr && yr.find((x: Any) => x.n == C.row), mi = +R.vto.slice(5, 7) - 1;
      if (row && row.p && row.p[mi]) return; // ya lo marcaste pagado en Gastos
      const step = dd >= 2 ? "3" : String(dd), pay = R.ars - (C.usdUsd === false ? 0 : (R.perc || 0));
      const amt = priv ? "" : ` $ ${nf(Math.round(pay))}${R.usd ? ` + US$ ${nf(R.usd, 2)}` : ""}`;
      A.push({ key: `tc:${C.id}:${R.vto}:${step}`, cat: "tc", title: dd == 0 ? `Hoy vence la tarjeta ${C.n}` : dd == 1 ? `Mañana vence la tarjeta ${C.n}` : `La tarjeta ${C.n} vence el ${fd(R.vto)}`,
        body: `Pagá el resumen${amt}.${R.min && !priv ? " Mínimo $ " + nf(Math.round(R.min)) + "." : ""} Marcalo pagado en Gastos y no te aviso más.`, tag: "tc-" + C.id, url: "#tarjetas" });
    });
  }
  return A;
}

// ---------- noticias (Google Noticias en español, por tenencia) ----------
const ent = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();
async function news(Q: Any[]) {
  const qs = (Array.isArray(Q) ? Q : []).filter((x) => x && x.q && x.t).slice(0, 16);
  const one = async (x: Any) => {
    const u = `https://news.google.com/rss/search?q=${encodeURIComponent(x.q + " when:3d")}&hl=es-419&gl=AR&ceid=AR:es-419`;
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 8000);
    try {
      const xml = await (await fetch(u, { signal: ac.signal, headers: { "user-agent": "Mozilla/5.0 finanzas-gonzo" } })).text();
      return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5).map((m) => {
        const g = (tag: string) => { const r = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">").exec(m[1]); return r ? ent(r[1]) : ""; };
        const src = g("source"), title = g("title").replace(new RegExp("\\s+-\\s+" + src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"), "");
        return { t: x.t, title, link: g("link"), date: g("pubDate"), source: src };
      });
    } catch (_) { return []; } finally { clearTimeout(tm); }
  };
  const all = (await Promise.all(qs.map(one))).flat(), seen = new Set<string>();
  return all.filter((n) => { const k = n.title.toLowerCase().slice(0, 70); if (!n.title || seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 60);
}

// ---------- envío ----------
async function sendTo(uid: string, push: Any, list: Alert[], keys: Any) {
  webpush.setVapidDetails("mailto:alertas@mis-finanzas.app", keys.publicKey, keys.privateKey);
  let subs = push.subs || [], dead = 0;
  const msgs = list.length > 4 ? [{ title: `${list.length} avisos de Finanzas Gonzo`, body: list.map((a) => a.title).join(" · "), tag: "resumen", url: "#" }] : list;
  for (const m of msgs) for (const s of subs) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify({ title: m.title, body: m.body, tag: m.tag, url: m.url }), { TTL: 6 * 3600, urgency: "high" }); }
    catch (e: Any) { if (e && (e.statusCode == 404 || e.statusCode == 410)) { s.dead = 1; dead++; } }
  }
  if (dead) { subs = subs.filter((s: Any) => !s.dead); await SB.from("docs").update({ data: { ...push, subs }, updated_at: new Date().toISOString() }).eq("user_id", uid).eq("id", "push"); }
  // historial dentro de la app
  const { data: ad } = await SB.from("docs").select("data").eq("user_id", uid).eq("id", "alerts").maybeSingle();
  const items = [...list.map((a) => ({ ts: Date.now(), cat: a.cat, t: a.title, b: a.body, url: a.url })), ...((ad && ad.data && ad.data.items) || [])].slice(0, 60);
  await SB.from("docs").upsert({ user_id: uid, id: "alerts", data: { items, u: Date.now() }, updated_at: new Date().toISOString() }, { onConflict: "user_id,id" });
}

async function runAll(dry = false) {
  const keys = await vapid(), M = await market(), out: Any[] = [];
  const { data: rows } = await SB.from("docs").select("user_id,data").eq("id", "push");
  for (const row of rows || []) {
    const push = row.data || {}, cfg = { ...DEF, ...(push.cfg || {}) }; if (cfg.off) continue;
    const { data: led } = await SB.from("docs").select("data").eq("user_id", row.user_id).eq("id", "ledger").maybeSingle(); if (!led) continue;
    const sid = "u:" + row.user_id, st = (await getState(sid)) || { sent: {} }; st.sent = st.sent || {};
    const fresh = rules(led.data, cfg, M, st).filter((a) => !st.sent[a.key]);
    const cut = Date.now() - 40 * 864e5; for (const k of Object.keys(st.sent)) if (st.sent[k] < cut) delete st.sent[k];
    fresh.forEach((a) => st.sent[a.key] = Date.now());
    if (fresh.length && !dry && (push.subs || []).length) await sendTo(row.user_id, push, fresh, keys);
    await setState(sid, st); out.push({ n: fresh.length, t: fresh.map((a) => a.title) });
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method == "OPTIONS") return new Response("ok", { headers: CORS });
  let body: Any = {}; try { body = await req.json(); } catch (_) { /* vacío */ }
  const op = body.op || new URL(req.url).searchParams.get("op") || "run";
  try {
    if (op == "key") return json({ key: (await vapid()).publicKey });
    // resumen de tarjeta enviado desde el menú Compartir del iPhone (Atajo con clave personal)
    if (op == "tcin") {
      const k = String(body.k || "").trim(); if (k.length < 20) return json({ error: "Falta la clave del atajo." }, 401);
      const h = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(k)))).map((b) => b.toString(16).padStart(2, "0")).join("");
      const { data: kr } = await SB.from("docs").select("user_id").eq("id", "tckey").eq("data->>h", h).maybeSingle();
      if (!kr) return json({ error: "Clave inválida: generá una nueva en la app." }, 401);
      const b64 = String(body.f || "").replace(/[^A-Za-z0-9+/=]/g, ""); if (b64.length < 100) return json({ error: "No llegó el PDF." }, 400);
      if (b64.length > 14e6) return json({ error: "El PDF es demasiado grande." }, 413);
      if (!atob(b64.slice(0, 8)).startsWith("%PDF")) return json({ error: "El archivo no es un PDF." }, 400);
      const { count } = await SB.from("docs").select("id", { count: "exact", head: true }).eq("user_id", kr.user_id).like("id", "tcin:%");
      if ((count || 0) >= 20) return json({ error: "Hay 20 resúmenes sin cargar en la app. Cargalos antes de mandar más." }, 429);
      const id = "tcin:" + Date.now(), nm = String(body.n || "resumen.pdf").slice(0, 120);
      await SB.from("docs").insert({ user_id: kr.user_id, id, data: { at: Date.now(), n: nm, f: b64 }, updated_at: new Date().toISOString() });
      const { data: p } = await SB.from("docs").select("data").eq("user_id", kr.user_id).eq("id", "push").maybeSingle();
      if (p && (p.data.subs || []).length) { try { await sendTo(kr.user_id, p.data, [{ key: id, cat: "tc", title: "Llegó un resumen de tarjeta", body: "Tocá para revisarlo y cargarlo en Gastos.", tag: "tcin", url: "#tarjetas~in" }], await vapid()); } catch (_) { /* sin aviso */ } }
      return json({ ok: true, msg: "Resumen enviado. Abrí Finanzas Gonzo para cargarlo." });
    }
    if (op == "test" || op == "preview" || op == "res" || op == "news") {
      const tok = (req.headers.get("authorization") || "").replace(/^Bearer /i, ""); const { data: u } = await SB.auth.getUser(tok);
      if (!u || !u.user) return json({ error: "Iniciá sesión en la app." }, 401);
      if (op == "news") return json({ items: await news(body.q || []) });
      const { data: p } = await SB.from("docs").select("data").eq("user_id", u.user.id).eq("id", "push").maybeSingle();
      if (op == "preview") { const { data: led } = await SB.from("docs").select("data").eq("user_id", u.user.id).eq("id", "ledger").maybeSingle(); const M = await market(); const cfg = { ...DEF, ...((p && p.data && p.data.cfg) || {}) }; const st = (await getState("u:" + u.user.id)) || { sent: {} }; const L = { ...LOAN_DEF, ...((led && led.data && led.data.loan) || {}) }; return json({ ok: M.ok, alerts: led ? rules(led.data, cfg, M, { ...st, daily: null }) : [], loan: loanState(L, M, dISO(nowART())) }); }
      if (!p || !(p.data.subs || []).length) return json({ error: "Este usuario no tiene dispositivos suscriptos." }, 400);
      if (op == "res") { const { data: led } = await SB.from("docs").select("data").eq("user_id", u.user.id).eq("id", "ledger").maybeSingle(); if (!led) return json({ error: "No encontré tus datos." }, 404);
        const M = await market(), cfg = { ...DEF, ...(p.data.cfg || {}) }, R = rules(led.data, { ...cfg, on: { res: true } }, M, { sent: {}, forceRes: 1 }).filter((a) => a.cat == "res");
        if (!R.length) return json({ sent: 0, error: "Todavía no hay un mes cerrado para resumir. Abrí la app una vez para que lo calcule." });
        await sendTo(u.user.id, p.data, R, await vapid()); return json({ sent: 1, mes: R[0].title.replace("Cómo cerró ", "") }); }
      await sendTo(u.user.id, p.data, [{ key: "test", cat: "test", title: "Notificaciones activadas", body: "Finanzas Gonzo te va a avisar de movimientos fuertes, el crédito UVA y decisiones pendientes.", tag: "test", url: "#" }], await vapid());
      return json({ ok: true, devices: p.data.subs.length });
    }
    return json({ ok: true, users: await runAll(!!body.dry) });
  } catch (e) { return json({ error: String((e as Error).message || e) }, 500); }
});
