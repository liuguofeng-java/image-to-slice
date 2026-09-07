const path = require("node:path");
const sharp = require("sharp");
const { createLocalImageWorkerClient } = require("../src/server/services/local-image-worker-client");

function dataUrl(buffer) {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function main() {
  const client = createLocalImageWorkerClient({ projectRoot: path.resolve(__dirname, "..") });
  try {
    const health = await client.health();
    console.log(JSON.stringify(health, null, 2));
    const failures = [];

    const source = await sharp({
      create: { width: 32, height: 32, channels: 4, background: { r: 112, g: 156, b: 210, alpha: 1 } }
    }).composite([{
      input: { create: { width: 8, height: 8, channels: 4, background: { r: 250, g: 250, b: 250, alpha: 1 } } },
      left: 12,
      top: 12
    }]).png().toBuffer();
    const mask = await sharp({
      create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } }
    }).composite([{
      input: { create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } },
      left: 12,
      top: 12
    }]).png().toBuffer();

    let upscaleSource = dataUrl(source);
    if (health.iopaintRootFound && health.lamaModelFound) {
      try {
        const repaired = await client.inpaint({ dataUrl: upscaleSource, maskDataUrl: dataUrl(mask), maskExpand: 1, maskFeather: 1 });
        upscaleSource = repaired.dataUrl;
        console.log(`LaMa 检查通过：${repaired.width}x${repaired.height}，${repaired.inferenceMs}ms`);
      } catch (error) {
        failures.push(`LaMa 推理失败：${error.message || String(error)}`);
      }
    } else {
      failures.push(`LaMa 不可用：${health.lamaModelFound ? health.iopaintRoot : health.lamaModelPath}`);
    }

    if (health.realesrganRootFound && health.realesrganModelFound) {
      try {
        const upscaled = await client.upscale({ dataUrl: upscaleSource, scale: 2 });
        console.log(`Real-ESRGAN 检查通过：${upscaled.outputPixelWidth}x${upscaled.outputPixelHeight}，${upscaled.inferenceMs}ms`);
      } catch (error) {
        failures.push(`Real-ESRGAN 推理失败：${error.message || String(error)}`);
      }
    } else {
      failures.push(`Real-ESRGAN 不可用：${health.realesrganModelFound ? health.realesrganRoot : health.realesrganModelPath}`);
    }

    if (failures.length) throw new Error(failures.join("；"));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`本地 AI 检查失败：${error.message || String(error)}`);
  process.exitCode = 1;
});
