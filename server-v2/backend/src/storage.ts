import { mkdir, readFile, writeFile, rename, readdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import {
  documentSchema,
  idSchema,
  signature,
  uid,
  fail,
  type Project,
  type Document,
  type Asset,
  type Rect,
  type ModelConfig,
} from './domain.js';
const exec = promisify(execFile);

/**
 * 唯一磁盘写入边界：图片按内容寻址且不可变，项目和配置以临时文件原子替换。
 * serial 只协调当前进程；生产环境只允许一个后端进程访问同一 data 目录。
 */
export class Storage {
  private queues = new Map<string, Promise<unknown>>();
  constructor(public root: string) {}
  async init() {
    for (const d of ['projects', 'assets', 'private'])
      await mkdir(join(this.root, d), { recursive: true, mode: 0o700 });
    const privateDir = join(this.root, 'private');
    if (process.platform === 'win32') {
      const identity = (await exec('whoami.exe')).stdout.trim();
      await exec('icacls.exe', [
        privateDir,
        '/inheritance:r',
        '/grant:r',
        `${identity}:(OI)(CI)F`,
        'SYSTEM:(OI)(CI)F',
      ]);
    } else await chmod(privateDir, 0o700);
  }
  /** 同一项目/资源串行执行；前一个任务失败也不能阻断后续用户重试。 */
  async serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    this.queues.set(key, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
  }
  /** 临时文件与目标位于同一目录，rename 成功才算提交，写入失败保留旧文件。 */
  async atomic(path: string, value: unknown) {
    const tmp = path + '.' + uid() + '.tmp';
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    await rename(tmp, path);
  }
  async read<T>(path: string): Promise<T> {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') fail('记录不存在', 404);
      throw e;
    }
  }
  async project(id: string) {
    return this.read<Project>(join(this.root, 'projects', idSchema.parse(id) + '.json'));
  }
  async list() {
    return Promise.all(
      (await readdir(join(this.root, 'projects')))
        .filter((n) => n.endsWith('.json'))
        .map(async (n) => {
          const p = await this.project(n.slice(0, -5));
          return { id: p.id, name: p.name, revision: p.revision, updatedAt: p.updatedAt };
        }),
    );
  }
  async create(name = 'Untitled') {
    const sceneId = uid();
    const p: Project = {
      id: uid(),
      revision: 0,
      updatedAt: new Date().toISOString(),
      name,
      activeSceneId: sceneId,
      scenes: [{ id: sceneId, name: 'Page 1', width: 1440, height: 900, layers: [] }],
    };
    await this.atomic(join(this.root, 'projects', p.id + '.json'), p);
    return p;
  }
  async validateDocument(doc: Document) {
    documentSchema.parse(doc);
    for (const id of new Set(doc.scenes.flatMap((s) => s.layers.map((l) => l.assetId))))
      await this.asset(id);
  }
  /** 调用者必须持有项目 serial 锁；创建项目时尚无竞争者。 */
  async writeProject(p: Project) {
    await this.validateDocument(p);
    await this.atomic(join(this.root, 'projects', p.id + '.json'), p);
    return p;
  }
  /** 乐观锁：比较磁盘版本，不合并或覆盖另一个标签页的未知修改。 */
  async save(id: string, revision: number, doc: Document) {
    return this.serial(id, async () => {
      const old = await this.project(id);
      if (old.revision !== revision) fail('项目已被其他窗口修改，请重新打开项目', 409);
      return this.writeProject({
        ...doc,
        id,
        revision: old.revision + 1,
        updatedAt: new Date().toISOString(),
        receipts: old.receipts,
      });
    });
  }
  async asset(id: string) {
    return this.read<Asset>(join(this.root, 'assets', idSchema.parse(id) + '.json'));
  }
  imagePath(id: string) {
    return join(this.root, 'assets', idSchema.parse(id) + '.png');
  }
  async import(bytes: Buffer, name: string): Promise<Asset> {
    if (bytes.length > 30 * 1024 * 1024) fail('图片不能超过 30 MB', 413);
    let png: Buffer;
    try {
      const s = sharp(bytes, { limitInputPixels: 32e6, animated: false });
      const meta = await s.metadata();
      if (!['png', 'jpeg', 'webp'].includes(meta.format || '') || (meta.pages || 1) > 1)
        fail('仅支持静态 PNG、JPEG、WebP');
      if (!meta.width || !meta.height || meta.width > 16384 || meta.height > 16384)
        fail('图片尺寸超限');
      // 无参数 rotate 应用 EXIF 方向；此后所有尺寸和裁切坐标基于规范化 PNG。
      png = await s.rotate().png().toBuffer();
    } catch (e) {
      fail('图片无效或尺寸超限：' + (e as Error).message);
    }
    const meta = await sharp(png).metadata();
    const asset: Asset = {
      id: signature(png.toString('base64')),
      width: meta.width!,
      height: meta.height!,
      name: name.slice(0, 200),
    };
    // 内容相同的图片共享资源，wx 保证不覆盖已被项目或撤销快照引用的 PNG。
    await this.serial(asset.id, async () => {
      await writeFile(this.imagePath(asset.id), png, { flag: 'wx' }).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
      await this.atomic(join(this.root, 'assets', asset.id + '.json'), asset);
    });
    return asset;
  }
  async crop(id: string, rect: Rect, name: string) {
    const bytes = await sharp(this.imagePath(id))
      .extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })
      .png()
      .toBuffer();
    return this.import(bytes, name);
  }
  async model(): Promise<ModelConfig | null> {
    try {
      return await this.read<ModelConfig>(join(this.root, 'private', 'model.json'));
    } catch (e) {
      if ((e as { statusCode: number }).statusCode === 404) return null;
      throw e;
    }
  }
  async saveModel(config: ModelConfig) {
    return this.serial('model-config', async () => {
      const prev = await this.model();
      const model = {
        ...config,
        apiKey: config.apiKey === undefined ? prev?.apiKey || '' : config.apiKey,
      };
      await this.atomic(join(this.root, 'private', 'model.json'), model);
      return model;
    });
  }
}
