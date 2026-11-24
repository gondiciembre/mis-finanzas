// Finanzas Gonzo · cotizaciones en tiempo real de IOL (Supabase Edge Function "iol")
// Tus credenciales de IOL NO van en el código: cargalas como secretos de Supabase (IOL_USER, IOL_PASS).
// La función solo responde a usuarios con sesión iniciada en la app.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const IOL = "https://api.iolinversiones.com";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
type Any = any;

let mem: { tok: string | null; exp: number } = { tok: null, exp: 0 };
async function getState(): Promise<Any> { const { data } = await SB.from("push_state").select("data").eq("id", "iol").maybeSingle(); return data ? data.data : {}; }
async function setState(d: Any) { await SB.from("push_state").upsert({ id: "iol", data: d, updated_at: new Date().toISOString() }); }

async function grant(body: Any) {
  const r = await fetch(IOL + "/auth/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.data || !j.data.access_token) throw new Error("IOL rechazó el ingreso (" + r.status + "). Revisá IOL_USER / IOL_PASS.");
  return j.data;
}
async function token(force = false): Promise<string> {
  if (!force && mem.tok && Date.now() < mem.exp - 60e3) return mem.tok;
  const st = await getState();
  let d: Any = null;
  if (st.refresh && Date.now() < (st.rexp || 0)) { try { d = await grant({ grant_type: "refresh_token", refresh_token: st.refresh }); } catch (_) { d = null; } }
  if (!d) {
    const u = Deno.env.get("IOL_USER"), p = Deno.env.get("IOL_PASS");
    if (!u || !p) throw new Error("Faltan los secretos IOL_USER e IOL_PASS en Supabase.");
    d = await grant({ grant_type: "password", username: u, password: p });
  }
  mem = { tok: d.access_token, exp: Date.now() + (d.expires_in || 900) * 1000 };
  if (d.refresh_token) await setState({ refresh: d.refresh_token, rexp: Date.now() + 29 * 864e5 });
  return mem.tok!;
}
const num = (v: Any) => (typeof v == "number" ? v : v != null && !isNaN(+v) ? +v : null);
async function quote(sym: string, market: string, term: string, tok: string) {
  const r = await fetch(`${IOL}/broker/market-data/${encodeURIComponent(sym)}/quote?market=${market}&term=${term}`, { headers: { Authorization: "Bearer " + tok } });
  if (r.status == 401) throw Object.assign(new Error("401"), { auth: true });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null); const d = j && j.data; if (!d) return null;
  const P = d.prices || {}, C = d.change || {}, V = d.volume || {}, B = d.book || d.orderBook || d.puntas || {};
  return { c: num(P.current ?? P.last ?? d.price), ch: num(C.percent ?? C.pct), prev: num(P.previousClose ?? P.close ?? P.previous), vol: num(V.amount ?? V.shares ?? V.nominal),
    bid: num(B.bid ?? B.bidPrice ?? (B.bids && B.bids[0] && B.bids[0].price)), ask: num(B.ask ?? B.offer ?? B.askPrice ?? (B.asks && B.asks[0] && B.asks[0].price)), at: d.timestamp || d.updatedAt || null };
}

Deno.serve(async (req) => {
  if (req.method == "OPTIONS") return new Response("ok", { headers: CORS });
  const auth = (req.headers.get("authorization") || "").replace(/^Bearer /i, "");
  const { data: u } = await SB.auth.getUser(auth);
  if (!u || !u.user) return json({ error: "Iniciá sesión en la app." }, 401);
  let body: Any = {}; try { body = await req.json(); } catch (_) { /* vacío */ }
  try {
    if (body.op == "check") { await token(true); return json({ ok: true }); }
    if (body.op == "raw") { const tok = await token(); const r = await fetch(`${IOL}/broker/market-data/${encodeURIComponent(body.symbol)}/quote?market=${body.market || "BCBA"}&term=${body.term || "T1"}`, { headers: { Authorization: "Bearer " + tok } }); return json({ status: r.status, body: await r.json().catch(() => null) }); }
    if (body.op == "quotes") {
      const list: string[] = (body.symbols || []).slice(0, 120);
      let tok = await token(); const out: Record<string, Any> = {};
      const run = async (s: string) => {
        const [sym, market = "BCBA", term = "T1"] = s.split("|");
        try { let q = await quote(sym, market, term, tok); if (!q || q.c == null) q = term == "T1" ? await quote(sym, market, "T0", tok) : q; if (q && q.c != null) out[sym] = q; }
        catch (e: Any) { if (e.auth) { tok = await token(true); const q = await quote(sym, market, term, tok); if (q && q.c != null) out[sym] = q; } }
      };
      for (let i = 0; i < list.length; i += 10) await Promise.all(list.slice(i, i + 10).map(run));
      return json({ ok: true, ts: Date.now(), quotes: out, n: Object.keys(out).length });
    }
    return json({ error: "op desconocida" }, 400);
  } catch (e) { return json({ error: String((e as Error).message || e) }, 500); }
});
