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

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

// ======================================
// J MUSIC
// ======================================

const PREFIX = '.';
const SESSION_DIR = './session';

// ======================================
// SERVIDOR PARA RENDER
// ======================================

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

// ======================================
// BÚSQUEDA YOUTUBE
// ======================================

async function searchYouTube(query) {
  try {
    const results = await ytSearch(query);

    if (!results?.videos?.length) return null;

    return results.videos;
  } catch (error) {
    console.error('Error buscando YouTube:', error);
    return null;
  }
}

// ======================================
// BÚSQUEDA EN INTERNET ARCHIVE
// ======================================

async function searchArchive(query) {
  try {
    const response = await axios.get(
      'https://archive.org/advancedsearch.php',
      {
        params: {
          q: `title:"${query}" AND mediatype:audio`,
          'fl[]': ['identifier', 'title', 'creator'],
          rows: 10,
          page: 1,
          output: 'json'
        },
        timeout: 20000
      }
    );

    return response.data?.response?.docs || [];
  } catch (error) {
    console.error('Error buscando Archive:', error.message);
    return [];
  }
}

// ======================================
// OBTENER AUDIO DESCARGABLE
// ======================================

async function getArchiveAudio(identifier) {
  try {
    const response = await axios.get(
      `https://archive.org/metadata/${encodeURIComponent(identifier)}`,
      { timeout: 20000 }
    );

    const files = response.data?.files || [];

    const audioFiles = files.filter(file => {
      const name = String(file.name || '').toLowerCase();
      const format = String(file.format || '').toLowerCase();

      return (
        name.endsWith('.mp3') &&
        format.includes('mp3') &&
        !file.source
      );
    });

    if (!audioFiles.length) return null;

    // Elegir el archivo MP3 de menor tamaño razonable.
    const usable = audioFiles
      .filter(file => Number(file.size || 0) > 0)
      .sort((a, b) => Number(a.size) - Number(b.size));

    return usable[0] || audioFiles[0];
  } catch (error) {
    console.error('Error obteniendo audio:', error.message);
    return null;
  }
}

// ======================================
// DESCARGAR Y CONVERTIR A MP3
// ======================================

async function downloadAndConvert(identifier, filename) {
  const tempDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'jmusic-')
  );

  const inputPath = path.join(tempDir, 'audio-input');
  const outputPath = path.join(tempDir, 'audio.mp3');

  try {
    const downloadUrl =
      `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(filename)}`;

    const response = await axios.get(downloadUrl, {
      responseType: 'stream',
      timeout: 60000,
      maxRedirects: 5
    });

    await pipeline(response.data, fs.createWriteStream(inputPath));

    await new Promise((resolve, reject) => {
      execFile(
        'ffmpeg',
        [
          '-y',
          '-i', inputPath,
          '-vn',
          '-acodec', 'libmp3lame',
          '-b:a', '128k',
          outputPath
        ],
        { timeout: 120000 },
        (error) => {
          if (error) reject(error);
          else resolve();
        }
      );
    });

    return await fsp.readFile(outputPath);
  } finally {
    await fsp.rm(tempDir, {
      recursive: true,
      force: true
    }).catch(() => {});
  }
}

// ======================================
// INICIAR WHATSAPP
// ======================================

