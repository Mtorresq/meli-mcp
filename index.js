import express from "express";
import https from "https";
import pg from "pg";

const { Pool } = pg;

const CONFIG = {
  CLIENT_ID:     process.env.MELI_CLIENT_ID     || "919130041209199",
  CLIENT_SECRET: process.env.MELI_CLIENT_SECRET || "Iwx1fpyznVQRS9qS1xrnMCxNxNFIc1Bj",
  USER_ID:       process.env.MELI_USER_ID       || "2934266490",
  REDIRECT_URI:  "https://www.google.com",
  ACCESS_TOKEN:  process.env.MELI_ACCESS_TOKEN  || "",
  REFRESH_TOKEN: process.env.MELI_REFRESH_TOKEN || "",
};

const RESEND_KEY = process.env.RESEND_API_KEY || "re_QnPyNvCN_AREJWxEMFmmM3ey9b3DMbLui";
const EMAIL_TO   = process.env.EMAIL_TO        || "miguel.torres@gmail.com";
const DATABASE_URL = process.env.DATABASE_URL;

// ── BASE DE DATOS ──
let pool;
async function initDB() {
  if (!DATABASE_URL) { console.log("Sin DATABASE_URL, usando solo memoria"); return; }
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log("✅ Base de datos conectada");

  // Cargar tokens guardados
  const res = await pool.query("SELECT key, value FROM tokens WHERE key IN ('access_token','refresh_token')");
  res.rows.forEach(row => {
    if (row.key === "access_token")  CONFIG.ACCESS_TOKEN  = row.value;
    if (row.key === "refresh_token") CONFIG.REFRESH_TOKEN = row.value;
  });
  if (CONFIG.ACCESS_TOKEN) console.log("✅ Tokens cargados desde la base de datos");
}

async function saveTokens(accessToken, refreshToken) {
  CONFIG.ACCESS_TOKEN  = accessToken;
  if (refreshToken) CONFIG.REFRESH_TOKEN = refreshToken;
  if (!pool) return;
  await pool.query(`
    INSERT INTO tokens (key, value, updated_at) VALUES ('access_token', $1, NOW())
    ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
  `, [accessToken]);
  if (refreshToken) {
    await pool.query(`
      INSERT INTO tokens (key, value, updated_at) VALUES ('refresh_token', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    `, [refreshToken]);
  }
  console.log("Tokens guardados en DB:", new Date().toLocaleString());
}

// ── API HELPERS ──
function apiRequest(path, token) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: "api.mercadolibre.com", path,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

