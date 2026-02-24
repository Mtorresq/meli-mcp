#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import https from "https";

// ══════════════════════════════════════════════
//  CONFIGURACIÓN — editá estos valores
// ══════════════════════════════════════════════
const CONFIG = {
  CLIENT_ID:     "919130041209199",
  CLIENT_SECRET: "Iwx1fpyznVQRS9qS1xrnMCxNxNFIc1Bj",
  USER_ID:       "2934266490",
  REDIRECT_URI:  "https://www.google.com",
  // Token y refresh se guardan acá automáticamente
  ACCESS_TOKEN:  "",
  REFRESH_TOKEN: "",
};

// ══════════════════════════════════════════════
//  API HELPER
// ══════════════════════════════════════════════
function apiRequest(path, token) {
  return new Promise((resolve, reject) => {
    const url = `https://api.mercadolibre.com${path}`;
    const options = {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    };
    https.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Error al parsear respuesta")); }
      });
    }).on("error", reject);
  });
}

async function refreshAccessToken() {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CONFIG.CLIENT_ID,
      client_secret: CONFIG.CLIENT_SECRET,
      refresh_token: CONFIG.REFRESH_TOKEN,
    }).toString();

    const req = https.request({
      hostname: "api.mercadolibre.com",
      path: "/oauth/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            CONFIG.ACCESS_TOKEN = json.access_token;
            CONFIG.REFRESH_TOKEN = json.refresh_token || CONFIG.REFRESH_TOKEN;
            resolve(json.access_token);
          } else {
            reject(new Error("No se pudo renovar el token: " + JSON.stringify(json)));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CONFIG.CLIENT_ID,
      client_secret: CONFIG.CLIENT_SECRET,
      code,
      redirect_uri: CONFIG.REDIRECT_URI,
    }).toString();

    const req = https.request({
      hostname: "api.mercadolibre.com",
      path: "/oauth/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function meliGet(path) {
  if (!CONFIG.ACCESS_TOKEN) throw new Error("No hay token activo. Usá la herramienta 'conectar_cuenta'.");
  try {
    const data = await apiRequest(path, CONFIG.ACCESS_TOKEN);
    if (data.error === "unauthorized") {
      // Intentar renovar token
      if (CONFIG.REFRESH_TOKEN) {
        await refreshAccessToken();
        return await apiRequest(path, CONFIG.ACCESS_TOKEN);
      }
      throw new Error("Token expirado. Usá 'conectar_cuenta' para renovar.");
    }
    return data;
  } catch (e) {
    throw e;
  }
}

// ══════════════════════════════════════════════
//  MCP SERVER
// ══════════════════════════════════════════════
const server = new Server(
  { name: "meli-noor-kids", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Lista de herramientas disponibles
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "conectar_cuenta",
      description: "Conecta tu cuenta de Mercado Libre. Usá esto cuando el token expire o para la primera conexión.",
      inputSchema: {
        type: "object",
        properties: {
          codigo: {
            type: "string",
            description: "El código de autorización que obtenés de la URL de Google después de autorizar en Meli. Formato: TG-XXXXXXX"
          }
        },
        required: ["codigo"]
      }
    },
    {
      name: "ver_ventas",
      description: "Muestra tus últimas ventas y órdenes de Mercado Libre con totales e ingresos",
      inputSchema: {
        type: "object",
        properties: {
          limite: {
            type: "number",
            description: "Cantidad de órdenes a mostrar (máximo 50, default 20)"
          }
        }
      }
    },
    {
      name: "ver_publicaciones",
      description: "Muestra todas tus publicaciones activas con precio, stock y unidades vendidas",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "ver_preguntas",
      description: "Muestra las preguntas de compradores sobre tus productos",
      inputSchema: {
        type: "object",
        properties: {
          solo_sin_responder: {
            type: "boolean",
            description: "Si es true, muestra solo las preguntas sin responder"
          }
        }
      }
    },
    {
      name: "ver_reputacion",
      description: "Muestra tu reputación como vendedor, calificaciones y métricas",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "resumen_negocio",
      description: "Muestra un resumen completo de tu negocio: ventas del mes, ingresos, productos más vendidos y preguntas pendientes",
      inputSchema: { type: "object", properties: {} }
    }
  ]
}));

