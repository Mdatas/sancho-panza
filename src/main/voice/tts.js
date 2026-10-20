'use strict';
/**
 * Text-to-speech. Primary: Microsoft Edge neural voices (free, no key, needs internet) via msedge-tts.
 * Fallback: Windows SAPI through PowerShell (offline, robotic). Returns audio buffers; the renderer plays them.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VOICES = [
  { id: 'es-AR-ElenaNeural', label: 'Elena (español, Argentina) — recomendada' },
  { id: 'es-AR-TomasNeural', label: 'Tomás (español, Argentina)' },
  { id: 'es-ES-AlvaroNeural', label: 'Álvaro (español, España)' },
  { id: 'es-MX-JorgeNeural', label: 'Jorge (español, México)' },
  { id: 'es-MX-DaliaNeural', label: 'Dalia (español, México)' },
  { id: 'en-US-GuyNeural', label: 'Guy (English, US)' },
  { id: 'en-US-AriaNeural', label: 'Aria (English, US)' },
  { id: 'en-GB-RyanNeural', label: 'Ryan (English, UK)' },
  { id: 'de-DE-KatjaNeural', label: 'Katja (Deutsch)' },
  { id: 'de-DE-ConradNeural', label: 'Conrad (Deutsch)' },
  { id: 'pt-BR-FranciscaNeural', label: 'Francisca (Português, Brasil)' },
  { id: 'pt-PT-RaquelNeural', label: 'Raquel (Português, Portugal)' },
  { id: 'zh-CN-XiaoxiaoNeural', label: 'Xiaoxiao (中文, 普通话)' },
  { id: 'zh-CN-YunxiNeural', label: 'Yunxi (中文, 普通话)' },
  { id: 'vi-VN-HoaiMyNeural', label: 'HoaiMy (Tiếng Việt)' },
  { id: 'vi-VN-NamMinhNeural', label: 'NamMinh (Tiếng Việt)' },
  { id: 'ko-KR-SunHiNeural', label: 'SunHi (한국어)' },
  { id: 'ko-KR-InJoonNeural', label: 'InJoon (한국어)' },
];

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** "+22" read aloud in the voice's language ("más 22", "plus 22"…). */
const PLUS = { es: 'más', en: 'plus', de: 'plus', pt: 'mais', zh: '加', vi: 'cộng', ko: '플러스' };
/** Strip markdown / symbols so the voice doesn't read "asterisk asterisk". `lang` = language of the voice (es, en, de…). */
function cleanForSpeech(text, lang = 'es') {
  const plus =
    PLUS[
      String(lang || 'es')
        .slice(0, 2)
        .toLowerCase()
    ] || PLUS.es;
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>|]/g, ' ')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\+(\d+)/g, `${plus} $1`)
    .replace(/\s+/g, ' ')
    .trim();
}

async function edgeSpeak(text, { voice = 'es-AR-ElenaNeural', rate = 1.0 } = {}) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
  const tts = new MsEdgeTTS({ connectionTimeoutMs: 10000, synthesisTimeoutMs: 30000 });
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(escapeXml(text), { rate });
  const chunks = [];
  await new Promise((resolve, reject) => {
    audioStream.on('data', (d) => chunks.push(d));
    audioStream.on('error', reject);
    audioStream.on('close', resolve);
    audioStream.on('end', resolve);
  });
  try {
    tts.close && tts.close();
  } catch {
    /* ignore */
  }
  const buf = Buffer.concat(chunks);
  if (!buf.length) throw new Error('Edge TTS returned no audio');
  return { audio: buf, mime: 'audio/mpeg', engine: 'edge' };
}

async function sapiSpeak(text, { rate = 1.0, lang = 'es' } = {}) {
  if (process.platform !== 'win32') throw new Error('SAPI is Windows-only');
  const out = path.join(os.tmpdir(), `aoe2coach_tts_${Date.now()}.wav`);
  const sapiRate = Math.max(-10, Math.min(10, Math.round((rate - 1) * 10)));
  const culture =
    String(lang || 'es')
      .replace(/[^a-zA-Z-]/g, '')
      .slice(0, 5) || 'es'; // installed voice of the UI language, if any
  const ps = `
$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech;
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
try { $v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like '${culture}*' } | Select-Object -First 1; if ($v) { $s.SelectVoice($v.VoiceInfo.Name) } } catch {}
$s.Rate = ${sapiRate};
$s.SetOutputToWaveFile('${out.replace(/'/g, "''")}');
$t = [Console]::In.ReadToEnd(); $s.Speak($t); $s.Dispose();`;
  await new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('SAPI failed: ' + err.slice(-200)))));
    p.stdin.end(text, 'utf8');
  });
  const audio = fs.readFileSync(out);
  try {
    fs.unlinkSync(out);
  } catch {
    /* ignore */
  }
  return { audio, mime: 'audio/wav', engine: 'sapi' };
}

/** macOS offline fallback: the built-in `say` command (prefers an es_AR / es voice), output as AAC in .m4a. */
async function macSay(text, { rate = 1.0 } = {}) {
  if (process.platform !== 'darwin') throw new Error('say is macOS-only');
  const run = (args, input) =>
    new Promise((resolve, reject) => {
      const p = spawn('/usr/bin/say', args);
      let out = '',
        err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error('say failed: ' + err.slice(-200)))));
      if (input != null) p.stdin.end(input, 'utf8');
      else p.stdin.end();
    });
  let voice = '';
  try {
    const list = await run(['-v', '?']);
    const lines = list.split('\n');
    const pick = (re) => (lines.find((l) => re.test(l)) || '').trim().split(/\s{2,}/)[0];
    voice = pick(/\ses_AR\b/) || pick(/\ses_(MX|419|US|ES)\b/) || pick(/\ses_/);
  } catch {
    /* default voice */
  }
  const out = path.join(os.tmpdir(), `aoe2coach_tts_${Date.now()}.m4a`);
  const args = [...(voice ? ['-v', voice] : []), '-r', String(Math.round(185 * rate)), '-o', out, '--file-format=m4af', '--data-format=aac', '-f', '-'];
  await run(args, text);
  const audio = fs.readFileSync(out);
  try {
    fs.unlinkSync(out);
  } catch {
    /* ignore */
  }
  return { audio, mime: 'audio/mp4', engine: 'say' };
}

/** Speak with the configured engine, falling back to SAPI (Windows) or `say` (macOS) when Edge fails. */
async function speak(text, settings) {
  const voice = settings.ttsVoice || 'es-AR-ElenaNeural';
  const lang = (voice.match(/^([a-z]{2})-/i) || [])[1] || settings.uiLanguage || 'es';
  const clean = cleanForSpeech(text, lang).slice(0, 1200);
  if (!clean) return null;
  const engine = settings.ttsEngine || 'edge';
  if (engine === 'off') return null;
  const opts = { voice, rate: Number(settings.ttsRate) || 1.0, lang };
  if (engine === 'sapi') return process.platform === 'darwin' ? macSay(clean, opts) : sapiSpeak(clean, opts);
  try {
    return await edgeSpeak(clean, opts);
  } catch (e) {
    if (process.platform === 'win32') {
      const r = await sapiSpeak(clean, opts);
      r.fallbackReason = e.message;
      return r;
    }
    if (process.platform === 'darwin') {
      const r = await macSay(clean, opts);
      r.fallbackReason = e.message;
      return r;
    }
    throw e;
  }
}

module.exports = { speak, cleanForSpeech, VOICES };
