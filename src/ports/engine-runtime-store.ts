/** 引擎运行时工件资产（specs/2026-10-11-plugin-system-design.md §1.2 收编 10-09 引擎注册表稿）。
 *  plugins 表管引擎启停治理；本表管工件本身（安装/钉版/校验/漂移），两表以 sdkType 关联。 */
export interface EngineRuntimeRecord {
  sdkType: string;
  sourceKind: "bundled" | "discover" | "remote" | "local";
  /** remote=URL / local 与 discover=本机路径（bundled 为空） */
  sourceRef?: string;
  /** 冒烟探针所得版本（如 0.16.9） */
  pinnedVersion?: string;
  /** 受管安装目录主工件（bundled/local 直引外均为 <data>/engines/<sdkType>/<version>/） */
  installedPath?: string;
  /** 主工件 sha256（漂移检测基准；仅 managed=1 有意义） */
  sha256?: string;
  /** local 直引模式 =0（不复制，漂移风险自担） */
  managed: boolean;
  status: "missing" | "installing" | "ready" | "error" | "drifted" | "disabled";
  lastError?: string;
  lastSmokeAt?: string;
  updatedAt: string;
}

export interface EngineRuntimeStore {
  list(): Promise<EngineRuntimeRecord[]>;
  get(sdkType: string): Promise<EngineRuntimeRecord | undefined>;
  upsert(record: EngineRuntimeRecord): Promise<void>;
}
