import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gitPatFromValues } from "../domain/credential.js";
import { defaultUsernameForHost, normalizeRepositoryIdentity } from "../domain/git.js";
import type { PackSkill, SkillPack, SkillPackSource } from "../domain/skill-pack.js";
import { cleanHttpsRepoUrl } from "../domain/user-skill-repo.js";
import { parseFrontmatter, scanSkillPack } from "../domain/skill-scan.js";
import type {
  InstallGitReq,
  InstallPasteReq,
  InstallUploadReq,
  SkillInstaller,
} from "../ports/skill-installer.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";
import { SkillInstallError } from "../util/errors.js";
import { type GitProcessCredential, type GitProcessResult, runGit, sanitizeGitError } from "../util/git-process.js";

const SLUG_RE = /^[a-z0-9-]+$/;
const GIT_TIMEOUT_MS = 120_000;

export interface LocalSkillInstallerDeps {
  packStore: SkillPackStore;
  getHomeDir: (userId: string) => string;
  /** 私有仓库鉴权：凭证集（kind=git 模板 + 用户值）；缺省=不支持凭证拉取 */
  credentialSets?: CredentialSetStore;
  /** 测试注入 git 执行器；缺省 runGit（AskPass 凭证注入） */
  gitRunner?: typeof runGit;
}

export class LocalSkillInstaller implements SkillInstaller {
  constructor(private readonly deps: LocalSkillInstallerDeps) {}

