import express from "express";
import https from "https";

const CONFIG = {
  CLIENT_ID:     process.env.MELI_CLIENT_ID     || "919130041209199",
  CLIENT_SECRET: process.env.MELI_CLIENT_SECRET || "Iwx1fpyznVQRS9qS1xrnMCxNxNFIc1Bj",
  USER_ID:       process.env.MELI_USER_ID       || "2934266490",
  REDIRECT_URI:  "https://www.google.com",
  ACCESS_TOKEN:  process.env.MELI_ACCESS_TOKEN  || "",
  REFRESH_TOKEN: process.env.MELI_REFRESH_TOKEN || "",
};

function apiRequest(path, token) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: "api.mercadolibre.com",
      path,
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
      hostname: "api.mercadolibre.com",
      path: "/oauth/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
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
    CONFIG.ACCESS_TOKEN = data.access_token;
    if (data.refresh_token) CONFIG.REFRESH_TOKEN = data.refresh_token;
    console.log("Token renovado:", new Date().toLocaleString());
  } else {
    throw new Error("No se pudo renovar: " + JSON.stringify(data));
  }
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
  if (CONFIG.REFRESH_TOKEN) {
    try { await refreshToken(); }
    catch (e) { console.error("Error renovando token:", e.message); }
  }
}, 5 * 60 * 60 * 1000);

const TOOLS = [
  {
    name: "conectar_cuenta",
    description: "Conecta tu cuenta de Mercado Libre con un código de autorización TG-XXXXXXX",
    inputSchema: { type: "object", properties: { codigo: { type: "string" } }, required: ["codigo"] }
  },
  {
    name: "resumen_negocio",
    description: "Resumen completo: ventas, ingresos, top productos y preguntas pendientes",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "ver_ventas",
    description: "Últimas ventas y órdenes de Mercado Libre",
    inputSchema: { type: "object", properties: { limite: { type: "number" } } }
  },
  {
    name: "ver_publicaciones",
    description: "Publicaciones activas con precio, stock y unidades vendidas",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "ver_preguntas",
    description: "Preguntas de compradores, con filtro de sin responder",
    inputSchema: { type: "object", properties: { solo_sin_responder: { type: "boolean" } } }
  },
  {
    name: "ver_reputacion",
    description: "Reputación como vendedor y métricas de calidad",
    inputSchema: { type: "object", properties: {} }
  }
];

