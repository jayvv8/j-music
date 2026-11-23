
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

import qrcode from 'qrcode-terminal';
import pino from 'pino';
import ytSearch from 'yt-search';
import express from 'express';
import axios from 'axios';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const JAMENDO_CLIENT_ID = process.env.JAMENDO_CLIENT_ID;

app.get('/', (req, res) => {
  res.send('J Music is online!');
});

app.get('/status', (req, res) => {
  res.json({ status: 'online', bot: 'J Music' });
});

app.listen(PORT, () => {
  console.log(`J Music server running on port ${PORT}`);
});

async function searchYouTube(query) {
  const result = await ytSearch(query);
  return result.videos || [];
}

async function searchJamendo(query) {
  if (!JAMENDO_CLIENT_ID) {
    throw new Error('JAMENDO_CLIENT_ID no está configurado.');
  }

  const response = await axios.get(
    'https://api.jamendo.com/v3.0/tracks/',
    {
      params: {
        client_id: JAMENDO_CLIENT_ID,
        format: 'json',
        limit: 10,
        search: query,
        audioformat: 'mp31'
      },
      timeout: 20000
    }
  );

  const results = response.data?.results || [];

  return results.filter(track =>
    track.audiodownload_allowed === true &&
    track.id &&
    track.name
  );
}

async function sendJamendoAudio(sock, jid, msg, query, video) {
  const tracks = await searchJamendo(query);

  if (!tracks.length) {
    await sock.sendMessage(jid, {
      text:
        '❌ No encontré audio descargable en Jamendo para esta canción.\n\n' +
        (video
          ? `🎵 Resultado de YouTube:\n${video.title}\n${video.url}`
          : 'No encontré resultados de YouTube tampoco.')
    }, { quoted: msg });

    return;
  }

  const track = tracks[0];

  const downloadUrl =
    `https://api.jamendo.com/v3.0/tracks/file/` +
    `?client_id=${encodeURIComponent(JAMENDO_CLIENT_ID)}` +
    `&id=${encodeURIComponent(track.id)}` +
    `&audioformat=mp31&action=download`;

  const tempDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'jmusic-')
  );

  const inputFile = path.join(tempDir, 'input.mp3');
  const outputFile = path.join(tempDir, 'output.mp3');

  try {
    const response = await axios.get(downloadUrl, {
      responseType: 'stream',
      maxRedirects: 5,
      timeout: 60000
    });

    await pipeline(response.data, fs.createWriteStream(inputFile));

    await execFileAsync('ffmpeg', [
      '-y',
      '-i', inputFile,
      '-vn',
      '-acodec', 'libmp3lame',
      '-b:a', '128k',
      outputFile
    ]);

    const audio = await fsp.readFile(outputFile);

    await sock.sendMessage(jid, {
      audio,
      mimetype: 'audio/mpeg',
      fileName: `${track.name}.mp3`,
      ptt: false
    }, { quoted: msg });

    await sock.sendMessage(jid, {
      text:
        `🎵 *${track.name}*\n` +
        `👤 ${track.artist_name || 'Artista desconocido'}\n` +
        `💿 Fuente de audio: Jamendo\n` +
        `🔗 ${track.shareurl || ''}\n\n` +
        (video
          ? `🔎 *Resultado de YouTube:*\n${video.title}\n${video.url}`
          : 'No se encontró un resultado de YouTube.')
    }, { quoted: msg });

  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

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

.play <canción> - Buscar y enviar audio
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

        const videos = await searchYouTube(query);
        const video = videos[0] || null;

        if (video) {
          await sock.sendMessage(jid, {
            text:
              `🎬 *RESULTADO DE YOUTUBE*\n\n` +
              `🎵 ${video.title}\n` +
              `👤 ${video.author?.name || 'Desconocido'}\n` +
              `⏱️ ${video.timestamp || 'N/A'}\n` +
              `🔗 ${video.url}\n\n` +
              `🔎 Buscando audio descargable...`
          }, { quoted: msg });
        } else {
          await sock.sendMessage(jid, {
            text: '⚠️ No encontré en YouTube. Intentaré buscar el audio...'
          }, { quoted: msg });
        }

        await sendJamendoAudio(sock, jid, msg, query, video);
      }

      else if (command === '.ytsearch') {
        if (!query) {
          await sock.sendMessage(jid, {
            text: 'Escribe qué quieres buscar.\nEjemplo: .ytsearch Romeo Santos'
          }, { quoted: msg });
          return;
        }

        const videos = await searchYouTube(query);

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

        const videos = await searchYouTube(`${query} canciones`);

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

        const videos = await searchYouTube(`${query} lyrics`);
        const video = videos[0];

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
        execFile('ffmpeg', ['-version'], (error) => {
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
        text: '❌ Ocurrió un error ejecutando el comando: ' +
          (error.message || 'Error desconocido')
      }, { quoted: msg });
    }
  });
}

startBot().catch(err => {
  console.error('Error iniciando J Music:', err);
});
