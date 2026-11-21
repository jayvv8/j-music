
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';

import qrcode from 'qrcode-terminal';
import pino from 'pino';
import yts from 'yt-search';

const PREFIX = '.';
let reconnecting = false;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./session');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['J Music', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Escanea el QR para conectar J Music:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconnecting = false;
      console.log('🎵 J MUSIC CONECTADO');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;

      if (code === DisconnectReason.loggedOut) {
        console.log('Sesión cerrada. Vincula WhatsApp nuevamente.');
      } else if (!reconnecting) {
        reconnecting = true;
        console.log('Reconectando J Music...');
        setTimeout(() => {
          reconnecting = false;
          startBot();
        }, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      if (!text.startsWith(PREFIX)) continue;

      const parts = text.slice(PREFIX.length).trim().split(/\s+/);
      const command = parts.shift()?.toLowerCase();
      const query = parts.join(' ').trim();

      try {
        if (command === 'help' || command === 'menu') {
          await sock.sendMessage(jid, {
            text:
              `╭━━━ 🎵 *J MUSIC* 🎵 ━━━╮\n\n` +
              `🎧 .play <canción>\n` +
              `🔎 .ytsearch <canción>\n` +
              `📝 .lyrics <artista - canción>\n` +
              `🎤 .artist <artista>\n` +
              `📻 .radio\n` +
              `ℹ️ .help\n\n` +
              `╰━━━ 🎶 MUSIC BOT ━━━╯`
          }, { quoted: msg });
        }

        else if (command === 'play' || command === 'ytsearch') {
          if (!query) {
            await sock.sendMessage(jid, {
              text: `Escribe una canción.\nEjemplo: ${PREFIX}play Aventura Obsesión`
            }, { quoted: msg });
            continue;
          }

          await sock.sendMessage(jid, {
            text: '🔎 Buscando música...'
          }, { quoted: msg });

          const results = await yts(query);
          const videos = results.videos.slice(0, 5);

          if (!videos.length) {
            await sock.sendMessage(jid, {
              text: '❌ No encontré resultados.'
            }, { quoted: msg });
            continue;
          }

          let answer = `🎵 *RESULTADOS MUSICALES*\n\n`;

          videos.forEach((video, i) => {
            answer +=
              `*${i + 1}. ${video.title}*\n` +
              `👤 ${video.author.name}\n` +
              `⏱️ ${video.timestamp || 'Desconocido'}\n` +
              `🔗 ${video.url}\n\n`;
          });

          await sock.sendMessage(jid, {
            text: answer.trim()
          }, { quoted: msg });
        }

        else if (command === 'artist') {
          if (!query) {
            await sock.sendMessage(jid, {
              text: 'Escribe un artista.\nEjemplo: .artist Romeo Santos'
            }, { quoted: msg });
            continue;
          }

          const results = await yts(query);
          const videos = results.videos.slice(0, 5);

          let answer = `🎤 *BÚSQUEDA: ${query}*\n\n`;

          for (const video of videos) {
            answer += `🎵 ${video.title}\n🔗 ${video.url}\n\n`;
          }

          await sock.sendMessage(jid, {
            text: answer || 'No encontré resultados.'
          }, { quoted: msg });
        }

        else if (command === 'lyrics') {
          await sock.sendMessage(jid, {
            text:
              `📝 Para buscar letras, usa un servicio de letras autorizado.\n\n` +
              `🔎 Búsqueda: ${query || 'No especificada'}`
          }, { quoted: msg });
        }

        else if (command === 'radio') {
          await sock.sendMessage(jid, {
            text:
              `📻 *RADIO MUSICAL*\n\n` +
              `Explora emisoras musicales online:\n` +
              `https://www.radio-browser.info/\n\n` +
              `🎶 Puedes buscar emisoras por género y país.`
          }, { quoted: msg });
        }

      } catch (error) {
        console.error('Error:', error);

        await sock.sendMessage(jid, {
          text: '❌ Ocurrió un error al ejecutar el comando.'
        }, { quoted: msg });
      }
    }
  });
}

startBot().catch(console.error);
