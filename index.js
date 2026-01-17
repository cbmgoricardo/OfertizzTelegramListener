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
  console.log("🚀 Iniciando Ofertizz Listener v2.0...");

  if (!sessionString) {
      console.error("❌ CRÍTICO: TELEGRAM_SESSION não encontrada.");
      process.exit(1);
  }

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    useWSS: false, // Força TCP para maior estabilidade em VPS
  });

  await client.start({ onError: (err) => console.log("Erro conexão:", err) });
  console.log("✅ Cliente conectado!");

  // --- RESOLUÇÃO DE CANAIS (A Mágica Acontece Aqui) ---
  const resolvedChats = [];
  console.log(`🔎 Resolvendo ${TARGET_CHANNELS.length} canais...`);

  for (const channel of TARGET_CHANNELS) {
      try {
          // Busca a entidade pelo username para pegar o ID real
          const entity = await client.getEntity(channel);
          resolvedChats.push(entity);
          console.log(`   ✅ Canal encontrado: ${channel} (ID: ${entity.id})`);
      } catch (error) {
          console.error(`   ❌ Falha ao encontrar canal: ${channel}. Verifique se o username está correto ou se o canal é público.`);
      }
  }

  if (resolvedChats.length === 0) {
      console.error("⚠️ NENHUM canal válido encontrado. O bot não vai escutar nada.");
  } else {
      console.log(`🎧 Monitorando ${resolvedChats.length} canais confirmados.`);
      
      // Adiciona o Handler usando as entidades resolvidas
      client.addEventHandler(async (event) => {
        const message = event.message;
        const text = message.text || message.caption || "";
        
        // Regex aprimorada para capturar qualquer link HTTP/HTTPS
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const hasLink = urlRegex.test(text);

        if (hasLink) {
          // Extrai o nome do canal para log (tenta pegar title ou username)
          const chatTitle = message.chat ? (message.chat.title || message.chat.username) : "Desconhecido";
          console.log(`⚡ Oferta em [${chatTitle}]: ${text.substring(0, 40).replace(/\n/g, ' ')}...`);

          const extractedUrls = text.match(urlRegex);
          // Pega o primeiro link que encontrar
          const targetUrl = extractedUrls ? extractedUrls[0] : null;

          if (targetUrl && supabaseFunctionUrl) {
              try {
                await axios.post(supabaseFunctionUrl, {
                    url: targetUrl,
                    raw_text: text,
                    source_channel: chatTitle
                }, {
                    headers: { 
                        'Authorization': `Bearer ${supabaseKey}`,
                        'Content-Type': 'application/json' 
                    }
                });
                console.log("   🚀 Enviado para Supabase com sucesso.");
              } catch (err) {
                console.error("   ❌ Erro Supabase:", err.response ? err.response.data : err.message);
              }
          }
        }
      }, new NewMessage({ chats: resolvedChats })); // Usa a lista de objetos resolvidos
  }
})();