async function startBot() {
  try {
    const { state, saveCreds } =
      await useMultiFileAuthState(SESSION_DIR);

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['J Music', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false
    });

    sock.ev.on('creds.update', saveCreds);

    // ==================================
    // CONEXIÓN
    // ==================================

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('Escanea el QR con WhatsApp:');
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

          setTimeout(() => startBot(), 3000);
        } else {
          console.log('Sesión cerrada. Vincula WhatsApp nuevamente.');
        }
      }
    });

    // ==================================
    // MENSAJES
    // ==================================

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      const msg = messages[0];

      if (!msg?.message || msg.key.fromMe) return;

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

      // ==================================
      // .FFMPEG
      // ==================================

      if (command === 'ffmpeg') {
        execFile('ffmpeg', ['-version'], async (error, stdout) => {
          if (error) {
            await sock.sendMessage(jid, {
              text: '❌ FFmpeg no está instalado.'
            }, { quoted: msg });

            return;
          }

          await sock.sendMessage(jid, {
            text: `✅ FFmpeg funcionando.\n\n${stdout.split('\n')[0]}`
          }, { quoted: msg });
        });

        return;
      }

      // ==================================
      // .HELP
      // ==================================

      if (command === 'help' || command === 'menu') {
        const menu = `
╭━━━〔 🎵 J MUSIC 〕━━━╮
┃
┃ 🎧 COMANDOS
┃
┃ .play <canción>
┃ .ytsearch <canción>
┃ .artist <artista>
┃ .lyrics <canción>
┃ .radio
┃ .ffmpeg
┃ .help
┃
╰━━━━━━━━━━━━━━━━━━╯
        `;

        await sock.sendMessage(jid, {
          text: menu
        }, { quoted: msg });
      }

      // ==================================
      // .PLAY
      // ==================================

      else if (command === 'play') {
        if (!query) {
          await sock.sendMessage(jid, {
            text: '🎵 Escribe una canción.\nEjemplo: .play Paz Mental'
          }, { quoted: msg });

          return;
        }

        await sock.sendMessage(jid, {
          text: `🔎 Buscando *${query}*...`
        }, { quoted: msg });

        try {
          const results = await searchArchive(query);

          if (!results.length) {
            await sock.sendMessage(jid, {
              text: '❌ No encontré audio descargable para esa búsqueda.'
            }, { quoted: msg });

            return;
          }

          let selected = null;
          let selectedFile = null;

          for (const item of results.slice(0, 5)) {
            const file = await getArchiveAudio(item.identifier);

            if (file) {
              selected = item;
              selectedFile = file;
              break;
            }
          }

          if (!selected || !selectedFile) {
            await sock.sendMessage(jid, {
              text: '❌ No encontré un archivo MP3 descargable.'
            }, { quoted: msg });

            return;
          }

          if (
            Number(selectedFile.size || 0) >
            40 * 1024 * 1024
          ) {
            await sock.sendMessage(jid, {
              text: '❌ El archivo es demasiado grande para procesarlo aquí.'
            }, { quoted: msg });

            return;
          }

          await sock.sendMessage(jid, {
            text: '⬇️ Preparando el audio...'
          }, { quoted: msg });

          const audioBuffer = await downloadAndConvert(
            selected.identifier,
            selectedFile.name
          );

          if (audioBuffer.length > 40 * 1024 * 1024) {
            await sock.sendMessage(jid, {
              text: '❌ El MP3 convertido es demasiado grande.'
            }, { quoted: msg });

            return;
          }

          await sock.sendMessage(
            jid,
            {
              audio: audioBuffer,
              mimetype: 'audio/mpeg',
              fileName: `${query.replace(/[^\w\s-]/g, '').slice(0, 60)}.mp3`
            },
            { quoted: msg }
          );

        } catch (error) {
          console.error('Error en .play:', error);

          await sock.sendMessage(jid, {
            text: '❌ Ocurrió un error al obtener o procesar el audio.'
          }, { quoted: msg });
        }
      }

      // ==================================
      // .YTSEARCH
      // ==================================

      else if (command === 'ytsearch') {
        if (!query) {
          await sock.sendMessage(jid, {
            text: '🔎 Escribe lo que deseas buscar.\nEjemplo: .ytsearch Romeo Santos'
          }, { quoted: msg });

          return;
        }

        const videos = await searchYouTube(query);

        if (!videos) {
          await sock.sendMessage(jid, {
            text: '❌ No encontré resultados.'
          });

          return;
        }

        let response = '🔎 *RESULTADOS DE YOUTUBE*\n\n';

        videos.slice(0, 5).forEach((video, index) => {
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

      // ==================================
      // .ARTIST
      // ==================================

      else if (command === 'artist') {
        if (!query) {
          await sock.sendMessage(jid, {
            text: '🎤 Escribe el nombre del artista.\nEjemplo: .artist Eladio Carrión'
          }, { quoted: msg });

          return;
        }

        const videos = await searchYouTube(`${query} canciones`);

        if (!videos) {
          await sock.sendMessage(jid, {
            text: '❌ No encontré canciones.'
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

      // ==================================
      // .LYRICS
      // ==================================

      else if (command === 'lyrics') {
        if (!query) {
          await sock.sendMessage(jid, {
            text: '📝 Escribe el nombre de una canción.'
          }, { quoted: msg });

          return;
        }

        await sock.sendMessage(jid, {
          text: `📝 La función de letras para *${query}* todavía no está activada.`
        }, { quoted: msg });
      }

      // ==================================
      // .RADIO
      // ==================================

      else if (command === 'radio') {
        await sock.sendMessage(jid, {
          text: `
📻 *J MUSIC - RADIO*

🌐 https://www.radio-browser.info/

🎵 Busca emisoras de todo el mundo.
          `
        }, { quoted: msg });
      }

      // ==================================
      // COMANDO DESCONOCIDO
      // ==================================

      else {
        await sock.sendMessage(jid, {
          text: `❌ Comando desconocido.\nEscribe ${PREFIX}help.`
        }, { quoted: msg });
      }
    });

  } catch (error) {
    console.error('Error al iniciar J Music:', error);

    setTimeout(() => startBot(), 5000);
  }
}

// ======================================
// INICIAR
// ======================================

startBot();
