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
function apiRequest(path, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: "api.mercadolibre.com", path,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...extraHeaders },
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

async function meliGet(path, extraHeaders = {}) {
  if (!CONFIG.ACCESS_TOKEN) throw new Error("Sin token. Usá conectar_cuenta primero.");
  const data = await apiRequest(path, CONFIG.ACCESS_TOKEN, extraHeaders);
  if (data.error === "unauthorized") {
    await refreshToken();
    return apiRequest(path, CONFIG.ACCESS_TOKEN, extraHeaders);
  }
  return data;
}

// Auto-renovar cada 5 horas
setInterval(async () => {
  if (CONFIG.REFRESH_TOKEN) try { await refreshToken(); } catch (e) { console.error("Error renovando:", e.message); }
}, 5 * 60 * 60 * 1000);

// ── SEO AUDIT HELPERS ──

// Cache de atributos por categoría (en memoria, válido por sesión)
const _catAttrCache = {};

// Limita concurrencia para respetar rate limits de MeLi (~10 req/s)
function createLimiter(maxConcurrent) {
  let running = 0;
  const queue = [];
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        running++;
        try { resolve(await fn()); }
        catch (e) { reject(e); }
        finally {
          running--;
          if (queue.length) queue.shift()();
        }
      };
      if (running < maxConcurrent) run();
      else queue.push(run);
    });
  };
}

// Obtiene todos los IDs de publicaciones del seller con paginación
async function getAllItemIds(status = "active") {
  const ids = [];
  let offset = 0;
  while (true) {
    const data = await meliGet(`/users/${CONFIG.USER_ID}/items/search?status=${status}&limit=100&offset=${offset}`);
    const batch = data.results || [];
    ids.push(...batch);
    const total = data.paging?.total ?? 0;
    if (ids.length >= total || batch.length < 100) break;
    offset += 100;
  }
  console.log(`getAllItemIds: ${ids.length} IDs obtenidos`);
  return ids;
}

// Multi-get de items en batches de 20 (reduce requests 20:1)
async function getItemsMultiBatch(ids) {
  const fields = "id,title,health,attributes,pictures,tags,domain_id,category_id,sold_quantity,available_quantity,listing_type_id,status,shipping,catalog_listing,catalog_product_id,price";
  const items = [];
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    try {
      const res = await meliGet(`/items?ids=${batch.join(",")}&attributes=${fields}`);
      (res || []).forEach(r => { if (r.body && !r.body.error) items.push(r.body); });
    } catch (e) {
      console.error(`Error multi-get batch [${i}-${i + 20}]:`, e.message);
    }
  }
  return items;
}

// Atributos de categoría con cache en memoria
async function getCatAttributes(categoryId) {
  if (!categoryId) return [];
  if (_catAttrCache[categoryId]) return _catAttrCache[categoryId];
  try {
    const attrs = await meliGet(`/categories/${categoryId}/attributes`);
    _catAttrCache[categoryId] = Array.isArray(attrs) ? attrs : [];
  } catch (e) {
    console.error(`Error obteniendo atributos de categoría ${categoryId}:`, e.message);
    _catAttrCache[categoryId] = [];
  }
  return _catAttrCache[categoryId];
}

// Visitas por item usando el endpoint batch; fallback a individual si falla
async function getVisitsBatch(ids, days = 30) {
  const results = {};
  const limit = createLimiter(5);

  // Intentar batch endpoint
  try {
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      const res = await meliGet(`/items/visits/time_window?ids=${batch.join(",")}&last=${days}&unit=day`);
      if (Array.isArray(res)) {
        res.forEach(item => { results[item.item_id] = item.total_visits || 0; });
      } else if (res && typeof res === "object") {
        Object.entries(res).forEach(([id, d]) => {
          results[id] = typeof d === "number" ? d : (d?.total_visits || 0);
        });
      }
    }
    return results;
  } catch (e) {
    console.error("Batch visits falló, usando individual:", e.message);
  }

  // Fallback: requests individuales con concurrencia controlada
  await Promise.all(ids.map(id => limit(async () => {
    try {
      const v = await meliGet(`/items/${id}/visits?last=${days}`);
      results[id] = v.total_visits || Object.values(v.results || {}).reduce((a, b) => a + b, 0);
    } catch (e) {
      results[id] = 0;
    }
  })));
  return results;
}

