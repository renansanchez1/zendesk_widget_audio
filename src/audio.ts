// Validação do áudio recebido (RF-010, seção 7.1 Tampering).
// O tipo vem dos magic bytes, nunca do MIME declarado pelo navegador.

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';

// MIME detectado → [MIME publicado, extensão]. MediaRecorder grava contêineres
// "video/*" mesmo sem vídeo; publicamos como audio/* (extensões aceitas pela Zendesk).
const ACCEPTED: Record<string, [string, string]> = {
  'video/webm': ['audio/webm', 'webm'],
  'audio/webm': ['audio/webm', 'webm'],
  'video/mp4': ['audio/mp4', 'm4a'],
  'audio/mp4': ['audio/mp4', 'm4a'],
  'audio/x-m4a': ['audio/mp4', 'm4a'],
  'audio/ogg': ['audio/ogg', 'ogg'],
  'audio/opus': ['audio/ogg', 'ogg'],
  'audio/mpeg': ['audio/mpeg', 'mp3'],
  'audio/wav': ['audio/wav', 'wav'],
  'audio/x-wav': ['audio/wav', 'wav'],
};

export async function sniffAudio(buf: Buffer): Promise<{ mediaType: string; ext: string } | undefined> {
  const detected = await fileTypeFromBuffer(buf);
  const match = detected && ACCEPTED[detected.mime];
  return match && { mediaType: match[0], ext: match[1] };
}

/**
 * Duração real em ms, decodificando com ffmpeg (o WebM do MediaRecorder não traz
 * duração no cabeçalho, então ffprobe sozinho não basta). Retorna undefined se o
 * ffmpeg não estiver instalado — a demo então confia na duração declarada.
 */
export async function probeDurationMs(buf: Buffer, ext: string): Promise<number | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'voz-'));
  const file = join(dir, `in.${ext}`);
  try {
    await writeFile(file, buf, { mode: 0o600 });
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'ffmpeg',
        ['-hide_banner', '-nostats', '-v', 'error', '-i', file, '-f', 'null', '-progress', 'pipe:1', '-'],
        { timeout: 20_000, maxBuffer: 1024 * 1024 },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
    });
    const times = [...stdout.matchAll(/out_time_us=(\d+)/g)];
    const last = times.at(-1);
    return last ? Math.round(Number(last[1]) / 1000) : undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw Object.assign(new Error('invalid_audio'), { cause: e });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
