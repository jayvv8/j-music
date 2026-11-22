import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

import qrcode from 'qrcode-terminal';
import pino from 'pino';
import ytSearch from 'yt-search';
import express from 'express';

import fs from 'fs';
import path from 'path';

// ==============================
// J MUSIC - WHATSAPP MUSIC BOT
// ==============================

const PREFIX = '.';
const SESSION_DIR = './session';

// ==============================
// SERVIDOR HTTP PARA RENDER
// ==============================

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.status(200).send('🎵 J Music está funcionando.');
});

app.get('/status', (req, res) => {
  res.status(200).json({
    bot: 'J Music',
    status: 'online'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor HTTP activo en el puerto ${PORT}`);
});

// ==============================
// FUNCIONES
// ==============================

async function searchYouTube(query) {
  try {
    const results = await ytSearch(query);

    if (!results || !results.videos || results.videos.length === 0) {
      return null;
    }

    return results.videos;
  } catch (error) {
    console.error('Error buscando YouTube:', error);
    return null;
  }
}

// ==============================
// BOT
// ==============================

async function startBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['J Music', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('Escanea este QR con WhatsApp:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        console.log('J Music conectado correctamente.');
      }

      if (connection === 'close') {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        if (statusCode !== DisconnectReason.loggedOut) {
          console.log('Conexión cerrada. Reconectando...');
          startBot();
        } else {
          console.log('Sesión cerrada. Debes vincular WhatsApp nuevamente.');
        }
      }
    });

    // ==============================
    // MENSAJES
    // ==============================

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      const msg = messages[0];
      if (!msg || !msg.message) return;

      if (msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') return;

      const messageContent =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        '';

      const text = messageContent.trim();

      if (!text.startsWith(PREFIX)) return;

      const commandText = text.slice(PREFIX.length).trim();
      const args = commandText.split(/\s+/);
      const command = args.shift()?.toLowerCase();
      const query = args.join(' ');

      // ==============================
      // .HELP
      // ==============================

      if (command === 'help' || command === 'menu') {
        const menu = `
╭━━━〔 🎵 J MUSIC 〕━━━╮
┃
┃  🎧 COMANDOS MUSICALES
┃
┃  ${PREFIX}play <canción>
┃  ${PREFIX}ytsearch <canción>
┃  ${PREFIX}artist <artista>
┃  ${PREFIX}lyrics <canción>
┃  ${PREFIX}radio
┃  ${PREFIX}help
┃
╰━━━━━━━━━━━━━━━━━━╯
        `;

        await sock.sendMessage(jid, { text: menu }, { quoted: msg });
      }

      // ==============================
      // .PLAY
      // ==============================

      else if (command === 'play') {
        if (!query) {
          await sock.sendMessage(
            jid,
            { text: '🎵 Escribe el nombre de una canción.\nEjemplo: .play Bad Bunny' },
            { quoted: msg }
          );
          return;
        }

        await sock.sendMessage(
          jid,
          { text: '🔎 Buscando música...' },
          { quoted: msg }
        );

        const videos = await searchYouTube(query);

        if (!videos) {
          await sock.sendMessage(jid, {
            text: '❌ No encontré resultados.'
          });
          return;
        }

        const video = videos[0];

        const result = `
🎵 *J MUSIC*

🎧 *Título:* ${video.title}
👤 *Canal:* ${video.author?.name || 'Desconocido'}
⏱️ *Duración:* ${video.timestamp || 'Desconocida'}
🔗 *YouTube:* ${video.url}

        `;

        await sock.sendMessage(jid, {
          text: result
        }, { quoted: msg });
      }

      // ==============================
      // .YTSEARCH
      // ==============================

      else if (command === 'ytsearch') {
        if (!query) {
          await sock.sendMessage(
            jid,
            { text: '🔎 Escribe lo que deseas buscar.\nEjemplo: .ytsearch Romeo Santos' },
            { quoted: msg }
          );
          return;
        }

        const videos = await searchYouTube(query);

        if (!videos) {
          await sock.sendMessage(jid, {
            text: '❌ No encontré resultados.'
          });
          return;
        }

        const results = videos.slice(0, 5);

        let response = '🔎 *RESULTADOS DE YOUTUBE*\n\n';

        results.forEach((video, index) => {
          response += `
${index + 1}. 🎵 ${video.title}
👤 ${video.author?.name || 'Desconocido'}
⏱️ ${video.timestamp || 'Desconocido'}
🔗 ${video.url}

`;
        });

        await sock.sendMessage(jid, {
          text: response
        }, { quoted: msg });
      }

      // ==============================
      // .ARTIST
      // ==============================

      else if (command === 'artist') {
        if (!query) {
          await sock.sendMessage(
            jid,
            { text: '🎤 Escribe el nombre del artista.\nEjemplo: .artist Eladio Carrión' },
            { quoted: msg }
          );
          return;
        }

        const videos = await searchYouTube(`${query} canciones`);

        if (!videos) {
          await sock.sendMessage(jid, {
            text: '❌ No encontré canciones de ese artista.'
          });
          return;
        }

        let response = `🎤 *MÚSICA DE ${query.toUpperCase()}*\n\n`;

        videos.slice(0, 5).forEach((video, index) => {
          response += `
${index + 1}. 🎵 ${video.title}
⏱️ ${video.timestamp || 'Desconocido'}
🔗 ${video.url}

`;
        });

        await sock.sendMessage(jid, {
          text: response
        }, { quoted: msg });
      }

      // ==============================
      // .LYRICS
      // ==============================

      else if (command === 'lyrics') {
        if (!query) {
          await sock.sendMessage(
            jid,
            { text: '📝 Escribe el nombre de una canción.\nEjemplo: .lyrics Tití Me Preguntó' },
            { quoted: msg }
          );
          return;
        }

        await sock.sendMessage(
          jid,
          {
            text: `📝 La búsqueda de letras para *${query}* todavía no está activada en J Music.`
          },
          { quoted: msg }
        );
      }

      // ==============================
      // .RADIO
      // ==============================

      else if (command === 'radio') {
        const radioText = `
📻 *J MUSIC - RADIO*

Escucha emisoras en línea:

🌐 https://www.radio-browser.info/

🎵 Busca emisoras de todo el mundo.
        `;

        await sock.sendMessage(jid, {
          text: radioText
        }, { quoted: msg });
      }

      // ==============================
      // COMANDO DESCONOCIDO
      // ==============================

      else {
        await sock.sendMessage(
          jid,
          {
            text: `❌ Comando desconocido.\nEscribe ${PREFIX}help para ver los comandos.`
          },
          { quoted: msg }
        );
      }
    });

  } catch (error) {
    console.error('Error al iniciar J Music:', error);
  }
}

// ==============================
// INICIAR
// ==============================

startBot();
