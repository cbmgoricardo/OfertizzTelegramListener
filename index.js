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

// Tratamento robusto da lista de canais (Remove espaços e itens vazios)
const RAW_CHANNELS = process.env.TARGET_CHANNELS ? process.env.TARGET_CHANNELS.split(',') : [];
const TARGET_CHANNELS = RAW_CHANNELS.map(c => c.trim()).filter(c => c.length > 0);

// --- SERVIDOR HEALTHCHECK ---
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Ofertizz Listener Active 🎧');
});
server.listen(process.env.PORT || 3000, () => console.log(`Healthcheck port: ${process.env.PORT || 3000}`));

// --- LÓGICA DO BOT ---
(async () => {
  console.log("🚀 Iniciando Ofertizz Listener v2.1 (Fix IDs)...");

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

  // --- RESOLUÇÃO DE CANAIS ---
  const resolvedIds = []; // Mudança de nome para deixar claro
  console.log(`🔎 Resolvendo ${TARGET_CHANNELS.length} canais...`);

  for (const channel of TARGET_CHANNELS) {
      try {
          const entity = await client.getEntity(channel);
          // --- CORREÇÃO AQUI: Pegamos apenas o ID ---
          resolvedIds.push(entity.id); 
          console.log(`   ✅ Canal monitorado: ${channel} (ID: ${entity.id})`);
      } catch (error) {
          console.error(`   ❌ Falha ao encontrar canal: ${channel}.`);
      }
  }

  if (resolvedIds.length === 0) {
      console.error("⚠️ NENHUM canal válido encontrado.");
  } else {
      console.log(`🎧 Escutando ${resolvedIds.length} canais...`);
      
      // Adiciona o Handler usando APENAS os IDs
      client.addEventHandler(async (event) => {
        const message = event.message;
        const text = message.text || message.caption || "";
        
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const hasLink = urlRegex.test(text);

        if (hasLink) {
          // Tenta pegar o nome do chat de forma segura
          let chatName = "Desconhecido";
          try {
             const chat = await message.getChat();
             chatName = chat.title || chat.username || message.chatId.toString();
          } catch(e) {}

          console.log(`⚡ Oferta em [${chatName}]: ${text.substring(0, 30).replace(/\n/g, ' ')}...`);

          const extractedUrls = text.match(urlRegex);
          const targetUrl = extractedUrls ? extractedUrls[0] : null;

          if (targetUrl && supabaseFunctionUrl) {
              try {
                await axios.post(supabaseFunctionUrl, {
                    url: targetUrl,
                    raw_text: text,
                    source_channel: chatName
                }, {
                    headers: { 
                        'Authorization': `Bearer ${supabaseKey}`,
                        'Content-Type': 'application/json' 
                    }
                });
                console.log("   🚀 Enviado para Supabase.");
              } catch (err) {
                console.error("   ❌ Erro Supabase:", err.response ? err.response.data : err.message);
              }
          }
        }
      }, new NewMessage({ chats: resolvedIds })); // Passando array de IDs agora
  }
})();