// Ventas por item en los últimos N días, parseadas desde órdenes
async function getSalesByItem(days = 30) {
  const salesByItem = {};
  try {
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date().toISOString();
    let offset = 0;
    while (true) {
      const data = await meliGet(
        `/orders/search?seller=${CONFIG.USER_ID}&order.date_created.from=${from}&order.date_created.to=${to}&limit=50&offset=${offset}`
      );
      const orders = data.results || [];
      orders.forEach(order => {
        (order.order_items || []).forEach(oi => {
          const itemId = oi.item?.id;
          if (itemId) salesByItem[itemId] = (salesByItem[itemId] || 0) + (oi.quantity || 1);
        });
      });
      const total = data.paging?.total ?? 0;
      offset += orders.length;
      if (offset >= total || orders.length < 50) break;
    }
  } catch (e) {
    console.error("Error obteniendo órdenes:", e.message);
  }
  return salesByItem;
}

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
    meliGet(`/users/${CONFIG.USER_ID}/items/search?status=active&limit=50`),
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
  {
    name: "noorkids_audit_quality",
    description: "Audita la calidad de las publicaciones activas del seller en MercadoLibre. Devuelve por cada listing el quality level (health), atributos faltantes, problemas detectados y nivel de exposición.",
    inputSchema: {
      type: "object",
      properties: {
        item_ids: { type: "array", items: { type: "string" }, description: "IDs específicos a auditar. Si se omite, audita todos los activos." }
      }
    }
  },
  {
    name: "noorkids_get_traffic",
    description: "Obtiene visitas y tasa de conversión de las publicaciones en los últimos N días.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Ventana temporal en días (default: 30)" },
        item_ids: { type: "array", items: { type: "string" }, description: "Filtrar a IDs específicos. Si se omite, trae todos los activos." }
      }
    }
  },
  {
    name: "noorkids_get_ads_performance",
    description: "Obtiene métricas de campañas de Mercado Ads (ACOS, ROAS, costo, ventas atribuidas) por item.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Ventana temporal en días (default: 30)" },
        item_ids: { type: "array", items: { type: "string" }, description: "Filtrar a IDs específicos." }
      }
    }
  },
  {
    name: "noorkids_get_full_audit",
    description: "Genera la auditoría completa de calidad + tráfico + ads de todas las publicaciones en un único objeto consolidado. Ideal como input del dashboard de auditoría SEO.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Ventana temporal en días (default: 30)" }
      }
    }
  },
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
    const [ord, pub, preg, me] = await Promise.all([meliGet(`/orders/search?seller=${CONFIG.USER_ID}&sort=date_desc&limit=50`), meliGet(`/users/${CONFIG.USER_ID}/items/search?status=active&limit=50`), meliGet(`/questions/search?seller_id=${CONFIG.USER_ID}&limit=50`), meliGet(`/users/${CONFIG.USER_ID}`)]);
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
    const search = await meliGet(`/users/${CONFIG.USER_ID}/items/search?status=active&limit=50`);
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
    const search = await meliGet(`/users/${CONFIG.USER_ID}/items/search?status=active&limit=50`);
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
    const search = await meliGet(`/users/${CONFIG.USER_ID}/items/search?status=active&limit=50`);
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

  // ── HERRAMIENTAS DE AUDITORÍA SEO ──

  if (name === "noorkids_audit_quality") {
    const start = Date.now();
    const itemIds = args?.item_ids?.length ? args.item_ids : await getAllItemIds();
    if (!itemIds.length) return "No hay publicaciones activas.";

    console.log(`noorkids_audit_quality: procesando ${itemIds.length} publicaciones`);
    const items = await getItemsMultiBatch(itemIds);

    // Pre-cargar atributos de todas las categorías únicas (una sola vez cada una)
    const uniqueCats = [...new Set(items.map(i => i.category_id).filter(Boolean))];
    await Promise.all(uniqueCats.map(cat => getCatAttributes(cat)));

    const healthEmoji = h => h >= 0.9 ? "🟢" : h >= 0.7 ? "🟡" : "🔴";
    const results = [];
    let losingExposure = 0;

    for (const item of items) {
      const health = item.health ?? 0;
      const tags = item.tags || [];
      const hasIncompleteSpecs = tags.includes("incomplete_technical_specs");
      const losingExp = health < 0.8 || hasIncompleteSpecs;
      if (losingExp) losingExposure++;

      const catAttrs = await getCatAttributes(item.category_id);
      const loadedAttrIds = new Set(
        (item.attributes || [])
          .filter(a => a.value_name || a.value_id)
          .map(a => a.id)
      );

      const missingRequired = catAttrs
        .filter(a => (a.tags || []).includes("required") && !loadedAttrIds.has(a.id))
        .map(a => a.name);

      const missingRecommended = catAttrs
        .filter(a => !(a.tags || []).includes("required") && a.relevance === "REQUIRED" && !loadedAttrIds.has(a.id))
        .map(a => a.name);

      const picturesCount = (item.pictures || []).length;
      const hasSizeChart = (item.attributes || []).some(a =>
        a.id === "SIZE_GRID_ID" || a.id === "SIZE_GRID_ROW" ||
        (a.value_name || "").toLowerCase().includes("guía de talles")
      );
      const catalogStatus = item.catalog_listing ? "catalog" : "non_catalog";

      results.push({ item, health, losingExp, hasIncompleteSpecs, missingRequired, missingRecommended, picturesCount, hasSizeChart, catalogStatus, tags });
    }

    // Ordenar: peor quality primero
    results.sort((a, b) => a.health - b.health);

    let txt = `🔍 AUDITORÍA DE CALIDAD — NOOR KIDS\n${"═".repeat(36)}\n\n`;
    txt += `📦 Publicaciones analizadas: ${items.length}\n`;
    txt += `⚠️  Perdiendo exposición: ${losingExposure}/${items.length}\n`;
    txt += `📅 ${new Date().toLocaleDateString("es-AR")}\n\n`;

    for (const r of results) {
      const { item, health, losingExp, hasIncompleteSpecs, missingRequired, missingRecommended, picturesCount, hasSizeChart, catalogStatus, tags } = r;
      txt += `${healthEmoji(health)} ${(item.title || "—").slice(0, 52)}\n`;
      txt += `   ID: ${item.id} | Quality: ${(health * 100).toFixed(0)}% | 📷 ${picturesCount} fotos | ${catalogStatus === "catalog" ? "📚 Catálogo" : "📝 Libre"}\n`;
      if (losingExp) {
        txt += `   ⚠️  PERDIENDO EXPOSICIÓN`;
        if (hasIncompleteSpecs) txt += " — ficha técnica incompleta";
        txt += "\n";
      }
      if (!hasSizeChart) txt += `   ❌ Sin guía de talles\n`;
      if (missingRequired.length) txt += `   🔴 Requeridos faltantes: ${missingRequired.slice(0, 5).join(", ")}\n`;
      if (missingRecommended.length) txt += `   🟡 Recomendados faltantes: ${missingRecommended.slice(0, 3).join(", ")}\n`;
      if (!losingExp && !missingRequired.length && hasSizeChart) txt += `   ✅ Sin problemas detectados\n`;
      txt += "\n";
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    txt += `─── ${items.length} publicaciones procesadas en ${elapsed}s ───`;
    return txt;
  }

  if (name === "noorkids_get_traffic") {
    const days = Math.max(1, Math.min(args?.days || 30, 90));
    const start = Date.now();
    const itemIds = args?.item_ids?.length ? args.item_ids : await getAllItemIds();
    if (!itemIds.length) return "No hay publicaciones activas.";

    console.log(`noorkids_get_traffic: ${itemIds.length} publicaciones, últimos ${days} días`);

    // Obtener items (títulos), visitas y ventas en paralelo
    const [items, visitsByItem, salesByItem] = await Promise.all([
      getItemsMultiBatch(itemIds),
      getVisitsBatch(itemIds, days),
      getSalesByItem(days),
    ]);

    const titleById = {};
    items.forEach(i => { titleById[i.id] = i.title; });

    const results = itemIds.map(id => {
      const visits = visitsByItem[id] || 0;
      const sold = salesByItem[id] || 0;
      // CVR protegido contra división por cero
      const cvr = visits > 0 ? (sold / visits * 100) : 0;
      return { id, title: titleById[id] || id, visits, sold, cvr, visitsPerDay: visits / days };
    });

    results.sort((a, b) => b.visits - a.visits);

    const totalVisits = results.reduce((s, r) => s + r.visits, 0);
    const totalSales = results.reduce((s, r) => s + r.sold, 0);
    const globalCvr = totalVisits > 0 ? (totalSales / totalVisits * 100).toFixed(1) : "0.0";

    let txt = `📊 TRÁFICO Y CONVERSIÓN — ÚLTIMOS ${days} DÍAS\n${"═".repeat(38)}\n\n`;
    txt += `👁️ Total visitas: ${totalVisits.toLocaleString("es-AR")} | 💰 Ventas: ${totalSales} | 📈 CVR global: ${globalCvr}%\n\n`;

    const cvrEmoji = r => r.cvr >= 3 ? "🟢" : r.cvr >= 1 ? "🟡" : r.visits > 0 ? "🔴" : "⚫";

    results.forEach(r => {
      txt += `${cvrEmoji(r)} ${(r.title || "—").slice(0, 50)}\n`;
      txt += `   ID: ${r.id}\n`;
      txt += `   👁️ ${r.visits.toLocaleString()} visitas (${r.visitsPerDay.toFixed(1)}/día) | 💰 ${r.sold} ventas | 📈 CVR: ${r.cvr.toFixed(1)}%\n\n`;
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    txt += `─── ${results.length} publicaciones procesadas en ${elapsed}s ───`;
    return txt;
  }

  if (name === "noorkids_get_ads_performance") {
    const days = Math.max(1, Math.min(args?.days || 30, 90));
    const start = Date.now();
    const ADS_HEADERS = { "api-version": "2" };

    // Obtener cuenta de advertising
    let advertiserId;
    try {
      const accounts = await meliGet(`/users/${CONFIG.USER_ID}/advertising_accounts`, ADS_HEADERS);
      if (!accounts || (Array.isArray(accounts) && accounts.length === 0)) {
        return "ℹ️ Este seller no tiene cuenta de Mercado Ads activa.";
      }
      const account = Array.isArray(accounts) ? accounts[0] : accounts;
      advertiserId = account.advertiser_id || account.id;
      if (!advertiserId) return "ℹ️ No se encontró ID de cuenta publicitaria. Verificá que Mercado Ads esté habilitado.";
    } catch (e) {
      return `ℹ️ No se pudo acceder a Mercado Ads: ${e.message}`;
    }

    // Obtener campañas
    let campaigns = [];
    try {
      const campsRes = await meliGet(`/advertising/advertisers/${advertiserId}/product_ads/campaigns`, ADS_HEADERS);
      campaigns = campsRes.results || (Array.isArray(campsRes) ? campsRes : []);
    } catch (e) {
      return `❌ Error obteniendo campañas de Mercado Ads: ${e.message}`;
    }

    if (!campaigns.length) return "ℹ️ No hay campañas de Mercado Ads configuradas.";

    const dateTo = new Date().toISOString().split("T")[0];
    const dateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const filterIds = args?.item_ids?.length ? new Set(args.item_ids) : null;
    const byItem = {};

    for (const camp of campaigns) {
      try {
        const metrics = await meliGet(
          `/advertising/advertisers/${advertiserId}/product_ads/campaigns/${camp.id}/items?date_from=${dateFrom}&date_to=${dateTo}&metrics=clicks,prints,cost,direct_amount,acos,roas`,
          ADS_HEADERS
        );
        const rows = metrics.results || (Array.isArray(metrics) ? metrics : []);
        rows.forEach(m => {
          if (!m || !m.item_id) return;
          if (filterIds && !filterIds.has(m.item_id)) return;
          if (!byItem[m.item_id]) {
            byItem[m.item_id] = { item_id: m.item_id, title: m.title || m.item_id, impressions: 0, clicks: 0, cost: 0, direct_sales: 0 };
          }
          const e = byItem[m.item_id];
          e.impressions += m.prints || 0;
          e.clicks += m.clicks || 0;
          e.cost += m.cost || 0;
          e.direct_sales += m.direct_amount || 0;
        });
      } catch (e) {
        console.error(`Error en métricas campaña ${camp.id}:`, e.message);
      }
    }

    const results = Object.values(byItem).map(r => ({
      ...r,
      ctr: r.impressions > 0 ? (r.clicks / r.impressions * 100) : 0,
      acos: r.direct_sales > 0 ? (r.cost / r.direct_sales * 100) : 0,
      roas: r.cost > 0 ? (r.direct_sales / r.cost) : 0,
    })).sort((a, b) => b.impressions - a.impressions);

    const totalCost = results.reduce((s, r) => s + r.cost, 0);
    const totalSales = results.reduce((s, r) => s + r.direct_sales, 0);
    const globalRoas = totalCost > 0 ? (totalSales / totalCost).toFixed(2) : "—";

    let txt = `📢 MERCADO ADS — ÚLTIMOS ${days} DÍAS\n${"═".repeat(34)}\n\n`;
    txt += `🏷️ Campañas: ${campaigns.length} | Items anunciados: ${results.length}\n`;
    txt += `📅 ${dateFrom} → ${dateTo}\n`;
    txt += `💸 Gasto total: $${totalCost.toLocaleString("es-AR")} | Ventas directas: $${totalSales.toLocaleString("es-AR")} | ROAS global: ${globalRoas}x\n\n`;

    if (!results.length) {
      txt += "ℹ️ No hay datos de items anunciados para el período seleccionado.\n";
    } else {
      const acosEmoji = r => r.acos > 0 && r.acos <= 15 ? "🟢" : r.acos <= 30 ? "🟡" : "🔴";
      results.forEach(r => {
        txt += `${acosEmoji(r)} ${(r.title || r.item_id).slice(0, 50)}\n`;
        txt += `   ID: ${r.item_id}\n`;
        txt += `   👁️ ${r.impressions.toLocaleString()} imp | 🖱️ ${r.clicks} clicks | CTR: ${r.ctr.toFixed(2)}%\n`;
        txt += `   💸 Gasto: $${r.cost.toLocaleString("es-AR")} | 💰 Ventas: $${r.direct_sales.toLocaleString("es-AR")}\n`;
        txt += `   📊 ACOS: ${r.acos > 0 ? r.acos.toFixed(1) + "%" : "—"} | ROAS: ${r.roas > 0 ? r.roas.toFixed(2) + "x" : "—"}\n\n`;
      });
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    txt += `─── ${campaigns.length} campañas procesadas en ${elapsed}s ───`;
    return txt;
  }

  if (name === "noorkids_get_full_audit") {
    const days = Math.max(1, Math.min(args?.days || 30, 90));
    const start = Date.now();

    console.log(`noorkids_get_full_audit: iniciando auditoría completa (${days} días)`);
    const allIds = await getAllItemIds();
    if (!allIds.length) return "No hay publicaciones activas.";

    // Quality y ads son independientes entre sí, tráfico también
    const [qualityResult, trafficResult, adsResult] = await Promise.all([
      executeTool("noorkids_audit_quality", { item_ids: allIds }),
      executeTool("noorkids_get_traffic", { days, item_ids: allIds }),
      executeTool("noorkids_get_ads_performance", { days }),
    ]);

    const sep = `\n${"━".repeat(42)}\n\n`;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    return (
      `🎯 AUDITORÍA SEO COMPLETA — NOOR KIDS\n${"═".repeat(40)}\n` +
      `📅 ${new Date().toLocaleDateString("es-AR")} | ⏱️ ${elapsed}s total | 📦 ${allIds.length} publicaciones\n` +
      sep + qualityResult +
      sep + trafficResult +
      sep + adsResult
    );
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
