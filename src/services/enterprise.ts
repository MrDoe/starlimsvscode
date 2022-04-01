/**
 * Defines the interface for STARLIMS enterprise services.
 */
export interface Enterprise {
  getEnterpriseItem(uri: string): any;
  getEntepriseItemCode(uri: string): any;
  getLocalCopy(uri: string, workspaceFolder: string): Promise<string | null>;
}
