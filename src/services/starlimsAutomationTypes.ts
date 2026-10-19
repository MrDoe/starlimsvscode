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

export interface CheckedOutItemRecord {
  name: string;
  type: string;
  uri: string;
  checkedOutBy?: string;
  guid?: string;
  language?: string;
}

export interface EnterpriseItemCodeRecord {
  code: string;
  language: string;
  [key: string]: unknown;
}

/**
 * One LIMSSOURCECONTROL history entry of an enterprise item (metadata only,
 * no code snapshot). `done` is the STARLIMS DONE flag: "1" = checked-in
 * version, "0" = the active checkout row, "9" = aborted/other.
 */
export interface EnterpriseHistoryVersionRecord {
  versionId: string;
  done?: string;
  checkedOutBy?: string;
  checkedOutDate?: string;
  checkedInBy?: string;
  checkedInDate?: string;
  reason?: string;
  /** Form language of the version row (LANGID), empty for non-form items. */
  language?: string;
  /** "MAJOR.MINOR.BUILD" from LIMSVERSIONS, empty when no version row exists. */
  versionText?: string;
}

/** Code snapshot of a single enterprise item version (GetHistoryCode). */
export interface EnterpriseHistoryCodeRecord {
  uri?: string;
  versionId: string;
  code: string;
  language?: string;
}

export interface LocalCopyResult {
  code: string;
  language: string;
  localFilePath: string;
}

/**
 * An SDP package with the checked out items of a STARLIMS server.
 */
export interface ExportedCheckoutPackage {
  fileName: string;
  content: Buffer;
  /**
   * Names of the items that were put into the package. Undefined when the
   * backend API of the server is too old to report them.
   */
  itemNames?: string[];
  /**
   * Checkout users of the items in the package, in the same order as itemNames.
   */
  itemUsers?: string[];
}