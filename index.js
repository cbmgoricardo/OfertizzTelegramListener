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

// Cache para evitar duplicidade no polling
const PROCESSED_IDS = new Set();

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Ofertizz Hybrid Listener Active 🎧');
});
server.listen(process.env.PORT || 3000, () => console.log(`Healthcheck port: ${process.env.PORT || 3000}`));

(async () => {
  console.log("🚀 Iniciando Ofertizz Listener HÍBRIDO (Event + Polling)...");

  if (!sessionString) { console.error("❌ Sem Session String"); process.exit(1); }

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    useWSS: false, 
  });

  await client.start({ onError: (err) => console.log("Erro conexão:", err) });
  console.log("✅ Conectado!");

  // --- 1. RESOLVER E MAPEAR ENTIDADES ---
  const channelEntities = [];
  
  console.log(`🔎 Resolvendo canais para monitoramento...`);
  for (const channel of TARGET_CHANNELS) {
      try {
          const entity = await client.getEntity(channel);
          channelEntities.push(entity);
          console.log(`   ✅ Alvo confirmado: ${channel} (ID: ${entity.id})`);
      } catch (error) {
          console.error(`   ❌ Erro ao resolver: ${channel}`, error.message);
      }
  }

  // --- FUNÇÃO DE PROCESSAMENTO CENTRALIZADA ---
  async function processMessage(message) {
      if (!message || !message.id) return;
      
      // Evita processar a mesma mensagem duas vezes (Event + Polling)
      const uniqueId = `${message.chatId}_${message.id}`;
      if (PROCESSED_IDS.has(uniqueId)) return;
      PROCESSED_IDS.add(uniqueId);
      
      // Limpa cache antigo para não estourar memória
      if (PROCESSED_IDS.size > 5000) {
          const it = PROCESSED_IDS.values();
          for(let i=0; i<1000; i++) PROCESSED_IDS.delete(it.next().value);
      }

      const text = message.text || message.caption || "";
      const urlRegex = /(https?:\/\/[^\s]+)/g;

      if (urlRegex.test(text)) {
          console.log(`⚡ OFERTA DETECTADA: "${text.substring(0, 30)}..."`);
          
          if (supabaseFunctionUrl) {
              const extractedUrls = text.match(urlRegex);
              const targetUrl = extractedUrls ? extractedUrls[0] : null;
              
              // Tenta pegar nome do chat
              let chatName = "Canal Monitorado";
              try {
                  const chat = await message.getChat();
                  chatName = chat.title || chat.username;
              } catch(e){}

              // [NOVO] Extração de Imagem do Preview (WebPage)
              let imageUrl = null;
              if (message.media && message.media.webpage && message.media.webpage.photo) {
                  // Tenta pegar a URL da foto do preview se disponível (API Telegram retorna objetos complexos aqui)
                  // Nota: Extrair URL direta de media Telegram requer download/upload. 
                  // Mas se for WebPage, às vezes temos a url original.
                  if (message.media.webpage.url && (message.media.webpage.type === 'photo' || message.media.webpage.siteName)) {
                       // Em muitos casos o webPage.url é o link da oferta, não da imagem.
                       // A URL da imagem direta nem sempre vem limpa no objeto raw.
                       // Focaremos em enviar o link para o backend fazer o trabalho pesado, 
                       // mas se houver um campo explícito de imagem externa, pegamos.
                  }
              }

              // Como extrair URL de imagem do Telegram Client é complexo (requer download), 
              // vamos confiar que o backend fará o scraping. 
              // PORÉM, se você quiser enviar uma imagem JÁ HOSPEDADA, precisaria baixar e subir.
              // Para manter a leveza do Listener, vamos enviar apenas os dados de texto.
              
              // SE o link já for uma imagem direta (jpg/png), mandamos como image_url
              if (targetUrl.match(/\.(jpeg|jpg|gif|png)$/) != null) {
                  imageUrl = targetUrl;
              }

              try {
                  await axios.post(supabaseFunctionUrl, {
                      url: targetUrl,
                      raw_text: text,
                      source_channel: chatName,
                      image_url: imageUrl // Envia se detectou link direto de imagem
                  }, {
                      headers: { 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' }
                  });
                  console.log("   🚀 Enviado para Supabase!");
              } catch (err) {
                  console.error("   ❌ Erro envio:", err.message);
              }
          }
      }
  }

  // --- ESTRATÉGIA A: EVENTO EM TEMPO REAL ---
  client.addEventHandler(async (event) => {
      // Filtra apenas se vier dos canais monitorados
      if (event.message && channelEntities.some(e => e.id.toString() === event.message.chatId?.toString())) {
          await processMessage(event.message);
      }
  }, new NewMessage({ incoming: true }));

  // --- ESTRATÉGIA B: POLLING ATIVO (BACKUP) ---
  console.log("🔄 Iniciando Polling de Backup (a cada 30s)...");
  
  setInterval(async () => {
      for (const entity of channelEntities) {
          try {
              // Pega as últimas 3 mensagens do canal
              const messages = await client.getMessages(entity, { limit: 3 });
              for (const msg of messages) {
                  await processMessage(msg);
              }
          } catch (e) {
              console.error(`Erro no polling de ${entity.id}:`, e.message);
          }
      }
  }, 30000); // Roda a cada 30s
})();
