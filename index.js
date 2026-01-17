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

// Tratamento da lista de canais
const RAW_CHANNELS = process.env.TARGET_CHANNELS ? process.env.TARGET_CHANNELS.split(',') : [];
const TARGET_CHANNELS = RAW_CHANNELS.map(c => c.trim()).filter(c => c.length > 0);

// Server Healthcheck
const server = http.createServer((req, res) => { res.writeHead(200); res.end('Ofertizz Debugger Active 🕵️'); });
server.listen(process.env.PORT || 3000, () => console.log(`Healthcheck port: ${process.env.PORT || 3000}`));

(async () => {
  console.log("🕵️ Iniciando Modo Sherlock Holmes (Debug Total)...");

  if (!sessionString) { console.error("❌ Sem Session String"); process.exit(1); }

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    useWSS: false, 
  });

  await client.start({ onError: (err) => console.log("Erro conexão:", err) });
  console.log("✅ Conectado!");

  // --- 1. PROVA DE VIDA ---
  try {
      await client.sendMessage("me", { message: "🤖 Ofertizz Bot Iniciado! Estou online." });
      console.log("📨 Mensagem de teste enviada para 'Mensagens Salvas'. Verifique seu Telegram!");
  } catch (e) {
      console.error("❌ Falha ao enviar mensagem de teste:", e);
  }

  // --- 2. RESOLUÇÃO DE CANAIS ---
  // Vamos criar um mapa de IDs para verificar, mas NÃO vamos filtrar no Listener ainda
  const watchList = new Set();
  
  console.log(`🔎 IDs esperados para os canais configurados:`);
  for (const channel of TARGET_CHANNELS) {
      try {
          const entity = await client.getEntity(channel);
          watchList.add(entity.id.toString());
          console.log(`   🎯 ${channel} -> ID Puro: ${entity.id.toString()} | ID Channel: -100${entity.id.toString()}`);
      } catch (error) {
          console.error(`   ❌ Não encontrei: ${channel}`);
      }
  }

  console.log("👂 Ouvindo TUDO (DMs, Grupos, Canais)... Prepare-se para os logs!");

  // --- 3. LISTENER SEM FILTRO (PEGA TUDO) ---
  client.addEventHandler(async (event) => {
    const message = event.message;
    if (!message) return;

    // Dados da mensagem
    const text = message.text || message.caption || "";
    const chatId = message.chatId ? message.chatId.toString() : "N/A";
    
    // Tenta pegar o nome do remetente/canal
    let chatName = "Desconhecido";
    try {
        const chat = await message.getChat();
        chatName = chat.title || chat.username || "Privado";
    } catch(e) {}

    // LOG DE DEBUG: Mostra tudo que chega para descobrirmos o ID correto
    console.log(`📡 [EVENTO RECEBIDO] De: ${chatName} (ID: ${chatId}) | Texto: "${text.substring(0, 20)}..."`);

    // VERIFICAÇÃO SE É UM DOS NOSSOS
    // Verifica ID puro ou com prefixo -100 (comum em canais)
    const isTarget = watchList.has(chatId) || 
                     watchList.has(chatId.replace('-100', ''));

    if (isTarget) {
        console.log("🔥 É UM CANAL ALVO! Processando...");
        
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        if (urlRegex.test(text)) {
            const extractedUrls = text.match(urlRegex);
            const targetUrl = extractedUrls ? extractedUrls[0] : null;

            if (targetUrl && supabaseFunctionUrl) {
                try {
                    console.log(`   🚀 Enviando oferta para Supabase: ${targetUrl}`);
                    await axios.post(supabaseFunctionUrl, {
                        url: targetUrl,
                        raw_text: text,
                        source_channel: chatName
                    }, {
                        headers: { 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' }
                    });
                    console.log("   ✅ Sucesso!");
                } catch (err) {
                    console.error("   ❌ Erro Supabase:", err.message);
                }
            } else {
                console.log("   ⚠️ Link não encontrado ou URL Supabase ausente.");
            }
        } else {
            console.log("   ⚠️ Mensagem sem link.");
        }
    } else {
        // Se não for alvo, apenas ignora (mas já logamos lá em cima que chegou)
    }

  }, new NewMessage({ incoming: true }));

})();