// Manejador de herramientas
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // ── CONECTAR CUENTA ──
    if (name === "conectar_cuenta") {
      const result = await exchangeCode(args.codigo);
      if (result.access_token) {
        CONFIG.ACCESS_TOKEN = result.access_token;
        CONFIG.REFRESH_TOKEN = result.refresh_token || "";
        return {
          content: [{
            type: "text",
            text: `✅ ¡Cuenta conectada exitosamente!\n\nTu cuenta de Mercado Libre está vinculada. El token dura 6 horas y se renueva automáticamente mientras el servidor esté corriendo.\n\nYa podés preguntarme sobre tus ventas, publicaciones, preguntas y más.`
          }]
        };
      } else {
        return {
          content: [{
            type: "text",
            text: `❌ Error al conectar: ${result.message || JSON.stringify(result)}\n\nEl código puede haber expirado. Generá uno nuevo abriendo esta URL:\nhttps://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=${CONFIG.CLIENT_ID}&redirect_uri=https%3A%2F%2Fwww.google.com`
          }]
        };
      }
    }

    // ── VER VENTAS ──
    if (name === "ver_ventas") {
      const limite = Math.min(args?.limite || 20, 50);
      const data = await meliGet(`/orders/search?seller=${CONFIG.USER_ID}&sort=date_desc&limit=${limite}`);
      const orders = data.results || [];

      if (!orders.length) return { content: [{ type: "text", text: "No se encontraron órdenes." }] };

      const totalIngresos = orders
        .filter(o => o.status === "paid")
        .reduce((s, o) => s + (o.total_amount || 0), 0);

      const pagas = orders.filter(o => o.status === "paid").length;

      let texto = `📦 **Últimas ${orders.length} órdenes — Noor Kids**\n\n`;
      texto += `💰 Ingresos totales: $${totalIngresos.toLocaleString("es-AR")} ARS\n`;
      texto += `✅ Pagas: ${pagas} | Total: ${orders.length}\n\n`;
      texto += `---\n\n`;

      orders.forEach((o, i) => {
        const fecha = new Date(o.date_created).toLocaleDateString("es-AR");
        const articulo = o.order_items?.[0]?.item?.title || "—";
        const total = (o.total_amount || 0).toLocaleString("es-AR");
        const estado = o.status === "paid" ? "✅" : o.status === "cancelled" ? "❌" : "⏳";
        texto += `${estado} **${fecha}** — ${articulo.slice(0, 50)}\n`;
        texto += `   Comprador: ${o.buyer?.nickname || "—"} | $${total} ARS\n\n`;
      });

      return { content: [{ type: "text", text: texto }] };
    }

    // ── VER PUBLICACIONES ──
    if (name === "ver_publicaciones") {
      const search = await meliGet(`/users/${CONFIG.USER_ID}/items/search?limit=50`);
      const ids = search.results || [];

      if (!ids.length) return { content: [{ type: "text", text: "No se encontraron publicaciones." }] };

      const items = [];
      // Buscar en batches de 20
      for (let i = 0; i < Math.min(ids.length, 20); i += 20) {
        const batch = ids.slice(i, i + 20).join(",");
        const res = await meliGet(`/items?ids=${batch}`);
        (res || []).forEach(r => r.body && items.push(r.body));
      }

      const activas = items.filter(i => i.status === "active").length;
      const totalVendidas = items.reduce((s, i) => s + (i.sold_quantity || 0), 0);

      let texto = `🏷️ **Publicaciones Noor Kids** (${ids.length} total)\n\n`;
      texto += `✅ Activas: ${activas} | 📦 Unidades vendidas: ${totalVendidas}\n\n---\n\n`;

      items.forEach(item => {
        const estado = item.status === "active" ? "✅" : item.status === "paused" ? "⏸️" : "❌";
        const precio = (item.price || 0).toLocaleString("es-AR");
        texto += `${estado} **${item.title || "—"}**\n`;
        texto += `   Precio: $${precio} | Stock: ${item.available_quantity ?? "—"} | Vendidas: ${item.sold_quantity || 0}\n\n`;
      });

      return { content: [{ type: "text", text: texto }] };
    }

    // ── VER PREGUNTAS ──
    if (name === "ver_preguntas") {
      const data = await meliGet(`/questions/search?seller_id=${CONFIG.USER_ID}&limit=50&sort_fields=date_created&sort_types=DESC`);
      let preguntas = data.questions || [];

      if (args?.solo_sin_responder) {
        preguntas = preguntas.filter(q => q.status === "UNANSWERED");
      }

      if (!preguntas.length) return { content: [{ type: "text", text: args?.solo_sin_responder ? "¡No tenés preguntas sin responder! 🎉" : "No se encontraron preguntas." }] };

      const sinResponder = preguntas.filter(q => q.status === "UNANSWERED").length;

      let texto = `💬 **Preguntas de compradores** (${preguntas.length} total)\n`;
      texto += `⚠️ Sin responder: ${sinResponder}\n\n---\n\n`;

      preguntas.forEach(q => {
        const fecha = new Date(q.date_created).toLocaleDateString("es-AR");
        const estado = q.status === "ANSWERED" ? "✅" : "⚠️ SIN RESPONDER";
        texto += `${estado} — ${fecha}\n`;
        texto += `**Pregunta:** ${q.text}\n`;
        if (q.answer) texto += `**Tu respuesta:** ${q.answer.text}\n`;
        texto += `\n`;
      });

      return { content: [{ type: "text", text: texto }] };
    }

    // ── VER REPUTACION ──
    if (name === "ver_reputacion") {
      const me = await meliGet(`/users/${CONFIG.USER_ID}`);
      const rep = me.seller_reputation;
      const metrics = rep?.metrics;

      let texto = `⭐ **Reputación de Noor Kids**\n\n`;
      texto += `Nivel: ${rep?.level_id || "—"}\n`;
      texto += `Ventas completadas: ${rep?.transactions?.completed || 0}\n`;
      texto += `Ventas canceladas: ${rep?.transactions?.canceled || 0}\n\n`;
      texto += `📊 **Métricas (últimos 365 días)**\n`;
      texto += `Ventas: ${metrics?.sales?.completed || 0}\n`;
      texto += `Reclamos: ${metrics?.claims?.value || 0} (${((metrics?.claims?.rate || 0) * 100).toFixed(1)}%)\n`;
      texto += `Cancelaciones: ${metrics?.cancellations?.value || 0}\n`;
      texto += `Entregas demoradas: ${metrics?.delayed_handling_time?.value || 0}\n`;

      return { content: [{ type: "text", text: texto }] };
    }

    // ── RESUMEN NEGOCIO ──
    if (name === "resumen_negocio") {
      const [ordersData, pubData, pregsData, meData] = await Promise.all([
        meliGet(`/orders/search?seller=${CONFIG.USER_ID}&sort=date_desc&limit=50`),
        meliGet(`/users/${CONFIG.USER_ID}/items/search?limit=50`),
        meliGet(`/questions/search?seller_id=${CONFIG.USER_ID}&limit=50`),
        meliGet(`/users/${CONFIG.USER_ID}`)
      ]);

      const orders = ordersData.results || [];
      const pagas = orders.filter(o => o.status === "paid");
      const ingresoTotal = pagas.reduce((s, o) => s + (o.total_amount || 0), 0);
      const sinResponder = (pregsData.questions || []).filter(q => q.status === "UNANSWERED").length;

      // Productos más vendidos
      const conteo = {};
      orders.forEach(o => {
        const titulo = o.order_items?.[0]?.item?.title || "Desconocido";
        conteo[titulo] = (conteo[titulo] || 0) + 1;
      });
      const topProductos = Object.entries(conteo)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);

      let texto = `📊 **RESUMEN NOOR KIDS**\n`;
      texto += `═══════════════════════\n\n`;
      texto += `💰 **Ingresos** (últimas 50 órdenes)\n`;
      texto += `   Total: $${ingresoTotal.toLocaleString("es-AR")} ARS\n`;
      texto += `   Órdenes pagas: ${pagas.length} de ${orders.length}\n\n`;
      texto += `🏷️ **Publicaciones**: ${pubData.results?.length || 0}\n\n`;
      texto += `💬 **Preguntas sin responder**: ${sinResponder}\n\n`;
      texto += `🏆 **Top 3 productos más vendidos**\n`;
      topProductos.forEach(([titulo, cant], i) => {
        texto += `   ${i + 1}. ${titulo.slice(0, 45)} (${cant} ventas)\n`;
      });
      texto += `\n⭐ **Reputación**: ${meData.seller_reputation?.level_id || "—"}\n`;
      texto += `   Ventas históricas: ${meData.seller_reputation?.transactions?.completed || 0}\n`;

      return { content: [{ type: "text", text: texto }] };
    }

    return { content: [{ type: "text", text: `Herramienta desconocida: ${name}` }] };

  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `❌ Error: ${error.message}\n\nSi el token expiró, generá un nuevo código en:\nhttps://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=${CONFIG.CLIENT_ID}&redirect_uri=https%3A%2F%2Fwww.google.com\n\nDespués usá la herramienta 'conectar_cuenta' con ese código.`
      }]
    };
  }
});

// Iniciar servidor
const transport = new StdioServerTransport();
await server.connect(transport);