  async installFromGit(userId: string, req: InstallGitReq): Promise<SkillPack> {
    const url = req.url.trim();
    validateGitSourceUrl(url);
    const credential = await this.resolveCredential(
      userId,
      req.credentialCode?.trim() || undefined,
      url,
    );
    const slug = await this.deriveSlug(userId, req.slug ?? repoSlugFromUrl(url));
    const dir = this.userPackDir(userId, slug);
    try {
      // 参数数组直传 git，不经 shell；token 经临时 AskPass 注入，不进 URL/DB/审计
      const result = await this.git(
        ["clone", "--depth", "1", ...(req.ref ? ["--branch", req.ref] : []), url, dir],
        credential,
      );
      if (result.code !== 0) {
        throw new SkillInstallError("GIT_CLONE_FAILED", gitFailureMessage(result, "拉取"));
      }
      this.ensurePluginManifest(dir, slug);
      const subPath = normalizeSubPath(req.subPath);
      const source: SkillPackSource = {
        kind: "git",
        url,
        ref: req.ref,
        ...(subPath ? { subPath } : {}),
        ...(req.credentialCode?.trim() ? { credentialCode: req.credentialCode.trim() } : {}),
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
    const credential = await this.resolveCredential(
      userId,
      pack.source.credentialCode,
      pack.source.url,
    );
    try {
      const result = await this.git(["-C", dir, "pull", "--ff-only"], credential);
      if (result.code !== 0) {
        throw new SkillInstallError("GIT_PULL_FAILED", gitFailureMessage(result, "更新"));
      }
    } catch (e) {
      if (e instanceof SkillInstallError) throw e;
      throw new SkillInstallError("GIT_PULL_FAILED", `git pull 失败: ${(e as Error).message}`);
    }
    this.ensurePluginManifest(dir, pack.slug);
    const before = new Map(
      (await this.deps.packStore.listSkills(userId, pack.id)).map((s) => [s.name, s]),
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
      pack.id,
    );
  }

  // ---- 技能文档读写（技能工坊升级路径）----

  async readSkillDoc(userId: string, packId: string, skillName: string): Promise<string> {
    const pack = await this.deps.packStore.getPack(userId, packId);
    if (!pack) throw new SkillInstallError("PACK_NOT_FOUND", `pack 不存在: ${packId}`);
    const { docPath } = await this.locateSkillDoc(userId, pack, skillName);
    return readFileSync(docPath, "utf8");
  }

  async updateSkillDoc(
    userId: string,
    packId: string,
    skillName: string,
    content: string,
  ): Promise<SkillPack> {
    const pack = await this.deps.packStore.getPack(userId, packId);
    if (!pack) throw new SkillInstallError("PACK_NOT_FOUND", `pack 不存在: ${packId}`);
    if (pack.builtin) {
      throw new SkillInstallError("BUILTIN_READ_ONLY", `预装技能不可修改: ${pack.slug}`);
    }
    if (pack.source.kind === "git") {
      throw new SkillInstallError(
        "GIT_PACK_READ_ONLY",
        "git 源技能请在上游仓库修改后用「更新」同步，此处不做本地改写",
      );
    }
    const { docPath, skill } = await this.locateSkillDoc(userId, pack, skillName);
    const fm = parseFrontmatter(content);
    if (fm.name && fm.name !== skill.name) {
      throw new SkillInstallError(
        "NAME_MISMATCH",
        `frontmatter name（${fm.name}）与现有技能名（${skill.name}）不一致；改名请先卸载再重建`,
      );
    }
    writeFileSync(docPath, content);
    const before = new Map(
      (await this.deps.packStore.listSkills(userId, packId)).map((s) => [s.name, s]),
    );
    const packDir = this.resolvePackDir(userId, pack);
    return this.persistScanned(
      userId,
      pack.slug,
      packDir,
      pack.source,
      pack.builtin,
      before,
      this.resolveSkillRoot(packDir, pack.source),
      packId,
    );
  }

  /** 归属校验 + 定位技能文档：pack 内 realPath 不得逃出 packDir */
  private async locateSkillDoc(
    userId: string,
    pack: SkillPack,
    skillName: string,
  ): Promise<{ docPath: string; skill: PackSkill }> {
    const skills = await this.deps.packStore.listSkills(userId, pack.id);
    const skill = skills.find((s) => s.name === skillName);
    if (!skill) throw new SkillInstallError("SKILL_NOT_FOUND", `该 pack 中无技能: ${skillName}`);
    const packDir = this.resolvePackDir(userId, pack);
    const skillRoot = this.resolveSkillRoot(packDir, pack.source);
    const docPath = resolve(skillRoot, skill.relativePath);
    if (!isInside(docPath, packDir)) {
      throw new SkillInstallError("SKILL_PATH_INVALID", `技能文档路径非法: ${skill.relativePath}`);
    }
    if (!existsSync(docPath)) {
      throw new SkillInstallError("SKILL_DOC_MISSING", `SKILL.md 不存在: ${skill.relativePath}`);
    }
    return { docPath, skill };
  }

  // ---- 内部 ----

  private git(args: string[], credential?: GitProcessCredential): Promise<GitProcessResult> {
    return (this.deps.gitRunner ?? runGit)(args, credential, GIT_TIMEOUT_MS);
  }

  /**
   * 凭证解析（安装/更新共用）：code 缺省=匿名；要求 kind=git 模板 + 已填 access_token；
   * 模板声明 repoUrl 时按一凭一仓校验与安装地址一致。token 经凭证桥现取，永不落库/回显。
   */
  private async resolveCredential(
    userId: string,
    code: string | undefined,
    url: string,
  ): Promise<GitProcessCredential | undefined> {
    if (!code) return undefined;
    const csets = this.deps.credentialSets;
    if (!csets) {
      throw new SkillInstallError("CREDENTIAL_UNAVAILABLE", "凭证系统未装配，无法按凭证鉴权拉取");
    }
    const template = await csets.getTemplate(code);
    if (!template) {
      throw new SkillInstallError("CREDENTIAL_NOT_FOUND", `凭证模板不存在: ${code}`);
    }
    if (template.kind !== "git") {
      throw new SkillInstallError("CREDENTIAL_KIND_INVALID", "请勾选 kind=git 的 PAT 凭证");
    }
    if (template.repoUrl) {
      const bound = normalizeRepositoryIdentity(template.repoUrl);
      const target = normalizeRepositoryIdentity(url);
      if (bound && target && bound !== target) {
        throw new SkillInstallError(
          "CREDENTIAL_REPO_MISMATCH",
          `凭证 ${code} 绑定的仓库是 ${template.repoUrl}，与安装地址不一致（一凭一仓）`,
        );
      }
    }
    const [filled] = await csets.getFilledValues(userId, [code]);
    const pat = gitPatFromValues(filled?.values);
    if (!pat) {
      throw new SkillInstallError(
        "CREDENTIAL_TOKEN_MISSING",
        `凭证 ${code} 未填写 access_token，请先到「我的凭证」补全后再安装`,
      );
    }
    return { username: pat.user || defaultUsernameForHost(url), accessToken: pat.accessToken };
  }

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
    /** 更新语义传原 packId 保持 id 稳定（skill 引用/启停状态不悬空） */
    keepPackId?: string,
  ): Promise<SkillPack> {
    const scanned = scanSkillPack(packDir, skillRoot);
    if (source.kind === "git" && scanned.skills.length === 0) {
      throw new SkillInstallError("GIT_SKILLS_NOT_FOUND", "Git 仓库中未找到 SKILL.md");
    }
    const now = new Date().toISOString();
    // plugin.json name 与白名单前缀绑定：用户 pack 强制 = slug；预装沿用其 plugin.json name
    const name = builtin ? scanned.packMeta.name : slug;
    const packId = keepPackId ?? crypto.randomUUID();
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

/** git 来源校验：无凭证内嵌的 HTTPS 地址（本地路径保留为离线/测试通道）；杜绝 option 注入与 URL 内嵌 token */
function validateGitSourceUrl(url: string): void {
  if (url.startsWith("-")) {
    throw new SkillInstallError("GIT_URL_INVALID", "git 地址非法");
  }
  if (/^[a-zA-Z]:[\\/]/.test(url) || url.startsWith("/") || url.startsWith("\\\\")) {
    return;
  }
  if (!cleanHttpsRepoUrl(url)) {
    throw new SkillInstallError(
      "GIT_URL_INVALID",
      "git 地址须为无凭证内嵌的 HTTPS 地址；私有仓库请通过勾选凭证注入 token",
    );
  }
}

/** git 失败信息归一：超时单独说、鉴权类失败给「勾选凭证」引导，其余脱敏透出 */
function gitFailureMessage(result: GitProcessResult, action: string): string {
  if (result.timedOut) return `git ${action}超时（>${GIT_TIMEOUT_MS / 1000}s）`;
  const detail = sanitizeGitError(result.stderr || result.stdout || "未知错误");
  if (
    /authentication|authorization|403|401|could not read username|access denied|权限/i.test(detail)
  ) {
    return `git ${action}失败（鉴权未通过）：私有仓库请勾选 git 凭证后重试。${detail}`;
  }
  return `git ${action}失败: ${detail}`;
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
