const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const axios = require("axios");
const http = require("http");

// --- CONFIGURAÇÕES ---
const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionString = process.env.TELEGRAM_SESSION;
const supabaseFunctionUrl = process.env.SUPABASE_INGEST_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

const RAW_CHANNELS = process.env.TARGET_CHANNELS ? process.env.TARGET_CHANNELS.split(',') : [];
const TARGET_CHANNELS = RAW_CHANNELS.map(c => c.trim()).filter(c => c.length > 0);

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Ofertizz Listener Active 🎧');
});
server.listen(process.env.PORT || 3000, () => console.log(`Healthcheck port: ${process.env.PORT || 3000}`));

(async () => {
  console.log("🚀 Iniciando Ofertizz Listener v3.0 (Global Watch)...");

  if (!sessionString) {
      console.error("❌ CRÍTICO: TELEGRAM_SESSION não encontrada.");
      process.exit(1);
  }

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    useWSS: false, 
  });

  await client.start({ onError: (err) => console.log("Erro conexão:", err) });
  console.log("✅ Cliente conectado!");

  // --- MAPEAR IDs ---
  // Vamos criar um mapa de IDs -> Nomes para verificação rápida
  const monitoredIds = new Set();
  
  console.log(`🔎 Resolvendo ${TARGET_CHANNELS.length} canais...`);
  for (const channel of TARGET_CHANNELS) {
      try {
          const entity = await client.getEntity(channel);
          // O ID pode vir como BigInt, convertemos para String para comparar
          monitoredIds.add(entity.id.toString());
          // Alguns canais tem ID negativo no formato -100..., vamos garantir
          monitoredIds.add(`-100${entity.id.toString()}`); 
          console.log(`   ✅ Monitorando: ${channel} (ID: ${entity.id})`);
      } catch (error) {
          console.error(`   ❌ Falha ao encontrar canal: ${channel}`);
      }
  }

  console.log(`🎧 Escutando TUDO e filtrando pelos IDs mapeados...`);

  // --- EVENTO GLOBAL (Sem filtro de chats no construtor) ---
  client.addEventHandler(async (event) => {
    const message = event.message;
    if (!message || !message.chatId) return;

    // Verifica se o ID do chat está na nossa lista de monitorados
    // O chatID vem como BigInt, precisa converter para string
    const msgChatId = message.chatId.toString();
    
    // Verificação flexível (com e sem o prefixo -100 de canais)
    const isMonitored = monitoredIds.has(msgChatId) || 
                        monitoredIds.has(msgChatId.replace('-100', '')) ||
                        monitoredIds.has(`-100${msgChatId}`);

    if (isMonitored) {
        const text = message.text || message.caption || "";
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        
        if (urlRegex.test(text)) {
            // Tenta pegar nome do chat
            let chatName = "Canal Monitorado";
            try {
                const chat = await message.getChat();
                chatName = chat.title || chat.username || msgChatId;
            } catch(e) {}

            console.log(`⚡ OFERTA EM [${chatName}]: ${text.substring(0, 30).replace(/\n/g, ' ')}...`);

            const extractedUrls = text.match(urlRegex);
            const targetUrl = extractedUrls ? extractedUrls[0] : null;

            if (targetUrl && supabaseFunctionUrl) {
                try {
                    await axios.post(supabaseFunctionUrl, {
                        url: targetUrl,
                        raw_text: text,
                        source_channel: chatName
                    }, {
                        headers: { 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' }
                    });
                    console.log("   🚀 Enviado para Supabase.");
                } catch (err) {
                    console.error("   ❌ Erro envio Supabase:", err.message);
                }
            }
        }
    }
  }, new NewMessage({ incoming: true })); // Escuta tudo que chega

})();
