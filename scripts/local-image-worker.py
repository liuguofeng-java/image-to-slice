#!/usr/bin/env python3
"""Persistent CPU worker for local LaMa inpainting and Real-ESRGAN upscaling."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time
import traceback

# Node reads the JSON Lines pipe as UTF-8. Windows otherwise inherits the
# active console code page, which corrupts Chinese diagnostics in the UI.
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iopaint-root", required=True)
    parser.add_argument("--realesrgan-root", required=True)
    parser.add_argument("--lama-model", required=True)
    parser.add_argument("--realesrgan-model", required=True)
    return parser.parse_args()


ARGS = parse_args()
IOPAINT_ROOT = Path(ARGS.iopaint_root).resolve()
REALESRGAN_ROOT = Path(ARGS.realesrgan_root).resolve()
LAMA_MODEL_PATH = Path(ARGS.lama_model).resolve()
REALESRGAN_MODEL_PATH = Path(ARGS.realesrgan_model).resolve()

for root in (str(IOPAINT_ROOT), str(REALESRGAN_ROOT)):
    if root not in sys.path:
        sys.path.insert(0, root)

_lama = None
_upsampler = None


def require_file(path: Path, label: str) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"{label}不存在：{path}")


def require_root(path: Path, label: str) -> None:
    if not path.is_dir():
        raise FileNotFoundError(f"{label}目录不存在：{path}")


def load_lama():
    global _lama
    if _lama is not None:
        return _lama
    require_root(IOPAINT_ROOT, "IOPaint")
    require_file(LAMA_MODEL_PATH, "LaMa 权重")
    import torch
    from iopaint.model.lama import LaMa

    model_path = str(LAMA_MODEL_PATH)

    class LocalLaMa(LaMa):
        def init_model(self, device, **_kwargs):
            self.model = torch.jit.load(model_path, map_location=device).eval()

    _lama = LocalLaMa(torch.device("cpu"))
    return _lama


def load_upsampler():
    global _upsampler
    if _upsampler is not None:
        return _upsampler
    require_root(REALESRGAN_ROOT, "Real-ESRGAN")
    require_file(REALESRGAN_MODEL_PATH, "Real-ESRGAN 权重")
    import torch
    from torchvision.transforms import functional as functional_tensor

    # BasicSR 1.4.2 imports a module removed by newer torchvision releases.
    sys.modules.setdefault("torchvision.transforms.functional_tensor", functional_tensor)
    from basicsr.archs.rrdbnet_arch import RRDBNet
    from realesrgan import RealESRGANer

    network = RRDBNet(
        num_in_ch=3,
        num_out_ch=3,
        num_feat=64,
        num_block=6,
        num_grow_ch=32,
        scale=4,
    )
    _upsampler = RealESRGANer(
        scale=4,
        model_path=str(REALESRGAN_MODEL_PATH),
        model=network,
        tile=0,
        tile_pad=10,
        pre_pad=10,
        half=False,
        device=torch.device("cpu"),
    )
    return _upsampler


def health() -> dict:
    errors = []
    checks = {
        "iopaintRootFound": IOPAINT_ROOT.is_dir(),
        "realesrganRootFound": REALESRGAN_ROOT.is_dir(),
        "lamaModelFound": LAMA_MODEL_PATH.is_file(),
        "realesrganModelFound": REALESRGAN_MODEL_PATH.is_file(),
    }
    if not checks["iopaintRootFound"]:
        errors.append(f"IOPaint 目录不存在：{IOPAINT_ROOT}")
    if not checks["realesrganRootFound"]:
        errors.append(f"Real-ESRGAN 目录不存在：{REALESRGAN_ROOT}")
    if not checks["lamaModelFound"]:
        errors.append(f"LaMa 权重不存在：{LAMA_MODEL_PATH}")
    if not checks["realesrganModelFound"]:
        errors.append(f"Real-ESRGAN 权重不存在：{REALESRGAN_MODEL_PATH}")
    try:
        import cv2
        import numpy
        import PIL
        import torch
        checks["pythonDependenciesFound"] = True
        versions = {
            "python": sys.version.split()[0],
            "torch": torch.__version__,
            "opencv": cv2.__version__,
            "numpy": numpy.__version__,
            "pillow": PIL.__version__,
        }
    except Exception as error:
        checks["pythonDependenciesFound"] = False
        versions = {"python": sys.version.split()[0]}
        errors.append(f"Python 图像依赖不可用：{error}")
    return {
        "ok": not errors,
        "device": "cpu",
        "iopaintRoot": str(IOPAINT_ROOT),
        "realesrganRoot": str(REALESRGAN_ROOT),
        "lamaModelPath": str(LAMA_MODEL_PATH),
        "realesrganModelPath": str(REALESRGAN_MODEL_PATH),
        "lamaLoaded": _lama is not None,
        "realesrganLoaded": _upsampler is not None,
        **checks,
        "versions": versions,
        "error": "；".join(errors),
    }


def run_inpaint(payload: dict) -> dict:
    import cv2
    import numpy as np
    from iopaint.schema import HDStrategy, InpaintRequest

    source_path = Path(str(payload.get("sourcePath", "")))
    mask_path = Path(str(payload.get("maskPath", "")))
    output_path = Path(str(payload.get("outputPath", "")))
    require_file(source_path, "修复源图")
    require_file(mask_path, "修复蒙版")
    source = cv2.imread(str(source_path), cv2.IMREAD_UNCHANGED)
    mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    if source is None or mask is None:
        raise ValueError("无法读取修复源图或蒙版")
    if source.ndim == 2:
        source = cv2.cvtColor(source, cv2.COLOR_GRAY2BGRA)
    elif source.shape[2] == 3:
        source = cv2.cvtColor(source, cv2.COLOR_BGR2BGRA)
    height, width = source.shape[:2]
    if mask.shape[:2] != (height, width):
        mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
    _, mask = cv2.threshold(mask, 1, 255, cv2.THRESH_BINARY)
    expand = max(0, min(16, int(payload.get("maskExpand", 3))))
    feather = max(0, min(12, int(payload.get("maskFeather", 2))))
    if expand:
        size = expand * 2 + 1
        mask = cv2.dilate(mask, np.ones((size, size), np.uint8), iterations=1)
    if not np.any(mask):
        raise ValueError("修复蒙版为空，请先标记需要删除的区域")

    rgb = cv2.cvtColor(source[:, :, :3], cv2.COLOR_BGR2RGB)
    config = InpaintRequest(
        hd_strategy=HDStrategy.CROP,
        hd_strategy_crop_trigger_size=800,
        hd_strategy_crop_margin=128,
        sd_keep_unmasked_area=True,
    )
    started = time.perf_counter()
    completed_bgr = load_lama()(rgb, mask, config)
    inference_ms = round((time.perf_counter() - started) * 1000)
    if completed_bgr.shape[:2] != (height, width):
        completed_bgr = cv2.resize(completed_bgr, (width, height), interpolation=cv2.INTER_CUBIC)

    blend = mask.astype(np.float32) / 255.0
    if feather:
        kernel = feather * 2 + 1
        blend = cv2.GaussianBlur(blend, (kernel, kernel), feather / 2 or 0)
    blend = blend[:, :, None]
    output = source.copy()
    output[:, :, :3] = np.clip(
        completed_bgr.astype(np.float32) * blend + source[:, :, :3].astype(np.float32) * (1.0 - blend),
        0,
        255,
    ).astype(np.uint8)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(output_path), output):
        raise RuntimeError("无法写入本地修复结果")
    return {
        "width": width,
        "height": height,
        "model": "iopaint-lama",
        "inferenceMs": inference_ms,
    }


def run_upscale(payload: dict) -> dict:
    import cv2

    source_path = Path(str(payload.get("sourcePath", "")))
    output_path = Path(str(payload.get("outputPath", "")))
    require_file(source_path, "高清化源图")
    scale = int(payload.get("scale", 2))
    if scale not in (2, 4):
        raise ValueError("高清化倍率仅支持 2 或 4")
    source = cv2.imread(str(source_path), cv2.IMREAD_UNCHANGED)
    if source is None:
        raise ValueError("无法读取高清化源图")
    height, width = source.shape[:2]
    started = time.perf_counter()
    output, _ = load_upsampler().enhance(source, outscale=scale, alpha_upsampler="bicubic")
    inference_ms = round((time.perf_counter() - started) * 1000)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(output_path), output):
        raise RuntimeError("无法写入高清化结果")
    out_height, out_width = output.shape[:2]
    return {
        "sourcePixelWidth": width,
        "sourcePixelHeight": height,
        "outputPixelWidth": out_width,
        "outputPixelHeight": out_height,
        "scale": scale,
        "model": "realesrgan-x4plus-anime-6b",
        "inferenceMs": inference_ms,
    }


def dispatch(action: str, payload: dict) -> dict:
    if action == "health":
        return health()
    if action == "inpaint":
        return run_inpaint(payload)
    if action == "upscale":
        return run_upscale(payload)
    raise ValueError(f"未知本地图像处理动作：{action}")


def write(message: dict) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


for raw_line in sys.stdin:
    try:
        request = json.loads(raw_line)
        request_id = str(request.get("id", ""))
        result = dispatch(str(request.get("action", "")), request.get("payload") or {})
        write({"id": request_id, "ok": True, "result": result})
    except Exception as error:
        write({
            "id": str(locals().get("request", {}).get("id", "")),
            "ok": False,
            "error": str(error),
            "trace": traceback.format_exc(limit=4),
        })
