export interface EnterpriseOperationResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface EnterpriseItemRecord {
  name: string;
  type: string;
  uri: string;
  checkedOutBy?: string;
  command?: unknown;
  filePath?: string;
  guid?: string;
  isFolder?: boolean;
  isSystem?: boolean;
  language?: string;
  scriptLanguage?: string;
}

export interface EnterpriseItemCodeRecord {
  code: string;
  language: string;
  [key: string]: unknown;
}

export interface LocalCopyResult {
  code: string;
  language: string;
  localFilePath: string;
}