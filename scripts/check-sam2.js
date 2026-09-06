const { createSam2WorkerClient } = require("../src/server/services/sam2-worker-client");
const sharp = require("sharp");

async function main() {
  const client = createSam2WorkerClient();
  try {
    const health = await client.health();
    if (!health.ok || !health.checkpointFound) throw new Error(health.error || "SAM 2 健康检查失败");
    const pixels = Buffer.alloc(64 * 64 * 3, 20);
    for (let y = 12; y < 52; y++) for (let x = 12; x < 52; x++) {
      const offset = (y * 64 + x) * 3;
      pixels.set([245, 180, 20], offset);
    }
    const png = await sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    const session = await client.request("create_session", { assetId: "sam2_check", dataUrl, width: 64, height: 64 });
    const result = await client.request("predict", {
      sessionId: session.sessionId,
      points: [{ x: 32, y: 32, label: "foreground" }],
      box: { x1: 1, y1: 1, x2: 63, y2: 63 },
      requestRevision: 1
    });
    if (!result.candidates?.length) throw new Error("SAM 2 没有返回候选蒙版");
    const refined = await client.request("predict", {
      sessionId: session.sessionId,
      points: [
        { x: 32, y: 32, label: "foreground" },
        { x: 4, y: 4, label: "background" }
      ],
      box: { x1: 1, y1: 1, x2: 63, y2: 63 },
      candidateIndex: result.candidates[0].index,
      requestRevision: 2
    });
    if (refined.requestRevision !== 2 || refined.candidates?.length !== 1) {
      throw new Error("SAM 2 连续细化没有返回有效候选");
    }
    console.log(`SAM 2 正常：${health.model} / ${health.device}`);
    console.log(`特征计算 ${session.embeddingMs}ms，分割 ${result.inferenceMs}ms，候选 ${result.candidates.length} 个，连续细化 ${refined.inferenceMs}ms`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`SAM 2 检查失败：${error.message || String(error)}`);
  process.exitCode = 1;
});
