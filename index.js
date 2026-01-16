const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const axios = require("axios");
const http = require("http");

// --- CONFIGURAÇÕES (Variáveis de Ambiente do Coolify) ---
const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionString = process.env.TELEGRAM_SESSION; // A string que você gerou localmente
const supabaseFunctionUrl = process.env.SUPABASE_INGEST_URL; // URL da Edge Function que vamos criar
const supabaseKey = process.env.SUPABASE_ANON_KEY;

// Lista de Canais/Grupos para Monitorar (Usernames ou IDs)
// Exemplo: 'promocoesninja', 'gatry', etc.
const TARGET_CHANNELS = process.env.TARGET_CHANNELS ? process.env.TARGET_CHANNELS.split(',') : [];

// --- SERVIDOR HTTP SIMPLE (Para Healthcheck do Coolify) ---
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Ofertizz Listener is Running 🎧');
});
server.listen(process.env.PORT || 3000, () => {
    console.log(`Web server listening on port ${process.env.PORT || 3000}`);
});

// --- LÓGICA DO TELEGRAM ---
(async () => {
  console.log("🚀 Iniciando Ofertizz Listener...");

  if (!sessionString) {
      console.error("❌ ERRO: Variável TELEGRAM_SESSION não encontrada.");
      return;
  }

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
      onError: (err) => console.log("Erro de conexão:", err)
  });

  console.log("✅ Conectado ao Telegram com sucesso!");
  console.log(`🎧 Monitorando canais: ${TARGET_CHANNELS.join(', ')}`);

  // Evento: Nova Mensagem
  client.addEventHandler(async (event) => {
    const message = event.message;
    const text = message.text || message.caption || "";
    
    // Filtro Básico: A mensagem tem link HTTP/HTTPS?
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const hasLink = urlRegex.test(text);

    if (hasLink) {
      console.log(`⚡ Oferta detectada em ${message.chatId}: ${text.substring(0, 50)}...`);

      // Extrai o primeiro link encontrado
      const extractedUrls = text.match(urlRegex);
      const targetUrl = extractedUrls ? extractedUrls[0] : null;

      if (targetUrl) {
          try {
            // Envia para o Supabase processar (Edge Function 'ingest-offer')
            // Se a function ainda não existir, vai dar erro 404, mas o listener continua vivo.
            if (supabaseFunctionUrl) {
                await axios.post(supabaseFunctionUrl, {
                    url: targetUrl,
                    raw_text: text,
                    source_channel: message.chatId.toString()
                }, {
                    headers: { 
                        'Authorization': `Bearer ${supabaseKey}`,
                        'Content-Type': 'application/json' 
                    }
                });
                console.log("📤 Link enviado para o Cérebro (Supabase).");
            } else {
                console.log("⚠️ URL do Supabase não configurada, apenas logando.");
            }
          } catch (err) {
            console.error("❌ Erro ao enviar para Supabase:", err.message);
          }
      }
    }
  }, new NewMessage({ chats: TARGET_CHANNELS }));

})();
