function validateManifest(manifest) {
  if (!manifest || !manifest.screen || !manifest.previewImage) {
    throw new Error("缺少 screen 或 previewImage 数据");
  }

  if (!Number.isFinite(manifest.screen.width) || !Number.isFinite(manifest.screen.height)) {
    throw new Error("screen.width 和 screen.height 必须是数字");
  }

  if (!Array.isArray(manifest.assets)) {
    throw new Error("assets 必须是数组");
  }

  for (const asset of manifest.assets) {
    const contentType = String(asset?.contentType || "image");
    const hasEditableText = contentType === "text" && String(asset?.text?.characters || "").trim();
    const skipped = asset.selected === false || contentType === "unclassified";
    if (!asset.name || !asset.placement || (!skipped && !asset.dataUrl && !asset.svgData && !hasEditableText)) {
      throw new Error("每个 asset 必须包含 name、placement，以及图片、SVG 或可编辑文字数据");
    }

    const placement = asset.placement;
    const fields = [placement.x, placement.y, placement.width, placement.height];
    if (fields.some((value) => !Number.isFinite(value))) {
      throw new Error(`asset ${asset.name} 的 placement 坐标必须是数字`);
    }
  }
  validateCompositeAssetParents(manifest.assets);
}

function validateCompositeAssetParents(assets) {
  const byId = new Map(assets.map((asset) => [String(asset?.id || ""), asset]));
  for (const asset of assets) {
    if (!asset.parentId) continue;
    const parent = byId.get(String(asset.parentId));
    if (!parent || !["background", "image"].includes(String(parent.contentType || "image"))) {
      throw new Error(`asset ${asset.name} 的 parentId 必须指向背景或图片图层`);
    }
    const parentBox = parent.placement;
    const childBox = asset.placement;
    if (
      !parentBox || !childBox
      || childBox.x < parentBox.x
      || childBox.y < parentBox.y
      || childBox.x + childBox.width > parentBox.x + parentBox.width
      || childBox.y + childBox.height > parentBox.y + parentBox.height
    ) {
      throw new Error(`asset ${asset.name} 必须完整位于父级范围内`);
    }
    const seen = new Set([String(asset.id || "")]);
    let cursor = parent;
    while (cursor) {
      const id = String(cursor.id || "");
      if (seen.has(id)) throw new Error(`asset ${asset.name} 的父子关系存在循环`);
      seen.add(id);
      cursor = cursor.parentId ? byId.get(String(cursor.parentId)) : null;
    }
  }
}

function validateEditableDesignManifest(manifest) {
  if (!manifest || !manifest.screen) {
    throw new Error("缺少 editable design screen 数据");
  }
  if (!Number.isFinite(manifest.screen.width) || !Number.isFinite(manifest.screen.height)) {
    throw new Error("editable design screen.width 和 screen.height 必须是数字");
  }
  if (!Array.isArray(manifest.nodes)) {
    throw new Error("editable design nodes 必须是数组");
  }
}

module.exports = {
  validateManifest,
  validateEditableDesignManifest
};
