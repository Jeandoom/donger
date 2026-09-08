import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PackSkill, SkillPack, SkillPackSource } from "../domain/skill-pack.js";
import { parseFrontmatter, scanSkillPack } from "../domain/skill-scan.js";
import type {
  InstallGitReq,
  InstallPasteReq,
  InstallUploadReq,
  SkillInstaller,
} from "../ports/skill-installer.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";
import { SkillInstallError } from "../util/errors.js";

const SLUG_RE = /^[a-z0-9-]+$/;
const GIT_LONG_PATH_CONFIG = "core.longpaths=true";

export interface LocalSkillInstallerDeps {
  packStore: SkillPackStore;
  getHomeDir: (userId: string) => string;
}

export class LocalSkillInstaller implements SkillInstaller {
  constructor(private readonly deps: LocalSkillInstallerDeps) {}

  async installFromGit(userId: string, req: InstallGitReq): Promise<SkillPack> {
    const slug = await this.deriveSlug(userId, req.slug ?? repoSlugFromUrl(req.url));
    const dir = this.userPackDir(userId, slug);
    try {
      // 参数数组直传 git，不经 shell（url/ref 来自外部输入，杜绝注入面）
      execFileSync(
        "git",
        [
          "-c",
          GIT_LONG_PATH_CONFIG,
          "clone",
          "--depth",
          "1",
          ...(req.ref ? ["--branch", req.ref] : []),
          req.url,
          dir,
        ],
        { stdio: "pipe" },
      );
      this.ensurePluginManifest(dir, slug);
      const subPath = normalizeSubPath(req.subPath);
      const source: SkillPackSource = {
        kind: "git",
        url: req.url,
        ref: req.ref,
        ...(subPath ? { subPath } : {}),
      };
      const skillRoot = this.resolveSkillRoot(dir, source);
      return this.persistScanned(userId, slug, dir, source, false, undefined, skillRoot);
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      if (e instanceof SkillInstallError) throw e;
      throw new SkillInstallError("GIT_CLONE_FAILED", `git 安装失败: ${(e as Error).message}`);
    }
  }

  async installFromUpload(userId: string, req: InstallUploadReq): Promise<SkillPack> {
    return this.installSingleDoc(userId, {
      content: req.content,
      slugHint: req.filename,
      source: { kind: "upload", originalFilename: req.filename },
    });
  }

  async installFromPaste(userId: string, req: InstallPasteReq): Promise<SkillPack> {
    return this.installSingleDoc(userId, {
      content: req.content,
      slugHint: req.slug ?? req.name,
      name: req.name,
      description: req.description,
      source: { kind: "paste" },
    });
  }

  async installBuiltin(userId: string, slug: string, absPath: string): Promise<SkillPack> {
    if (!existsSync(absPath)) {
      throw new SkillInstallError("BUILTIN_NOT_FOUND", `预装 pack 不存在: ${absPath}`);
    }
    return this.persistScanned(userId, slug, absPath, { kind: "builtin" }, true);
  }

  async uninstall(userId: string, packId: string): Promise<void> {
    const pack = await this.deps.packStore.getPack(userId, packId);
    if (!pack) throw new SkillInstallError("PACK_NOT_FOUND", `pack 不存在: ${packId}`);
    if (pack.builtin) {
      throw new SkillInstallError("BUILTIN_NO_UNINSTALL", `预装 pack 不可卸载: ${pack.slug}`);
    }
    const dir = this.resolvePackDir(userId, pack);
    const skillsRoot = join(this.deps.getHomeDir(userId), ".skills");
    if (isInside(dir, skillsRoot)) rmSync(dir, { recursive: true, force: true });
    await this.deps.packStore.deletePack(userId, packId);
  }

  async update(userId: string, packId: string): Promise<SkillPack> {
    const pack = await this.deps.packStore.getPack(userId, packId);
    if (!pack) throw new SkillInstallError("PACK_NOT_FOUND", `pack 不存在: ${packId}`);
    if (pack.source.kind !== "git") {
      throw new SkillInstallError("NOT_GIT", "仅 git pack 支持更新");
    }
    const dir = this.resolvePackDir(userId, pack);
    try {
      execFileSync("git", ["-c", GIT_LONG_PATH_CONFIG, "-C", dir, "pull", "--ff-only"], {
        stdio: "pipe",
      });
    } catch (e) {
      throw new SkillInstallError("GIT_PULL_FAILED", `git pull 失败: ${(e as Error).message}`);
    }
    this.ensurePluginManifest(dir, pack.slug);
    const before = new Map(
      (await this.deps.packStore.listSkills(userId, packId)).map((s) => [s.name, s]),
    );
    const skillRoot = this.resolveSkillRoot(dir, pack.source);
    return this.persistScanned(
      userId,
      pack.slug,
      dir,
      pack.source,
      pack.builtin,
      before,
      skillRoot,
    );
  }

