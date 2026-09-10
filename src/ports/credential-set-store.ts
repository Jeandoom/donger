// 凭证集端口：全局模板（结构元数据，code 全局唯一，管理权归创建人）+ 用户值（按用户隔离，整体加密）。
// 值永不回显：查询接口只返回结构与键名；解密仅在注入/内部链路（getFilledValues）。

import type {
  CredentialTemplate,
  CredentialTemplateInput,
  CredentialValueEntry,
} from "../domain/credential.js";

export interface CredentialTemplateQuery {
  /** code/name/description 模糊匹配（LIKE %q%，不区分大小写由实现决定） */
  q?: string;
}

export interface CredentialSetStore {
  migrate(): void;

  // ---- 模板（全局） ----
  /** 模糊查询模板（q 空则全部），按 updatedAt 倒序 */
  listTemplates(query: CredentialTemplateQuery): Promise<CredentialTemplate[]>;
  getTemplate(code: string): Promise<CredentialTemplate | undefined>;
  /** code 已存在 → 409 由调用方先 getTemplate 判定；此处仅创建 */
  createTemplate(code: string, input: CredentialTemplateInput, createdBy: string): Promise<void>;
  /** 仅创建人可调（授权在服务层）；更新 name/description/keySpecs */
  updateTemplate(code: string, input: CredentialTemplateInput): Promise<void>;
  /** 返回引用该模板的用户值数量；>0 时调用方应拒绝删除 */
  countTemplateReferences(code: string): Promise<number>;
  deleteTemplate(code: string): Promise<void>;

  // ---- 用户值 ----
  listValueCodes(userId: string): Promise<string[]>;
  /** 解密取回；缺失的 code 不出现在结果中 */
  getFilledValues(userId: string, codes: string[]): Promise<CredentialValueEntry[]>;
  /** 创建/整体覆写 values；name 缺省时保留既有别名（COALESCE 语义） */
  upsertValue(
    userId: string,
    code: string,
    values: Record<string, string>,
    name?: string,
  ): Promise<void>;
  /** 仅改本人显示名（别名）；凭证项不存在返回 false */
  renameValue(userId: string, code: string, name: string): Promise<boolean>;
  deleteValue(userId: string, code: string): Promise<void>;
  /** 某模板下已填值的用户数（模板删除保护提示用） */
  countUsersByTemplate(code: string): Promise<number>;
}
