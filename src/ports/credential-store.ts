export interface CredentialEntry {
  key: string;
  label?: string;
  updatedAt: string;
}

export interface CredentialStore {
  migrate(): void;
  list(userId: string): Promise<CredentialEntry[]>;
  /** 解密返回存在的 key→value；不存在的 key 不出现。 */
  getMany(userId: string, keys: string[]): Promise<Record<string, string>>;
  setValue(userId: string, key: string, value: string, label?: string): Promise<void>;
  deleteValue(userId: string, key: string): Promise<void>;
}