  // ---- 内部 ----

  private async installSingleDoc(
    userId: string,
    args: {
      content: string;
      slugHint?: string;
      name?: string;
      description?: string;
      source: SkillPackSource;
    },
  ): Promise<SkillPack> {
    const fm = parseFrontmatter(args.content);
    const skillName = args.name ?? fm.name ?? "skill";
    const slug = await this.deriveSlug(userId, args.slugHint ?? slugify(skillName));
    const dir = this.userPackDir(userId, slug);
    const skillDir = join(dir, "skills", skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), args.content);
    this.writePluginJson(dir, {
      name: slug,
      description: args.description ?? fm.description,
      version: "0.1.0",
    });
    return this.persistScanned(userId, slug, dir, args.source);
  }

  private async persistScanned(
    userId: string,
    slug: string,
    packDir: string,
    source: SkillPackSource,
    builtin = false,
    preserveSkillFlags?: Map<string, PackSkill>,
    skillRoot = packDir,
  ): Promise<SkillPack> {
    const scanned = scanSkillPack(packDir, skillRoot);
    if (source.kind === "git" && scanned.skills.length === 0) {
      throw new SkillInstallError("GIT_SKILLS_NOT_FOUND", "Git 仓库中未找到 SKILL.md");
    }
    const now = new Date().toISOString();
    // plugin.json name 与白名单前缀绑定：用户 pack 强制 = slug；预装沿用其 plugin.json name
    const name = builtin ? scanned.packMeta.name : slug;
    const packId = crypto.randomUUID();
    const skills: PackSkill[] = scanned.skills.map((s) => {
      const prev = preserveSkillFlags?.get(s.name);
      return {
        id: prev?.id ?? crypto.randomUUID(),
        userId,
        packId,
        name: s.name,
        description: s.description,
        allowedTools: s.allowedTools,
        relativePath: s.relativePath,
        enabled: prev ? prev.enabled : true,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
    });
    const pack: SkillPack = {
      id: packId,
      userId,
      slug,
      name,
      description: scanned.packMeta.description,
      version: scanned.packMeta.version,
      source,
      installedPath: builtin ? packDir : `.skills/${slug}`,
      enabled: true,
      builtin,
      credentials: scanned.credentials,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.packStore.upsertPack(pack);
    await this.deps.packStore.upsertSkills(userId, packId, skills);
    return pack;
  }

  private async deriveSlug(userId: string, base: string): Promise<string> {
    const slug = slugify(base);
    if (!SLUG_RE.test(slug)) throw new SkillInstallError("INVALID_SLUG", `slug 非法: ${slug}`);
    let candidate = slug;
    let n = 2;
    while (await this.deps.packStore.getPackBySlug(userId, candidate)) {
      candidate = `${slug}-${n++}`;
    }
    return candidate;
  }

  private userPackDir(userId: string, slug: string): string {
    const dir = join(this.deps.getHomeDir(userId), ".skills", slug);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private resolvePackDir(userId: string, pack: SkillPack): string {
    return pack.builtin || isAbsolute(pack.installedPath)
      ? pack.installedPath
      : join(this.deps.getHomeDir(userId), pack.installedPath);
  }

  private writePluginJson(
    dir: string,
    meta: { name: string; description?: string; version: string },
  ): void {
    const p = join(dir, ".claude-plugin");
    mkdirSync(p, { recursive: true });
    writeFileSync(
      join(p, "plugin.json"),
      JSON.stringify({
        name: meta.name,
        version: meta.version,
        description: meta.description ?? "",
      }),
    );
  }

  private ensurePluginManifest(dir: string, slug: string): void {
    const pluginJson = join(dir, ".claude-plugin", "plugin.json");
    if (existsSync(pluginJson)) return;
    this.writePluginJson(dir, { name: slug, version: "0.1.0" });
  }

  private resolveSkillRoot(packDir: string, source: SkillPackSource): string {
    if (source.kind !== "git" || !source.subPath) return packDir;
    const skillRoot = resolve(packDir, source.subPath);
    if (
      !isInside(skillRoot, packDir) ||
      !existsSync(skillRoot) ||
      !statSync(skillRoot).isDirectory()
    ) {
      throw new SkillInstallError(
        "GIT_SKILL_PATH_INVALID",
        `技能目录不存在或非法: ${source.subPath}`,
      );
    }
    return skillRoot;
  }
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/\.md$/i, "")
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "pack"
  );
}
function repoSlugFromUrl(url: string): string {
  const m = url
    .replace(/\.git$/, "")
    .split("/")
    .pop();
  return slugify(m ?? "repo");
}

function normalizeSubPath(value?: string): string | undefined {
  const normalized = value?.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized || undefined;
}

function isInside(child: string, parent: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}
