const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildRegionTextRecognitionPrompt,
  parseRegionTextRecognitionText
} = require("../../src/core/region-text-recognition");

test("region text prompt includes authoritative screenshot coordinates", () => {
  const prompt = buildRegionTextRecognitionPrompt({
    width: 300,
    height: 200,
    region: { x: 20, y: 30, width: 80, height: 24 }
  });
  assert.match(prompt, /300x200px/);
  assert.match(prompt, /x=20, y=30, width=80, height=24/);
});

test("region text parser returns validated editable text style", () => {
  const result = parseRegionTextRecognitionText(JSON.stringify({
    text: "鞋子",
    fontWeight: 800,
    fontSize: 28,
    lineHeight: 32,
    color: "#ffffff",
    textAlignHorizontal: "center",
    strokeColor: "#002244",
    strokeWidth: 2,
    confidence: 0.93
  }), { region: { height: 40 } });
  assert.equal(result.text.characters, "鞋子");
  assert.equal(result.text.color, "#FFFFFF");
  assert.equal(result.text.textAlignHorizontal, "CENTER");
  assert.equal(result.confidence, 0.93);
});

test("region text parser rejects empty recognition", () => {
  assert.throws(
    () => parseRegionTextRecognitionText('{"text":""}', { region: { height: 20 } }),
    /没有识别到文字内容/
  );
});
