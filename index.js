
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

import qrcode from 'qrcode-terminal';
import pino from 'pino';
import ytSearch from 'yt-search';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('J Music is online!');
});

app.get('/status', (req, res) => {
  res.json({ status: 'online', bot: 'J Music' });
});

app.listen(PORT, () => {
  console.log(`J Music server running on port ${PORT}`);
});

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./session');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['J Music', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Escanea este QR para conectar J Music:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('J Music conectado a WhatsApp');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;

      if (code !== DisconnectReason.loggedOut) {
        console.log('Conexión perdida. Reconectando...');
        startBot();
      } else {
        console.log('Sesión cerrada. Necesitas vincular nuevamente.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    if (!jid || jid.endsWith('@newsletter')) return;

    const messageContent =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '';

    const commandText = messageContent.trim();
    if (!commandText.startsWith('.')) return;

    const args = commandText.split(/\s+/);
    const command = args.shift().toLowerCase();
    const query = args.join(' ').trim();

    try {
      if (command === '.help') {
        await sock.sendMessage(jid, {
          text: `🎵 *J MUSIC*

Comandos disponibles:

.play <canción> - Buscar en YouTube
.ytsearch <canción> - Buscar videos
.artist <nombre> - Buscar artista
.lyrics <canción> - Buscar letras
.radio - Información de radio
.ffmpeg - Comprobar FFmpeg

Ejemplo:
.play Paz Mental`
        }, { quoted: msg });
      }

      else if (command === '.play') {
        if (!query) {
          await sock.sendMessage(jid, {
            text: 'Escribe una canción.\nEjemplo: .play Paz Mental'
          }, { quoted: msg });
          return;
        }

        await sock.sendMessage(jid, {
          text: `🔎 Buscando *${query}* en YouTube...`
        }, { quoted: msg });

        const result = await ytSearch(query);
        const videos = result.videos || [];

        if (!videos.length) {
          await sock.sendMessage(jid, {
            text: '❌ No encontré resultados en YouTube.'
          }, { quoted: msg });
          return;
        }

        const video = videos[0];

        await sock.sendMessage(jid, {
          text: `🎵 *RESULTADO DE YOUTUBE*

📌 *Título:* ${video.title}
👤 *Canal:* ${video.author?.name || 'Desconocido'}
⏱️ *Duración:* ${video.timestamp || 'Desconocida'}

🔗 ${video.url}

_Resultado de búsqueda de J Music._`
        }, { quoted: msg });
      }

      else if (command === '.ytsearch') {
        if (!query) {
          await sock.sendMessage(jid, {
            text: 'Escribe qué quieres buscar.\nEjemplo: .ytsearch Romeo Santos'
          }, { quoted: msg });
          return;
        }

        const result = await ytSearch(query);
        const videos = result.videos || [];

        if (!videos.length) {
          await sock.sendMessage(jid, {
            text: '❌ No encontré resultados.'
          }, { quoted: msg });
          return;
        }

        const list = videos.slice(0, 5).map((video, i) =>
          `${i + 1}. ${video.title}\n👤 ${video.author?.name || 'Desconocido'}\n⏱️ ${video.timestamp || 'N/A'}\n🔗 ${video.url}`
        ).join('\n\n');

        await sock.sendMessage(jid, {
          text: `🔎 *RESULTADOS DE YOUTUBE*\n\n${list}`
        }, { quoted: msg });
      }

      else if (command === '.artist') {
        if (!query) {
          await sock.sendMessage(jid, {
            text: 'Escribe el nombre de un artista.'
          }, { quoted: msg });
          return;
        }

        const result = await ytSearch(`${query} canciones`);
        const videos = result.videos || [];

        if (!videos.length) {
          await sock.sendMessage(jid, {
            text: '❌ No encontré resultados para ese artista.'
          }, { quoted: msg });
          return;
        }

        const list = videos.slice(0, 5).map((video, i) =>
          `${i + 1}. ${video.title}\n🔗 ${video.url}`
        ).join('\n\n');

        await sock.sendMessage(jid, {
          text: `🎤 *ARTISTA: ${query}*\n\n${list}`
        }, { quoted: msg });
      }

      else if (command === '.lyrics') {
        if (!query) {
          await sock.sendMessage(jid, {
            text: 'Escribe el nombre de una canción.'
          }, { quoted: msg });
          return;
        }

        const result = await ytSearch(`${query} lyrics`);
        const video = result.videos?.[0];

        await sock.sendMessage(jid, {
          text: video
            ? `📝 *BÚSQUEDA DE LETRAS*\n\n${query}\n\n🔎 Puedes buscar la letra aquí:\nhttps://genius.com/search?q=${encodeURIComponent(query)}\n\n🎵 Video relacionado:\n${video.url}`
            : `📝 Busca la letra aquí:\nhttps://genius.com/search?q=${encodeURIComponent(query)}`
        }, { quoted: msg });
      }

      else if (command === '.radio') {
        await sock.sendMessage(jid, {
          text: `📻 *J MUSIC RADIO*

La función de radio continua está en desarrollo.

Usa .play <canción> para buscar música.`
        }, { quoted: msg });
      }

      else if (command === '.ffmpeg') {
        const { execFile } = await import('node:child_process');

        execFile('ffmpeg', ['-version'], (error, stdout) => {
          if (error) {
            sock.sendMessage(jid, {
              text: '❌ FFmpeg no está disponible.'
            }, { quoted: msg });
            return;
          }

          sock.sendMessage(jid, {
            text: '✅ FFmpeg está instalado y funcionando.'
          }, { quoted: msg });
        });
      }

    } catch (error) {
      console.error('Error en comando:', error);

      await sock.sendMessage(jid, {
        text: '❌ Ocurrió un error ejecutando el comando.'
      }, { quoted: msg });
    }
  });
}

startBot().catch(err => {
  console.error('Error iniciando J Music:', err);
});