async function executeTool(name, args) {
  if (name === "conectar_cuenta") {
    const data = await postMeli({
      grant_type: "authorization_code",
      client_id: CONFIG.CLIENT_ID,
      client_secret: CONFIG.CLIENT_SECRET,
      code: args.codigo,
      redirect_uri: CONFIG.REDIRECT_URI,
    });
    if (data.access_token) {
      CONFIG.ACCESS_TOKEN = data.access_token;
      CONFIG.REFRESH_TOKEN = data.refresh_token || "";
      return "✅ ¡Cuenta conectada! El token se renueva automáticamente cada 5 horas.";
    }
    return `❌ Error: ${data.message || JSON.stringify(data)}`;
  }

  if (name === "resumen_negocio") {
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
    let txt = `📊 RESUMEN NOOR KIDS\n${"═".repeat(28)}\n\n`;
    txt += `💰 Ingresos: $${ingresos.toLocaleString("es-AR")} ARS\n`;
    txt += `📦 Órdenes pagas: ${pagas.length}/${orders.length}\n`;
    txt += `🏷️ Publicaciones: ${pub.results?.length||0}\n`;
    txt += `💬 Preguntas sin responder: ${sinR}\n`;
    txt += `⭐ Reputación: ${me.seller_reputation?.level_id||"—"}\n\n`;
    txt += `🏆 Top productos:\n`;
    top.forEach(([t,c],i) => txt += `  ${i+1}. ${t.slice(0,45)} (${c} ventas)\n`);
    return txt;
  }

  if (name === "ver_ventas") {
    const lim = Math.min(args?.limite||20, 50);
    const data = await meliGet(`/orders/search?seller=${CONFIG.USER_ID}&sort=date_desc&limit=${lim}`);
    const orders = data.results || [];
    const ingresos = orders.filter(o=>o.status==="paid").reduce((s,o)=>s+(o.total_amount||0),0);
    let txt = `📦 ÚLTIMAS ${orders.length} ÓRDENES\n💰 Ingresos: $${ingresos.toLocaleString("es-AR")}\n\n`;
    orders.forEach(o => {
      const f = new Date(o.date_created).toLocaleDateString("es-AR");
      const art = (o.order_items?.[0]?.item?.title||"—").slice(0,45);
      const e = o.status==="paid"?"✅":o.status==="cancelled"?"❌":"⏳";
      txt += `${e} ${f} — ${art}\n   ${o.buyer?.nickname||"—"} | $${(o.total_amount||0).toLocaleString("es-AR")}\n\n`;
    });
    return txt;
  }

  if (name === "ver_publicaciones") {
    const search = await meliGet(`/users/${CONFIG.USER_ID}/items/search?limit=50`);
    const ids = search.results || [];
    const items = [];
    if (ids.length) {
      const res = await meliGet(`/items?ids=${ids.slice(0,20).join(",")}`);
      (res||[]).forEach(r => r.body && items.push(r.body));
    }
    const vendidas = items.reduce((s,i)=>s+(i.sold_quantity||0),0);
    let txt = `🏷️ PUBLICACIONES (${ids.length} total) | Vendidas: ${vendidas}\n\n`;
    items.forEach(i => {
      const e = i.status==="active"?"✅":i.status==="paused"?"⏸️":"❌";
      txt += `${e} ${i.title||"—"}\n   $${(i.price||0).toLocaleString("es-AR")} | Stock: ${i.available_quantity??"-"} | Vendidas: ${i.sold_quantity||0}\n\n`;
    });
    return txt;
  }

  if (name === "ver_preguntas") {
    const data = await meliGet(`/questions/search?seller_id=${CONFIG.USER_ID}&limit=50&sort_fields=date_created&sort_types=DESC`);
    let pregs = data.questions || [];
    if (args?.solo_sin_responder) pregs = pregs.filter(q=>q.status==="UNANSWERED");
    if (!pregs.length) return args?.solo_sin_responder ? "🎉 ¡Sin preguntas pendientes!" : "No hay preguntas.";
    const sinR = pregs.filter(q=>q.status==="UNANSWERED").length;
    let txt = `💬 PREGUNTAS (${pregs.length}) | Sin responder: ${sinR}\n\n`;
    pregs.forEach(q => {
      const f = new Date(q.date_created).toLocaleDateString("es-AR");
      txt += `${q.status==="ANSWERED"?"✅":"⚠️"} ${f}\n${q.text}\n`;
      if (q.answer) txt += `↩️ ${q.answer.text}\n`;
      txt += "\n";
    });
    return txt;
  }

  if (name === "ver_reputacion") {
    const me = await meliGet(`/users/${CONFIG.USER_ID}`);
    const rep = me.seller_reputation;
    const m = rep?.metrics;
    return `⭐ REPUTACIÓN NOOR KIDS\n\nNivel: ${rep?.level_id||"—"}\nVentas completadas: ${rep?.transactions?.completed||0}\nCanceladas: ${rep?.transactions?.canceled||0}\n\n📊 Métricas (365 días):\n  Ventas: ${m?.sales?.completed||0}\n  Reclamos: ${m?.claims?.value||0} (${((m?.claims?.rate||0)*100).toFixed(1)}%)\n  Cancelaciones: ${m?.cancellations?.value||0}`;
  }

  return `Herramienta desconocida: ${name}`;
}

// ── EXPRESS ──
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", server: "meli-mcp-noor-kids", connected: !!CONFIG.ACCESS_TOKEN });
});

app.post("/mcp", async (req, res) => {
  const { method, params, id } = req.body;

  if (method === "initialize") {
    return res.json({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "meli-noor-kids", version: "1.0.0" }
      }
    });
  }

  if (method === "tools/list") {
    return res.json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  }

  if (method === "tools/call") {
    try {
      const result = await executeTool(params.name, params.arguments || {});
      return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: result }] } });
    } catch (e) {
      return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `❌ Error: ${e.message}` }] } });
    }
  }

  res.json({ jsonrpc: "2.0", id, result: {} });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Meli MCP Server corriendo en puerto ${PORT}`);
  console.log(`Token activo: ${!!CONFIG.ACCESS_TOKEN}`);
});