function postMeli(body) {
  return new Promise((resolve, reject) => {
    const bodyStr = new URLSearchParams(body).toString();
    const req = https.request({
      hostname: "api.mercadolibre.com", path: "/oauth/token", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(bodyStr) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

async function refreshToken() {
  if (!CONFIG.REFRESH_TOKEN) throw new Error("No hay refresh token");
  const data = await postMeli({
    grant_type: "refresh_token",
    client_id: CONFIG.CLIENT_ID,
    client_secret: CONFIG.CLIENT_SECRET,
    refresh_token: CONFIG.REFRESH_TOKEN,
  });
  if (data.access_token) {
    await saveTokens(data.access_token, data.refresh_token);
    console.log("Token renovado:", new Date().toLocaleString());
  } else throw new Error("No se pudo renovar: " + JSON.stringify(data));
}

async function meliGet(path) {
  if (!CONFIG.ACCESS_TOKEN) throw new Error("Sin token. Usá conectar_cuenta primero.");
  const data = await apiRequest(path, CONFIG.ACCESS_TOKEN);
  if (data.error === "unauthorized") {
    await refreshToken();
    return apiRequest(path, CONFIG.ACCESS_TOKEN);
  }
  return data;
}

// Auto-renovar cada 5 horas
setInterval(async () => {
  if (CONFIG.REFRESH_TOKEN) try { await refreshToken(); } catch (e) { console.error("Error renovando:", e.message); }
}, 5 * 60 * 60 * 1000);

// ── EMAIL ──
function sendEmail(subject, html) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      from: "Noor Kids Dashboard <onboarding@resend.dev>",
      to: [EMAIL_TO], subject, html,
    });
    const req = https.request({
      hostname: "api.resend.com", path: "/emails", method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { console.log("Email:", data); resolve(data); });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function enviarResumenSemanal() {
  console.log("Generando resumen semanal...");
  const [ord, pub, preg, me] = await Promise.all([
    meliGet(`/orders/search?seller=${CONFIG.USER_ID}&sort=date_desc&limit=50`),
    meliGet(`/users/${CONFIG.USER_ID}/items/search?limit=50`),
    meliGet(`/questions/search?seller_id=${CONFIG.USER_ID}&limit=50`),
    meliGet(`/users/${CONFIG.USER_ID}`)
  ]);
  const orders = ord.results || [];
  const pagas = orders.filter(o => o.status === "paid");
  const ingresos = pagas.reduce((s, o) => s + (o.total_amount || 0), 0);
  const sinR = (preg.questions || []).filter(q => q.status === "UNANSWERED").length;
  const conteo = {};
  orders.forEach(o => { const t = o.order_items?.[0]?.item?.title || "?"; conteo[t] = (conteo[t]||0)+1; });
  const top = Object.entries(conteo).sort((a,b)=>b[1]-a[1]).slice(0,3);
  const fecha = new Date().toLocaleDateString("es-AR", { weekday:"long", year:"numeric", month:"long", day:"numeric" });

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0a0f;color:#f0f0f8;padding:24px;border-radius:12px">
    <h1 style="color:#FFE600;font-size:24px;margin-bottom:4px">📊 Resumen Semanal</h1>
    <p style="color:#6b6b88;margin-top:0">Noor Kids · ${fecha}</p>
    <hr style="border-color:#2a2a3a;margin:20px 0">
    <div style="background:#111118;border:1px solid #2a2a3a;border-radius:8px;padding:16px;margin-bottom:12px">
      <div style="color:#6b6b88;font-size:11px;text-transform:uppercase;letter-spacing:2px">Ingresos totales</div>
      <div style="color:#FFE600;font-size:32px;font-weight:bold">$${ingresos.toLocaleString("es-AR")} ARS</div>
      <div style="color:#6b6b88;font-size:13px">${pagas.length} órdenes pagas de ${orders.length} totales</div>
    </div>
    <div style="display:flex;gap:12px;margin-bottom:12px">
      <div style="flex:1;background:#111118;border:1px solid #2a2a3a;border-radius:8px;padding:16px;text-align:center">
        <div style="color:#6b6b88;font-size:11px;text-transform:uppercase">Publicaciones</div>
        <div style="color:#f0f0f8;font-size:28px;font-weight:bold">${pub.results?.length||0}</div>
      </div>
      <div style="flex:1;background:#111118;border:1px solid ${sinR>0?"#ff4f6d":"#2a2a3a"};border-radius:8px;padding:16px;text-align:center">
        <div style="color:#6b6b88;font-size:11px;text-transform:uppercase">Sin responder</div>
        <div style="color:${sinR>0?"#ff4f6d":"#00C9A7"};font-size:28px;font-weight:bold">${sinR}</div>
      </div>
      <div style="flex:1;background:#111118;border:1px solid #2a2a3a;border-radius:8px;padding:16px;text-align:center">
        <div style="color:#6b6b88;font-size:11px;text-transform:uppercase">Reputación</div>
        <div style="color:#00C9A7;font-size:14px;font-weight:bold;margin-top:8px">${me.seller_reputation?.level_id||"—"}</div>
      </div>
    </div>
    <div style="background:#111118;border:1px solid #2a2a3a;border-radius:8px;padding:16px">
      <div style="color:#6b6b88;font-size:11px;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px">🏆 Top Productos</div>
      ${top.map(([t,c],i) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #2a2a3a">
          <span style="color:#f0f0f8;font-size:13px">${i+1}. ${t.slice(0,42)}</span>
          <span style="color:#FFE600;font-weight:bold">${c} ventas</span>
        </div>`).join("")}
    </div>
    <p style="color:#6b6b88;font-size:11px;text-align:center;margin-top:20px">Generado automáticamente · Noor Kids Dashboard</p>
  </div>`;

  await sendEmail("📊 Resumen Semanal — Noor Kids", html);
  console.log("Resumen enviado a", EMAIL_TO);
}

// Cron: lunes 8am Argentina (11:00 UTC)
function startCron() {
  const ahora = new Date();
  const diasHastaLunes = ((1 - ahora.getUTCDay()) + 7) % 7 || 7;
  const proximoLunes = new Date(ahora);
  proximoLunes.setUTCDate(ahora.getUTCDate() + diasHastaLunes);
  proximoLunes.setUTCHours(11, 0, 0, 0);
  const msHasta = proximoLunes - ahora;
  console.log(`Próximo resumen: ${proximoLunes.toUTCString()} (en ${Math.round(msHasta/3600000)}hs)`);
  setTimeout(() => {
    enviarResumenSemanal();
    setInterval(enviarResumenSemanal, 7 * 24 * 60 * 60 * 1000);
  }, msHasta);
}

// ── TOOLS ──
const TOOLS = [
  { name: "conectar_cuenta", description: "Conecta tu cuenta de Mercado Libre con un código de autorización TG-XXXXXXX", inputSchema: { type: "object", properties: { codigo: { type: "string" } }, required: ["codigo"] } },
  { name: "resumen_negocio", description: "Resumen completo: ventas, ingresos, top productos y preguntas pendientes", inputSchema: { type: "object", properties: {} } },
  { name: "ver_ventas", description: "Últimas ventas y órdenes de Mercado Libre", inputSchema: { type: "object", properties: { limite: { type: "number" } } } },
  { name: "ver_publicaciones", description: "Publicaciones activas con precio, stock y unidades vendidas", inputSchema: { type: "object", properties: {} } },
  { name: "ver_preguntas", description: "Preguntas de compradores, con filtro de sin responder", inputSchema: { type: "object", properties: { solo_sin_responder: { type: "boolean" } } } },
  { name: "ver_reputacion", description: "Reputación como vendedor y métricas de calidad", inputSchema: { type: "object", properties: {} } },
  { name: "ver_visitas", description: "Visitas por publicación: cuáles tienen más tráfico, total de visitas y ranking", inputSchema: { type: "object", properties: {} } },
  { name: "ver_conversion", description: "Tasa de conversión por publicación: visitas vs ventas, cuáles convierten bien y cuáles no", inputSchema: { type: "object", properties: {} } },
  { name: "enviar_resumen", description: "Envía el resumen semanal al email ahora mismo (para probar)", inputSchema: { type: "object", properties: {} } },
];

async function executeTool(name, args) {
  if (name === "conectar_cuenta") {
    const data = await postMeli({ grant_type: "authorization_code", client_id: CONFIG.CLIENT_ID, client_secret: CONFIG.CLIENT_SECRET, code: args.codigo, redirect_uri: CONFIG.REDIRECT_URI });
    if (data.access_token) {
      await saveTokens(data.access_token, data.refresh_token);
      return "✅ ¡Cuenta conectada! Token guardado en base de datos y se renueva automáticamente.";
    }
    return `❌ Error: ${data.message || JSON.stringify(data)}`;
  }

  if (name === "resumen_negocio") {
    const [ord, pub, preg, me] = await Promise.all([meliGet(`/orders/search?seller=${CONFIG.USER_ID}&sort=date_desc&limit=50`), meliGet(`/users/${CONFIG.USER_ID}/items/search?limit=50`), meliGet(`/questions/search?seller_id=${CONFIG.USER_ID}&limit=50`), meliGet(`/users/${CONFIG.USER_ID}`)]);
    const orders = ord.results || [];
    const pagas = orders.filter(o => o.status === "paid");
    const ingresos = pagas.reduce((s, o) => s + (o.total_amount || 0), 0);
    const sinR = (preg.questions || []).filter(q => q.status === "UNANSWERED").length;
    const conteo = {};
    orders.forEach(o => { const t = o.order_items?.[0]?.item?.title || "?"; conteo[t] = (conteo[t]||0)+1; });
    const top = Object.entries(conteo).sort((a,b)=>b[1]-a[1]).slice(0,3);
    let txt = `📊 RESUMEN NOOR KIDS\n${"═".repeat(28)}\n\n💰 Ingresos: $${ingresos.toLocaleString("es-AR")} ARS\n📦 Órdenes pagas: ${pagas.length}/${orders.length}\n🏷️ Publicaciones: ${pub.results?.length||0}\n💬 Sin responder: ${sinR}\n⭐ Reputación: ${me.seller_reputation?.level_id||"—"}\n\n🏆 Top productos:\n`;
    top.forEach(([t,c],i) => txt += `  ${i+1}. ${t.slice(0,45)} (${c} ventas)\n`);
    return txt;
  }

  if (name === "ver_ventas") {
    const lim = Math.min(args?.limite||20, 50);
    const data = await meliGet(`/orders/search?seller=${CONFIG.USER_ID}&sort=date_desc&limit=${lim}`);
    const orders = data.results || [];
    const ingresos = orders.filter(o=>o.status==="paid").reduce((s,o)=>s+(o.total_amount||0),0);
    let txt = `📦 ÚLTIMAS ${orders.length} ÓRDENES\n💰 Ingresos: $${ingresos.toLocaleString("es-AR")}\n\n`;
    orders.forEach(o => { const f = new Date(o.date_created).toLocaleDateString("es-AR"); const art = (o.order_items?.[0]?.item?.title||"—").slice(0,45); const e = o.status==="paid"?"✅":o.status==="cancelled"?"❌":"⏳"; txt += `${e} ${f} — ${art}\n   ${o.buyer?.nickname||"—"} | $${(o.total_amount||0).toLocaleString("es-AR")}\n\n`; });
    return txt;
  }

  if (name === "ver_publicaciones") {
    const search = await meliGet(`/users/${CONFIG.USER_ID}/items/search?limit=50`);
    const ids = search.results || [];
    const items = [];
    if (ids.length) { const res = await meliGet(`/items?ids=${ids.slice(0,20).join(",")}`); (res||[]).forEach(r => r.body && items.push(r.body)); }
    const vendidas = items.reduce((s,i)=>s+(i.sold_quantity||0),0);
    let txt = `🏷️ PUBLICACIONES (${ids.length} total) | Vendidas: ${vendidas}\n\n`;
    items.forEach(i => { const e = i.status==="active"?"✅":i.status==="paused"?"⏸️":"❌"; txt += `${e} ${i.title||"—"}\n   $${(i.price||0).toLocaleString("es-AR")} | Stock: ${i.available_quantity??"-"} | Vendidas: ${i.sold_quantity||0}\n\n`; });
    return txt;
  }

  if (name === "ver_preguntas") {
    const data = await meliGet(`/questions/search?seller_id=${CONFIG.USER_ID}&limit=50&sort_fields=date_created&sort_types=DESC`);
    let pregs = data.questions || [];
    if (args?.solo_sin_responder) pregs = pregs.filter(q=>q.status==="UNANSWERED");
    if (!pregs.length) return args?.solo_sin_responder ? "🎉 ¡Sin preguntas pendientes!" : "No hay preguntas.";
    const sinR = pregs.filter(q=>q.status==="UNANSWERED").length;
    let txt = `💬 PREGUNTAS (${pregs.length}) | Sin responder: ${sinR}\n\n`;
    pregs.forEach(q => { const f = new Date(q.date_created).toLocaleDateString("es-AR"); txt += `${q.status==="ANSWERED"?"✅":"⚠️"} ${f}\n${q.text}\n`; if (q.answer) txt += `↩️ ${q.answer.text}\n`; txt += "\n"; });
    return txt;
  }

  if (name === "ver_reputacion") {
    const me = await meliGet(`/users/${CONFIG.USER_ID}`);
    const rep = me.seller_reputation; const m = rep?.metrics;
    return `⭐ REPUTACIÓN NOOR KIDS\n\nNivel: ${rep?.level_id||"—"}\nVentas completadas: ${rep?.transactions?.completed||0}\nCanceladas: ${rep?.transactions?.canceled||0}\n\n📊 Métricas (365 días):\n  Ventas: ${m?.sales?.completed||0}\n  Reclamos: ${m?.claims?.value||0} (${((m?.claims?.rate||0)*100).toFixed(1)}%)\n  Cancelaciones: ${m?.cancellations?.value||0}`;
  }

  if (name === "ver_visitas") {
    const search = await meliGet(`/users/${CONFIG.USER_ID}/items/search?limit=50`);
    const ids = (search.results || []).slice(0, 20);
    if (!ids.length) return "No hay publicaciones.";
    const itemsRes = await meliGet(`/items?ids=${ids.join(",")}`);
    const titulos = {};
    (itemsRes || []).forEach(r => { if (r.body) titulos[r.body.id] = r.body.title; });
    const visitas = await Promise.all(ids.map(async (id) => {
      try { const v = await meliGet(`/items/${id}/visits?last=30`); const total = v.total_visits || Object.values(v.results || {}).reduce((a, b) => a + b, 0); return { id, titulo: titulos[id] || id, visitas: total }; }
      catch (e) { return { id, titulo: titulos[id] || id, visitas: 0 }; }
    }));
    visitas.sort((a, b) => b.visitas - a.visitas);
    const totalVisitas = visitas.reduce((s, v) => s + v.visitas, 0);
    let txt = `👁️ VISITAS — ÚLTIMOS 30 DÍAS\n${"═".repeat(30)}\n\n📊 Total: ${totalVisitas.toLocaleString("es-AR")}\n\n`;
    visitas.forEach((v, i) => { const barra = "█".repeat(Math.min(Math.round(v.visitas / Math.max(visitas[0].visitas, 1) * 10), 10)); const pct = totalVisitas > 0 ? Math.round(v.visitas / totalVisitas * 100) : 0; txt += `${i+1}. ${(v.titulo||"—").slice(0,45)}\n   ${barra} ${v.visitas.toLocaleString("es-AR")} visitas (${pct}%)\n\n`; });
    return txt;
  }

  if (name === "ver_conversion") {
    const search = await meliGet(`/users/${CONFIG.USER_ID}/items/search?limit=50`);
    const ids = (search.results || []).slice(0, 20);
    if (!ids.length) return "No hay publicaciones.";
    const itemsRes = await meliGet(`/items?ids=${ids.join(",")}`);
    const items = {};
    (itemsRes || []).forEach(r => { if (r.body) items[r.body.id] = { titulo: r.body.title, vendidas: r.body.sold_quantity || 0 }; });
    const resultados = await Promise.all(ids.map(async (id) => {
      try { const v = await meliGet(`/items/${id}/visits?last=30`); const visitas = v.total_visits || Object.values(v.results || {}).reduce((a, b) => a + b, 0); const item = items[id] || {}; return { id, titulo: item.titulo || id, visitas, vendidas: item.vendidas || 0, tasa: visitas > 0 ? (item.vendidas || 0) / visitas * 100 : 0 }; }
      catch (e) { return { id, titulo: items[id]?.titulo || id, visitas: 0, vendidas: items[id]?.vendidas || 0, tasa: 0 }; }
    }));
    resultados.sort((a, b) => b.tasa - a.tasa);
    const totalVisitas = resultados.reduce((s, r) => s + r.visitas, 0);
    const totalVentas = resultados.reduce((s, r) => s + r.vendidas, 0);
    const tasaGlobal = totalVisitas > 0 ? (totalVentas / totalVisitas * 100).toFixed(1) : 0;
    let txt = `📈 CONVERSIÓN — ÚLTIMOS 30 DÍAS\n${"═".repeat(30)}\n\n👁️ Visitas: ${totalVisitas.toLocaleString("es-AR")} | 💰 Ventas: ${totalVentas} | 📊 Tasa global: ${tasaGlobal}%\n\n`;
    const buenos = resultados.filter(r => r.visitas > 0 && r.tasa > 0);
    const sinConv = resultados.filter(r => r.visitas > 0 && r.tasa === 0);
    const sinVis = resultados.filter(r => r.visitas === 0);
    if (buenos.length) { txt += `✅ CONVIERTEN BIEN:\n`; buenos.forEach(r => { txt += `  • ${r.titulo.slice(0,42)}\n    👁️ ${r.visitas} visitas → 💰 ${r.vendidas} ventas (${r.tasa.toFixed(1)}%)\n`; }); txt += "\n"; }
    if (sinConv.length) { txt += `⚠️ TIENEN VISITAS PERO NO VENDEN:\n`; sinConv.forEach(r => { txt += `  • ${r.titulo.slice(0,42)}\n    👁️ ${r.visitas} visitas → 0 ventas\n`; }); txt += "\n"; }
    if (sinVis.length) { txt += `❌ SIN VISITAS:\n`; sinVis.forEach(r => { txt += `  • ${r.titulo.slice(0,42)}\n`; }); }
    return txt;
  }

  if (name === "enviar_resumen") {
    await enviarResumenSemanal();
    return `✅ Resumen enviado a ${EMAIL_TO}`;
  }

  return `Herramienta desconocida: ${name}`;
}

// ── EXPRESS ──
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.json({ status: "ok", server: "meli-mcp-noor-kids", connected: !!CONFIG.ACCESS_TOKEN, db: !!pool }));

app.get("/enviar-resumen", async (req, res) => {
  try { await enviarResumenSemanal(); res.json({ ok: true, mensaje: `Resumen enviado a ${EMAIL_TO}` }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post("/mcp", async (req, res) => {
  const { method, params, id } = req.body;
  if (method === "initialize") return res.json({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "meli-noor-kids", version: "1.0.0" } } });
  if (method === "tools/list") return res.json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    try { const result = await executeTool(params.name, params.arguments || {}); return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: result }] } }); }
    catch (e) { return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `❌ Error: ${e.message}` }] } }); }
  }
  res.json({ jsonrpc: "2.0", id, result: {} });
});

const PORT = process.env.PORT || 3000;

// Iniciar todo
initDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Meli MCP Server en puerto ${PORT}`);
    console.log(`Token activo: ${!!CONFIG.ACCESS_TOKEN}`);
    startCron();
  });
}).catch(e => {
  console.error("Error iniciando DB:", e.message);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Meli MCP Server en puerto ${PORT} (sin DB)`);
    startCron();
  });
});
