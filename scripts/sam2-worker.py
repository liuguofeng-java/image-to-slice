"""Persistent SAM 2 image predictor controlled over JSON Lines on stdin/stdout."""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import time
import uuid
from pathlib import Path

import numpy as np
import torch
from PIL import Image


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sam2-root", required=True)
    return parser.parse_args()


ARGS = parse_args()
SAM2_ROOT = Path(ARGS.sam2_root).resolve()
CHECKPOINT = SAM2_ROOT / "checkpoints" / "sam2.1_hiera_tiny.pt"
MODEL_CONFIG = "configs/sam2.1/sam2.1_hiera_t.yaml"
os.chdir(SAM2_ROOT)
sys.path.insert(0, str(SAM2_ROOT))

predictor = None
active_session = None
candidate_logits = []


def ensure_model():
    global predictor
    if predictor is not None:
        return predictor
    if not CHECKPOINT.is_file():
        raise FileNotFoundError(f"SAM 2 tiny 权重不存在：{CHECKPOINT}")
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    model = build_sam2(
        MODEL_CONFIG,
        str(CHECKPOINT),
        device="cpu",
        apply_postprocessing=False,
    )
    predictor = SAM2ImagePredictor(model)
    return predictor


def decode_image(data_url):
    if not isinstance(data_url, str) or "," not in data_url:
        raise ValueError("dataUrl 必须是有效图片 Data URL")
    raw = base64.b64decode(data_url.split(",", 1)[1], validate=True)
    image = Image.open(io.BytesIO(raw)).convert("RGB")
    if image.width < 1 or image.height < 1 or image.width > 4096 or image.height > 4096:
        raise ValueError("图片尺寸必须在 1–4096px 范围内")
    return image


def encode_mask(mask):
    output = io.BytesIO()
    Image.fromarray((np.asarray(mask, dtype=np.uint8) * 255), mode="L").save(
        output, format="PNG", optimize=True
    )
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


def normalize_points(points, width, height):
    coords = []
    labels = []
    for point in points or []:
        x = float(point.get("x", -1))
        y = float(point.get("y", -1))
        if not (0 <= x < width and 0 <= y < height):
            raise ValueError("SAM 2 提示点超出图片范围")
        label = point.get("label")
        if label not in ("foreground", "background"):
            raise ValueError("提示点标签必须是 foreground 或 background")
        coords.append([x, y])
        labels.append(1 if label == "foreground" else 0)
    if not coords:
        raise ValueError("至少需要一个前景或背景提示点")
    return np.asarray(coords, dtype=np.float32), np.asarray(labels, dtype=np.int32)


def normalize_box(box, width, height):
    if box is None:
        return None
    values = [float(box.get(key, 0)) for key in ("x1", "y1", "x2", "y2")]
    values[0] = min(max(values[0], 0), width - 1)
    values[1] = min(max(values[1], 0), height - 1)
    values[2] = min(max(values[2], values[0] + 1), width)
    values[3] = min(max(values[3], values[1] + 1), height)
    return np.asarray(values, dtype=np.float32)


def handle(action, payload):
    global active_session, candidate_logits
    if action == "health":
        return {
            "ok": True,
            "sam2Root": str(SAM2_ROOT),
            "python": sys.executable,
            "model": "sam2.1_hiera_tiny",
            "device": "cpu",
            "modelLoaded": predictor is not None,
            "checkpointFound": CHECKPOINT.is_file(),
        }
    if action == "create_session":
        image = decode_image(payload.get("dataUrl"))
        expected_width = int(payload.get("width", image.width))
        expected_height = int(payload.get("height", image.height))
        if expected_width != image.width or expected_height != image.height:
            raise ValueError("请求尺寸与图片实际尺寸不一致")
        model = ensure_model()
        started = time.perf_counter()
        with torch.inference_mode():
            model.set_image(np.array(image, copy=True))
        active_session = {
            "id": uuid.uuid4().hex,
            "assetId": str(payload.get("assetId", "")),
            "width": image.width,
            "height": image.height,
        }
        candidate_logits = []
        return {
            "sessionId": active_session["id"],
            "width": image.width,
            "height": image.height,
            "model": "sam2.1_hiera_tiny",
            "device": "cpu",
            "embeddingMs": round((time.perf_counter() - started) * 1000),
        }
    if action == "predict":
        if active_session is None or payload.get("sessionId") != active_session["id"]:
            raise ValueError("SAM 2 会话已失效，请重新打开智能抠图")
        points, labels = normalize_points(
            payload.get("points"), active_session["width"], active_session["height"]
        )
        box = normalize_box(
            payload.get("box"), active_session["width"], active_session["height"]
        )
        candidate_index = payload.get("candidateIndex")
        mask_input = None
        multimask = True
        if candidate_index is not None and candidate_logits:
            index = int(candidate_index)
            if index < 0 or index >= len(candidate_logits):
                raise ValueError("SAM 2 候选索引无效")
            mask_input = candidate_logits[index][None, :, :]
            multimask = False
        started = time.perf_counter()
        with torch.inference_mode():
            masks, scores, logits = predictor.predict(
                point_coords=points,
                point_labels=labels,
                box=box,
                mask_input=mask_input,
                multimask_output=multimask,
            )
        candidate_logits = [np.asarray(value, dtype=np.float32) for value in logits]
        return {
            "requestRevision": payload.get("requestRevision"),
            "inferenceMs": round((time.perf_counter() - started) * 1000),
            "candidates": [
                {
                    "index": index,
                    "score": float(scores[index]),
                    "maskDataUrl": encode_mask(masks[index]),
                }
                for index in range(len(masks))
            ],
        }
    if action == "close_session":
        if active_session and payload.get("sessionId") == active_session["id"]:
            active_session = None
            candidate_logits = []
        return {"ok": True}
    raise ValueError(f"未知 SAM 2 操作：{action}")


def respond(request_id, result=None, error=None):
    value = {"id": request_id, "ok": error is None}
    if error is None:
        value["result"] = result
    else:
        value["error"] = str(error)
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)


for line in sys.stdin:
    try:
        request = json.loads(line)
        respond(request.get("id"), result=handle(request.get("action"), request.get("payload") or {}))
    except Exception as error:
        respond(request.get("id") if "request" in locals() else None, error=error)
