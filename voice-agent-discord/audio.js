// Discord は 48kHz ステレオの 16bit PCM、ElevenLabs には 16kHz モノラルで送り、48kHz モノラルで受け取る

// 48kHz ステレオ → 16kHz モノラル。3サンプル × 2ch を平均して間引く
export function toMono16k(pcm) {
  const frames = Math.floor(pcm.length / 12);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let j = 0; j < 6; j++) sum += pcm.readInt16LE(i * 12 + j * 2);
    out.writeInt16LE(Math.round(sum / 6), i * 2);
  }
  return out;
}

export function monoToStereo(pcm) {
  const samples = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    out.writeInt16LE(s, i * 4);
    out.writeInt16LE(s, i * 4 + 2);
  }
  return out;
}
