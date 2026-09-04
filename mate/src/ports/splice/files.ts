import { basename, resolve } from "node:path";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/;
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,5}$/;

/**
 * Absolute path for an asset under `dir`. The server's file name is used only
 * when it is a plain file name with an extension; anything else lands as
 * `<uuid>.wav`, so a hostile name can never escape the directory.
 */
export function localPathFor(dir: string, uuid: string, fileName: string): string {
  const base = basename(fileName.trim());
  const safe = SAFE_NAME.test(base) && HAS_EXTENSION.test(base) ? base : `${uuid}.wav`;
  return resolve(dir, safe);
}

/**
 * A valid, silent 16-bit mono 44.1 kHz WAV of `frames` samples. The stub
 * writes one so stub mode yields real files Ableton could import.
 */
export function placeholderWav(frames = 441): Uint8Array {
  const dataBytes = frames * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) v.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 44_100, true);
  v.setUint32(28, 44_100 * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}
